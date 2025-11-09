// server.js — versione minima, NIENTE firma, NIENTE AI
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';

const app = express();
app.use(bodyParser.json());

// healthcheck per Render
app.get('/', (_req, res) => res.status(200).send('OK'));

// === ENV ===
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;        // es. "metaverify_123"
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN;   // token Pagina FB

// 1) Verifica webhook (Messenger/Instagram)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Ricevi messaggi Messenger e rispondi "Ciao 👋"
app.post('/webhook', async (req, res) => {
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const events = entry.messaging || [];
      for (const ev of events) {
        const psid = ev.sender?.id;
        const text = ev.message?.text;
        if (psid && text) {
          await axios.post(
            'https://graph.facebook.com/v20.0/me/messages',
            { recipient: { id: psid }, message: { text: 'Ciao 👋' }, messaging_type: 'RESPONSE' },
            { headers: { Authorization: `Bearer ${PAGE_TOKEN}` } }
          );
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
app.listen(PORT, '0.0.0.0', () => console.log(`ON :${PORT}`));
