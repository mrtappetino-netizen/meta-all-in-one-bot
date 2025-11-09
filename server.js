// server.js — Bot Messenger + Instagram + WhatsApp con ChatGPT (OpenAI)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import crypto from 'crypto';
import OpenAI from 'openai';

const app = express();

// --- Healthcheck & logging ---------------------------------------------------
app.get('/', (_req, res) => res.status(200).send('OK'));
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

// salva il raw body per la firma HMAC
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// --- ENV ---------------------------------------------------------------------
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;         // es. "metaverify_123"
const APP_SECRET         = process.env.APP_SECRET;           // App Secret della tua app Meta
const VERIFY_SIGNATURE   = (process.env.VERIFY_SIGNATURE || 'true').toLowerCase() === 'true';

const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;    // Messenger/Instagram
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;       // WhatsApp Cloud API
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;      // WhatsApp Cloud API

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;       // chiave OpenAI
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// --- OpenAI (ChatGPT) --------------------------------------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function aiReply(text, channel = 'generic') {
  try {
    if (!text) return 'Puoi ripetere?';
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: `Sei un assistente utile, chiaro e conciso. Rispondi sempre in italiano. Canale: ${channel}.` },
        { role: 'user', content: text }
      ],
      temperature: 0.5,
      max_tokens: 300
    });
    return r.choices?.[0]?.message?.content?.trim() || 'Non ho capito, puoi riformulare?';
  } catch (e) {
    console.error('OpenAI error:', e?.response?.data || e.message);
    return 'In questo momento non riesco a rispondere. Riprova tra poco 🙏';
  }
}

// --- Utils -------------------------------------------------------------------
function verifySignature(req) {
  if (!VERIFY_SIGNATURE) return true;                  // toggle via ENV per debug
  const sig = req.get('x-hub-signature-256') || '';
  if (!APP_SECRET || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function sendMessengerIg(recipientId, text) {
  await axios.post(
    'https://graph.facebook.com/v20.0/me/messages',
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
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

// --- Rotta di debug per confrontare il VERIFY_TOKEN --------------------------
app.get('/debug-verify', (req, res) => {
  const vt = VERIFY_TOKEN || '';
  const got = req.query?.['hub.verify_token'] || '';
  res.status(200).json({
    got_from_url: got,
    expected_len: vt.length,
    expected_preview: vt ? vt[0] + '...' + vt[vt.length - 1] : '(vuoto)'
  });
});

// --- Messenger + Instagram (stessa callback) ---------------------------------
// GET: verifica iniziale del webhook
app.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});

// POST: eventi runtime
app.post('/webhook', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);

    for (const entry of req.body.entry || []) {
      // --- Messenger: entry.messaging[] --------------------------------------
      if (Array.isArray(entry.messaging)) {
        for (const ev of entry.messaging) {
          const psid = ev.sender?.id;
          const text = ev.message?.text;
          if (psid && typeof text === 'string') {
            const reply = await aiReply(text, 'messenger');
            await sendMessengerIg(psid, reply);
          }
        }
      }

      // --- Instagram: entry.changes[].value.messages[] -----------------------
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const igsid = m.from;
            const text = m.text?.body;
            if (igsid && typeof text === 'string') {
              const reply = await aiReply(text, 'instagram');
              await sendMessengerIg(igsid, reply);
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Errore /webhook:', e?.response?.data || e.message);
    res.sendStatus(500);
  }
});

// --- WhatsApp ----------------------------------------------------------------
// GET: verifica iniziale
app.get('/whatsapp', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});

// POST: eventi runtime
app.post('/whatsapp', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);

    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const from = m.from;                   // numero E.164 (es. 39333xxxxxxx)
            const text = m.text?.body || '';
            if (from && typeof text === 'string') {
              const reply = await aiReply(text, 'whatsapp');
              await sendWhatsapp(from, reply);
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Errore /whatsapp:', e?.response?.data || e.message);
    res.sendStatus(500);
  }
});

// --- Avvio -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// Test rapido AI dal browser
app.get('/ai-test', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).send('OPENAI_API_KEY mancante');
    const prompt = req.query.q || 'Di che colore è il cielo?';
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'Rispondi in italiano, in modo breve.' },
        { role: 'user', content: String(prompt) }
      ],
      temperature: 0.5,
      max_tokens: 60
    });
    res.status(200).send(r.choices?.[0]?.message?.content ?? '(vuoto)');
  } catch (e) {
    console.error('AI TEST error:', e?.response?.data || e.message);
    res.status(500).send('AI TEST error: ' + (e?.response?.data?.error?.message || e.message));
  }
});
});
app.listen(PORT, '0.0.0.0', () => console.log(`Server online :${PORT}`));
