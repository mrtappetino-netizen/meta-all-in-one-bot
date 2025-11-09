// server.js — Messenger + Instagram + WhatsApp + ChatGPT (robusto)
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
const APP_SECRET         = process.env.APP_SECRET;            // Settings → Basic → App secret
const VERIFY_SIGNATURE   = (process.env.VERIFY_SIGNATURE || 'true').toLowerCase() === 'true';

const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;     // Messenger/Instagram
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;        // WhatsApp Cloud
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;       // WhatsApp Cloud

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;        // sk-...
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ------- OpenAI client + AI robusta -------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Mini cache 15s per testi identici
const aiCache = new Map(); // key: text norm -> { reply, ts }
const getCachedReply = (text) => {
  const k = (text || '').trim().toLowerCase();
  const hit = aiCache.get(k);
  if (hit && (Date.now() - hit.ts) < 15_000) return hit.reply;
  return null;
};
const setCachedReply = (text, reply) => {
  const k = (text || '').trim().toLowerCase();
  aiCache.set(k, { reply, ts: Date.now() });
};

// Rate limit per utente/canale: 1 chiamata AI ogni 10s
const lastAiCall = new Map(); // key: `${channel}:${userId}` -> ts
function canCallAI(channel, userId) {
  const key = `${channel}:${userId}`;
  const now = Date.now();
  const last = lastAiCall.get(key) || 0;
  if (now - last < 10_000) return false;
  lastAiCall.set(key, now);
  return true;
}

// Funzione AI con retry/backoff/timeout e rispetto di Retry-After
async function aiReply(text, channel = 'generic') {
  if (!text) return 'Puoi ripetere?';
  if (!OPENAI_API_KEY) return 'AI non configurata (manca OPENAI_API_KEY).';

  // Filtro "rumore"
  const noise = ['ok','okay','👍','👋','ciao','hey','yo','grazie','thx'];
  if (noise.includes(text.trim().toLowerCase())) return 'Eccomi! Dimmi pure 🙂';

  const cached = getCachedReply(text);
  if (cached) return cached;

  const TIMEOUT_MS = 15000;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
     const r = await openai.chat.completions.create(
  {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: `Sei un assistente utile e conciso. Rispondi SEMPRE in italiano. Canale: ${channel}.` },
      { role: 'user', content: text }
    ],
    temperature: 0.4,
    max_tokens: 220
  },
  {
    signal: controller.signal         // ✅ va nel 2° argomento (options)
  }
);
      clearTimeout(timer);
      const out = r.choices?.[0]?.message?.content?.trim();
      const finalText = out || 'Non ho capito, puoi riformulare?';
      setCachedReply(text, finalText);
      return finalText;

    } catch (e) {
      clearTimeout(timer);
      const status = e?.status || e?.response?.status;
      const data = e?.response?.data || e?.data;
      const code = data?.error?.code;
      const msg = e?.message || data?.error?.message;
      const headers = e?.response?.headers || {};
      const retryAfter = Number(headers['retry-after']) || 0;

      console.error('OpenAI failure', { attempt, status, code, msg, retryAfter });

      if (status === 429) {
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * attempt + Math.floor(Math.random() * 300);
        if (attempt < MAX_ATTEMPTS) { await sleep(waitMs); continue; }
        return 'Sto ricevendo molte richieste. Riprova tra qualche secondo 🙏';
      }
      if ((status >= 500 && status < 600) || String(msg).includes('aborted')) {
        if (attempt < MAX_ATTEMPTS) { await sleep(500 * attempt + Math.floor(Math.random() * 300)); continue; }
        return 'Ho un momentaneo problema di connessione, riprova tra poco 🙏';
      }
      if (status >= 400 && status < 500) {
        return 'AI non disponibile (configurazione). Riprova più tardi 🙏';
      }
      if (attempt === MAX_ATTEMPTS) {
        return `In questo momento non riesco a usare l’AI. Intanto ho letto: "${text}"`;
      }
    }
  }
}

// ------- Utils -------
function verifySignature(req) {
  if (!VERIFY_SIGNATURE) return true; // toggle per debug
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
            if (!canCallAI('messenger', psid)) {
              await sendMessengerIg(psid, 'Un attimo… sto rispondendo a un tuo messaggio precedente ⏳');
              continue;
            }
            console.log('AI start (Messenger):', { from: psid, text });
            let reply = getCachedReply(text);
            if (!reply) { reply = await aiReply(text, 'messenger'); setCachedReply(text, reply); }
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
              if (!canCallAI('instagram', igsid)) {
                await sendMessengerIg(igsid, 'Un attimo… sto rispondendo a un tuo messaggio precedente ⏳');
                continue;
              }
              console.log('AI start (Instagram):', { from: igsid, text: itext });
              let ireply = getCachedReply(itext);
              if (!ireply) { ireply = await aiReply(itext, 'instagram'); setCachedReply(itext, ireply); }
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
              if (!canCallAI('whatsapp', to)) {
                await sendWhatsapp(to, 'Un attimo… sto rispondendo a un tuo messaggio precedente ⏳');
                continue;
              }
              console.log('AI start (WhatsApp):', { to, text: wtext });
              let wreply = getCachedReply(wtext);
              if (!wreply) { wreply = await aiReply(wtext, 'whatsapp'); setCachedReply(wtext, wreply); }
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
