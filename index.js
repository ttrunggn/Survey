const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────
const CRISP_ID  = process.env.CRISP_ID;   // Website ID from Crisp
const CRISP_KEY = process.env.CRISP_KEY;  // Access Token from Crisp
const DELAY_MS  = parseInt(process.env.DELAY_MS || '3000');
const PORT      = process.env.PORT || 3000;
// ──────────────────────────────────────────────────────────────

// Prevent sending survey twice for the same session
const surveySent = new Set();

// Track sessions awaiting a comment after rating
// { session_id → { score, website_id } }
const awaitingComment = new Map();

// Helper: call Crisp API
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

  // Respond 200 immediately so Crisp does not retry
  res.sendStatus(200);

  // ── STEP 1: Chat resolved → send picker rating after delay ──
  if (event === 'session:set_state' && data.state === 'resolved') {
    const { session_id, website_id } = data;

    if (surveySent.has(session_id)) return;
    surveySent.add(session_id);
    setTimeout(() => surveySent.delete(session_id), 3600_000); // clear after 1h

    console.log(`[RESOLVED] ${session_id} — sending survey in ${DELAY_MS}ms`);

    setTimeout(async () => {
      try {
        await crispSend(website_id, session_id, {
          type: 'picker',
          from: 'operator',
          origin: 'chat',
          content: {
            id: `rating_${session_id}`,
            text: '👋 Thanks for reaching out!\n\nHow satisfied were you with our support today?',
            choices: [
              { value: '5', label: '⭐⭐⭐⭐⭐  Very satisfied',    selected: false },
              { value: '4', label: '⭐⭐⭐⭐    Satisfied',          selected: false },
              { value: '3', label: '⭐⭐⭐       Neutral',            selected: false },
              { value: '2', label: '⭐⭐          Unsatisfied',       selected: false },
              { value: '1', label: '⭐             Very unsatisfied',  selected: false },
            ],
          },
        });
        console.log(`[OK] Picker sent → ${session_id}`);
      } catch (err) {
        console.error(`[ERR] Picker failed → ${session_id}:`, err.response?.data || err.message);
      }
    }, DELAY_MS);
  }

  // ── STEP 2: User clicks a star → thank + ask for comment ────
  if (event === 'message:send' && data.type === 'picker' && data.from === 'user') {
    const { session_id, website_id, content } = data;

    const chosen = content?.choices?.find(c => c.selected);
    if (!chosen) return;

    const score = parseInt(chosen.value);
    awaitingComment.set(session_id, { score, website_id });
    setTimeout(() => awaitingComment.delete(session_id), 600_000); // clear after 10min

    console.log(`[SCORE] ${session_id} → ${score} stars`);

    const emoji = ['', '😞', '😕', '😐', '😊', '🤩'][score];
    try {
      await crispSend(website_id, session_id, {
        type: 'text',
        from: 'operator',
        origin: 'chat',
        content: `Thank you for rating us ${'⭐'.repeat(score)} ${emoji}\n\nWould you like to leave any additional feedback? (Feel free to type or skip)`,
      });
    } catch (err) {
      console.error(`[ERR] Follow-up failed:`, err.response?.data || err.message);
    }
  }

  // ── STEP 3: User types comment → save + close ───────────────
  if (event === 'message:send' && data.type === 'text' && data.from === 'user') {
    const { session_id, website_id, content } = data;

    if (!awaitingComment.has(session_id)) return;

    const { score } = awaitingComment.get(session_id);
    awaitingComment.delete(session_id);

    // TODO: save to DB here
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
        content: 'Thank you so much! Your feedback helps us serve you better 💙',
      });
    } catch (err) {
      console.error(`[ERR] Thank-you failed:`, err.response?.data || err.message);
    }
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`✅ Survey webhook running at http://localhost:${PORT}`);
  console.log(`   CRISP_ID  : ${CRISP_ID  ? '✓ set' : '✗ NOT SET'}`);
  console.log(`   CRISP_KEY : ${CRISP_KEY ? '✓ set' : '✗ NOT SET'}`);
});
