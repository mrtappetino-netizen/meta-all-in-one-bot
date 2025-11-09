// server.js — Messenger + ChatGPT (minimo e funzionante)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import OpenAI from 'openai';

const app = express();
app.use(bodyParser.json());

// Healthcheck + log
app.get('/', (_req, res) => res.status(200).send('OK'));
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

// ENV minime
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;           // es. metaverify_123
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN;      // token della Pagina FB
const OPENAI_KEY   = process.env.OPENAI_API_KEY;         // sk-...

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function aiReply(text) {
  if (!text) return 'Puoi ripetere?';
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Sei un assistente utile, chiaro e in italiano. Rispondi in 1-2 frasi.' },
        { role: 'user', content: text }
      ],
      temperature: 0.5, max_tokens: 300
    });
    return r.choices?.[0]?.message?.content?.trim() || 'Non ho capito, puoi riformulare?';
  } catch (e) {
    console.error('OpenAI error:', e?.response?.data || e.message);
    return 'Al momento non riesco a usare l’AI, riprova tra poco 🙏';
  }
}

// Verifica webhook (GET) — deve restituire il challenge
app.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: ch } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(ch);
  return res.sendStatus(403);
});

// Eventi Messenger (POST) — prende testo, chiede all’AI, invia risposta
app.post('/webhook', async (req, res) => {
  try {
    console.log('BODY:', JSON.stringify(req.body)); // utile per debug
    for (const entry of req.body.entry || []) {
      const events = entry.messaging || [];
      for (const ev of events) {
        const psid = ev.sender?.id;
        const text = ev.message?.text;
        if (psid && typeof text === 'string') {
          console.log('AI start:', { from: psid, text });
          const reply = await aiReply(text);
          console.log('AI done:', reply?.slice(0, 120));

          await axios.post(
            'https://graph.facebook.com/v20.0/me/messages',
            { recipient: { id: psid }, message: { text: reply }, messaging_type: 'RESPONSE' },
            { headers: { Authorization: `Bearer ${PAGE_TOKEN}` } }
          );

          console.log('SEND ok →', psid);
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Errore /webhook:', e?.response?.data || e.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server online :${PORT}`));
