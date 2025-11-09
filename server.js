// server.js — Messenger + Instagram + WhatsApp + ChatGPT
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import crypto from 'crypto';
import OpenAI from 'openai';

const app = express();

// ------- Healthcheck & logging -------
app.get('/', (_req, res) => res.status(200).send('OK'));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Salva raw body per HMAC
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ------- ENV -------
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;          // es. metaverify_123
const APP_SECRET         = process.env.APP_SECRET;            // Impostazioni -> Base -> App secret
const VERIFY_SIGNATURE   = (process.env.VERIFY_SIGNATURE || 'true').toLowerCase() === 'true';

const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;     // Messenger/Instagram
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;        // WhatsApp Cloud
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;       // WhatsApp Cloud

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;        // sk-...
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ------- OpenAI client + AI robusta -------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function aiReply(text, channel = 'generic') {
  if (!text) return 'Puoi ripetere?';
  if (!OPENAI_API_KEY) return 'AI non configurata (manca OPENAI_API_KEY).';

  const TIMEOUT_MS = 15000;        // 15s
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const r = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: `Sei un assistente utile e conciso. Rispondi SEMPRE in italiano. Canale: ${channel}.` },
          { role: 'user', content: text }
        ],
        temperature: 0.4,
        max_tokens: 220,
        signal: controller.signal
      });
      clearTimeout(to);
      const out = r.choices?.[0]?.message?.content?.trim();
      if (out) return out;

      if (attempt < MAX_ATTEMPTS) {
        await sleep(300 * attempt);
        continue;
      }
      return 'Non ho capito, puoi riformulare?';

    } catch (e) {
      clearTimeout(to);
      const status = e?.status || e?.response?.status;
      const data = e?.response?.data || e?.data;
      const code = data?.error?.code;
      const msg = e?.message || data?.error?.message;
      const reqId = e?.response?.headers?.['x-request-id'];

      console.error('OpenAI failure', { attempt, status, code, msg, reqId });

      // rate limit / quota
      if (status === 429 || code === 'rate_limit_exceeded') {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt + Math.floor(Math.random() * 300));
          continue;
        }
        return 'Sto ricevendo molte richieste. Riprova tra poco 🙏';
      }
      // 5xx o timeout/abort
      if ((status >= 500 && status < 600) || (msg && msg.includes('aborted'))) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt + Math.floor(Math.random() * 300));
          continue;
        }
        return 'Ho un momentaneo problema di connessione, riprova tra poco 🙏';
      }
      // 4xx non recuperabili
      if (status >= 400 && status < 500) {
        return 'AI non disponibile (configurazione). Riprova più tardi 🙏';
      }
      // fallback generico
      if (attempt === MAX_ATTEMPTS) {
        return `In questo momento non riesco a usare l’AI. Intanto ho letto: "${text}"`;
      }
    }
  }
}

// ------- Utils -------
function verifySignature(req) {
  if (!VERIFY_SIGNATURE) return true;       // toggle per debug
  const signature = req.get('x-hub-signature-256') || '';
  if (!APP_SECRET || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return signature.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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

// ------- Rotte di debug -------
app.get('/debug-verify', (req, res) => {
  const vt = VERIFY_TOKEN || '';
  const got = req.query?.['hub.verify_token'] || '';
  res.status(200).json({
    got_from_url: got,
    expected_len: vt.length,
    expected_preview: vt ? vt[0] + '...' + vt[vt.length - 1] : '(vuoto)'
  });
});

app.get('/ai-test', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).send('OPENAI_API_KEY mancante');
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

app.get('/ai-health', async (_req, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5
    });
    res.status(200).json({ ok: true, id: r.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ===== Messenger + Instagram (stessa callback) =====

// GET verifica iniziale (Page & Instagram)
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
            const itext = m.text?.body;
            if (igsid && typeof itext === 'string') {
              console.log('AI start (Instagram):', { from: igsid, text: itext });
              const ireply = await aiReply(itext, 'instagram');
              console.log('AI done (Instagram):', ireply?.slice(0, 160));
              await sendMessengerIg(igsid, ireply);
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
            const wtext = m.text?.body || '';
            if (to && wtext) {
              console.log('AI start (WhatsApp):', { to, text: wtext });
              const wreply = await aiReply(wtext, 'whatsapp');
              console.log('AI done (WhatsApp):', wreply?.slice(0, 160));
              await sendWhatsapp(to, wreply);
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

// ------- Avvio -------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server online :${PORT}`));
