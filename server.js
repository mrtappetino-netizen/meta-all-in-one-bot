import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import axios from 'axios';

const app = express();

// Healthcheck
app.get('/', (_req, res) => res.status(200).send('OK'));

// Salva il raw body per la verifica firma
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ====== ENV ======
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;          // lo decidi tu
const APP_SECRET       = process.env.APP_SECRET;            // App Secret Meta
const PAGE_ACCESS_TOKEN= process.env.PAGE_ACCESS_TOKEN;     // Messenger/Instagram
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;        // WhatsApp Cloud API
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;       // WhatsApp Cloud API

// ====== UTIL ======
function verifySignature(req) {
  const signature = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  return signature.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function sendMessengerIg(recipientId, text) {
  // valido per Messenger (PSID) e Instagram (IGSID)
  await axios.post(
    'https://graph.facebook.com/v20.0/me/messages',
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

async function sendWhatsapp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      text: { body: text }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ====== WEBHOOK META (Messenger + Instagram) ======
// Verifica iniziale
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Eventi
app.post('/webhook', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);

    for (const entry of req.body.entry || []) {
      // Messenger: entry.messaging[]
      if (Array.isArray(entry.messaging)) {
        for (const ev of entry.messaging) {
          const psid = ev.sender?.id;
          const text = ev.message?.text;
          if (psid && text) await sendMessengerIg(psid, `Messenger: ${text}`);
        }
      }
      // Instagram: entry.changes[].value.messages[]
      for (const change of entry.changes || []) {
        const messages = change?.value?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            const igsid = msg.from;
            const text = msg.text?.body;
            if (igsid && text) await sendMessengerIg(igsid, `Instagram: ${text}`);
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(500);
  }
});

// ====== WEBHOOK WHATSAPP ======
// Verifica iniziale
app.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Eventi
app.post('/whatsapp', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(403);

    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const from = m.from;                    // es. "39333xxxxxxx"
            const text = m.text?.body || '';
            if (from && text) await sendWhatsapp(from, `WhatsApp: ${text}`);
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on :${PORT}`));
