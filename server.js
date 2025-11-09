// server.js — Messenger + Instagram + WhatsApp + ChatGPT (con HMAC)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import crypto from 'crypto';
import OpenAI from 'openai';

const app = express();

// Healthcheck + log richieste
app.get('/', (_req, res) => res.status(200).send('OK'));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Salva il raw body per la verifica firma HMAC
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ===== ENV =====
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;          // es. metaverify_123
const APP_SECRET         = process.env.APP_SECRET;            // App Secret della tua app Meta

const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;     // Messenger/Instagram
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;        // WhatsApp Cloud API
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;       // WhatsApp Cloud API

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;        // sk-...
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
async function aiReply(text, channel = 'generic') {
  try {
    if (!text) return 'Puoi ripetere?';
    if (!OPENAI_API_KEY) return 'AI non configurata: contatta l’amministratore.';

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
    return `In questo momento non riesco a usare l’AI. Intanto ho letto: "${text}"`;
  }
}

// ===== Utils =====
function verifySignature(req) {
  const signature = req.get('x-hub-signature-256') || '';
  if (!APP_SECRET || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return signature.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// invio DM su Messenger/Instagram (stessa Send API)
async function sendMessengerIg(recipientId, text) {
  await axios.post(
    'https://graph.facebook.com/v20.0/me/messages',
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

// invio messaggio su WhatsApp Cloud
async function sendWhatsapp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// Rotta di debug (facoltativa): confronta il verify token
app.get('/debug-verify', (req, res) => {
  const vt = VERIFY_TOKEN || '';
  const got = req.query?.['hub.verify_token'] || '';
  res.status(200).json({
    got_from_url: got,
    expected_len: vt.length,
    expected_preview: vt ? vt[0] + '...' + vt[vt.length - 1] : '(vuoto)'
  });
});

// ===== Messenger + Instagram (stesso webhook) =====

// GET verifica iniziale
app.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});

// POST eventi runtime
app.post('/webhook', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);

    for (const entry of req.body.entry || []) {
      // --- Messenger: entry.messaging[] ---
      if (Array.isArray(entry.messaging)) {
        for (const ev of entry.messaging) {
          console.log('EVENT (Messenger):', JSON.stringify(ev));
          const psid = ev.sender?.id;
          const text = ev.message?.text;
          if (psid && typeof text === 'string') {
            console.log('AI start (Messenger):', { from: psid, text });
            const reply = await aiReply(text, 'messenger');
            console.log('AI done (Messenger):', reply?.slice(0, 160));
            await sendMessengerIg(psid, reply);
            console.log('SEND ok (Messenger) →', psid);
          }
        }
      }

      // --- Instagram: entry.changes[].value.messages[] ---
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            console.log('EVENT (Instagram):', JSON.stringify(m));
            const igsid = m.from;
            const text = m.text?.body;
            if (igsid && typeof text === 'string') {
              console.log('AI start (Instagram):', { from: igsid, text });
              const reply = await aiReply(text, 'instagram');
              console.log('AI done (Instagram):', reply?.slice(0, 160));
              await sendMessengerIg(igsid, reply);
              console.log('SEND ok (Instagram) →', igsid);
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

// ===== WhatsApp =====

// GET verifica iniziale
app.get('/whatsapp', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});

// POST eventi runtime
app.post('/whatsapp', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);

    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            console.log('EVENT (WhatsApp):', JSON.stringify(m));
            const to = m.from;                         // numero E.164 (es. 39333xxxxxxx)
            const text = m.text?.body || '';
            if (to && text) {
              console.log('AI start (WhatsApp):', { to, text });
              const reply = await aiReply(text, 'whatsapp');
              console.log('AI done (WhatsApp):', reply?.slice(0, 160));
              await sendWhatsapp(to, reply);
              console.log('SEND ok (WhatsApp) →', to);
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

// Avvio server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server online :${PORT}`));
