// server.js (minimo per sbloccare la verifica)
import 'dotenv/config';
import express from 'express';
const app = express();

// Healthcheck
app.get('/', (_req, res) => res.status(200).send('OK'));

// ✅ DEBUG: mostra il VERIFY_TOKEN che legge il server
app.get('/debug-verify', (req, res) => {
  const vt = process.env.VERIFY_TOKEN || '';
  const got = req.query?.['hub.verify_token'] || '';
  res.status(200).json({
    got_from_url: got,
    expected_len: vt.length,
    expected_preview: vt ? vt[0] + '...' + vt[vt.length - 1] : '(vuoto)'
  });
});

// ✅ Verifica webhook (Messenger/IG)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`ON :${PORT}`));
// LOG TUTTO
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Rotta di test manuale per i log
app.get('/ping', (_req, res) => res.status(200).send('pong'));
