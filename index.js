const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────
const CRISP_ID  = process.env.CRISP_ID;   // Website ID từ Crisp
const CRISP_KEY = process.env.CRISP_KEY;  // Access Token từ Crisp
const DELAY_MS  = parseInt(process.env.DELAY_MS || '3000');
const PORT      = process.env.PORT || 3000;
// ──────────────────────────────────────────────────────────────

// Tránh gửi survey 2 lần cho cùng 1 session
const surveySent = new Set();

// Theo dõi session đang chờ comment sau khi chọn sao
// { session_id → { score, website_id } }
const awaitingComment = new Map();

// Helper: gọi Crisp API
async function crispSend(website_id, session_id, body) {
  return axios.post(
    `https://api.crisp.chat/v1/website/${website_id}/conversation/${session_id}/message`,
    body,
    { auth: { username: CRISP_ID, password: CRISP_KEY } }
  );
}

// ─── Webhook handler ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { event, data } = req.body;

  // Trả về 200 ngay để Crisp không retry
  res.sendStatus(200);

  // ── BƯỚC 1: Chat đóng (resolved) → gửi picker rating ────────
  // Crisp dùng session:set_state với state="resolved" khi agent close chat
  if (event === 'session:set_state' && data.state === 'resolved') {
    const { session_id, website_id } = data;

    if (surveySent.has(session_id)) return;
    surveySent.add(session_id);
    setTimeout(() => surveySent.delete(session_id), 3600_000);

    console.log(`[RESOLVED] ${session_id} — gửi survey sau ${DELAY_MS}ms`);

    setTimeout(async () => {
      try {
        await crispSend(website_id, session_id, {
          type: 'picker',
          from: 'operator',
          origin: 'chat',
          content: {
            id: `rating_${session_id}`,
            text: '👋 Cảm ơn bạn đã liên hệ!\n\nBạn có hài lòng với cuộc hỗ trợ này không?',
            choices: [
              { value: '5', label: '⭐⭐⭐⭐⭐  Rất hài lòng',        selected: false },
              { value: '4', label: '⭐⭐⭐⭐    Hài lòng',             selected: false },
              { value: '3', label: '⭐⭐⭐       Bình thường',          selected: false },
              { value: '2', label: '⭐⭐          Không hài lòng',      selected: false },
              { value: '1', label: '⭐             Rất không hài lòng', selected: false },
            ],
          },
        });
        console.log(`[OK] Picker gửi thành công → ${session_id}`);
      } catch (err) {
        console.error(`[ERR] Gửi picker thất bại → ${session_id}:`, err.response?.data || err.message);
      }
    }, DELAY_MS);
  }

  // ── BƯỚC 2: Khách click chọn sao (message:send from user) ───
  // Crisp dùng message:send khi visitor gửi message (kể cả click picker)
  if (event === 'message:send' && data.type === 'picker' && data.from === 'user') {
    const { session_id, website_id, content } = data;

    const chosen = content?.choices?.find(c => c.selected);
    if (!chosen) return;

    const score = parseInt(chosen.value);
    awaitingComment.set(session_id, { score, website_id });
    setTimeout(() => awaitingComment.delete(session_id), 600_000);

    console.log(`[SCORE] ${session_id} → ${score} sao`);

    const emoji = ['', '😞', '😕', '😐', '😊', '🤩'][score];
    try {
      await crispSend(website_id, session_id, {
        type: 'text',
        from: 'operator',
        origin: 'chat',
        content: `Cảm ơn bạn đã đánh giá ${'⭐'.repeat(score)} ${emoji}\n\nBạn có muốn để lại góp ý để chúng tôi cải thiện thêm không? (Gõ phản hồi hoặc bỏ qua cũng được nhé)`,
      });
    } catch (err) {
      console.error(`[ERR] Gửi follow-up thất bại:`, err.response?.data || err.message);
    }
  }

  // ── BƯỚC 3: Khách gõ comment (message:send text from user) ──
  if (event === 'message:send' && data.type === 'text' && data.from === 'user') {
    const { session_id, website_id, content } = data;

    if (!awaitingComment.has(session_id)) return;

    const { score } = awaitingComment.get(session_id);
    awaitingComment.delete(session_id);

    const result = {
      session_id,
      score,
      comment: content,
      timestamp: new Date().toISOString(),
    };
    console.log('[SAVED]', JSON.stringify(result));

    try {
      await crispSend(website_id, session_id, {
        type: 'text',
        from: 'operator',
        origin: 'chat',
        content: 'Cảm ơn bạn rất nhiều! Phản hồi của bạn giúp chúng tôi phục vụ tốt hơn 💙',
      });
    } catch (err) {
      console.error(`[ERR] Gửi thank-you thất bại:`, err.response?.data || err.message);
    }
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`✅ Survey webhook chạy tại http://localhost:${PORT}`);
  console.log(`   CRISP_ID  : ${CRISP_ID  ? '✓ set' : '✗ CHƯA SET'}`);
  console.log(`   CRISP_KEY : ${CRISP_KEY ? '✓ set' : '✗ CHƯA SET'}`);
});
