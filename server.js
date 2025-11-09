import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import axios from 'axios';
import OpenAI from 'openai';

const app = express();
app.get('/', (_req, res) => res.status(200).send('OK')); // healthcheck Render

app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ===== ENV =====
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;        // es. "metaverify_123"
const APP_SECRET        = process.env.APP_SECRET;          // App Secret Meta
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;   // Messenger/Instagram
const WHATSAPP_TOKEN    = process.env.WHATSAPP_TOKEN;      // WhatsApp Cloud API
const PHONE_NUMBER_ID   = process.env.PHONE_NUMBER_ID;     // WhatsApp Cloud API
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;      // chiave OpenAI
const AI_MODEL          = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
async function aiReply(text, channel) {
  if (!text) return 'Puoi ripetere?';
  try {
    const r = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: `Sei un assistente utile, breve e in italiano. Canale: ${channel}.` },
        { role: 'user', content: text }
      ],
      temperature: 0.5, max_tokens: 300
    });
    return r.choices?.[0]?.message?.content?.trim() || 'Non ho capito, puoi ripetere?';
  } catch (e) {
    console.error('OpenAI error:', e?.response?.data || e.message);
    return 'Ops, ora non riesco a rispondere. Riprova tra poco 🙏';
  }
}

// ===== util =====
function verifySignature(req) {
  const sig = req.get('x-hub-signature-256') || '';
  const exp = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
}
async function sendMessengerIg(id, text) {
  await axios.post(
    'https://graph.facebook.com/v20.0/me/messages',
    { recipient: { id }, message: { text }, messaging_type: 'RESPONSE' },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}
async function sendWhatsapp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ===== Messenger + Instagram =====
// GET verifica
app.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});
// POST eventi
app.post('/webhook', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);
    for (const entry of req.body.entry || []) {
      // Messenger
      if (Array.isArray(entry.messaging)) {
        for (const ev of entry.messaging) {
          const psid = ev.sender?.id;
          const text = ev.message?.text;
          if (psid && text) {
            const reply = await aiReply(text, 'messenger');
            await sendMessengerIg(psid, reply);
          }
        }
      }
      // Instagram
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const igsid = m.from;
            const text = m.text?.body;
            if (igsid && text) {
              const reply = await aiReply(text, 'instagram');
              await sendMessengerIg(igsid, reply);
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ===== WhatsApp =====
// GET verifica
app.get('/whatsapp', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});
// POST eventi
app.post('/whatsapp', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const from = m.from;            // es. 39333xxxxxxx
            const text = m.text?.body || '';
            if (from && text) {
              const reply = await aiReply(text, 'whatsapp');
              await sendWhatsapp(from, reply);
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on :${PORT}`));
