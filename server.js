const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function aiReply(text, channel = 'generic') {
  if (!text) return 'Puoi ripetere?';
  if (!process.env.OPENAI_API_KEY) return 'AI non configurata.';

  // piccoli messaggi -> rispondi senza AI (riduce chiamate)
  const noise = ['ok','okay','👍','👋','ciao','hey','yo','grazie','thx'];
  if (text && noise.includes(text.trim().toLowerCase())) return 'Eccomi! Dimmi pure 🙂';

  const TIMEOUT_MS = 15000;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      clearTimeout(t);
      const out = r.choices?.[0]?.message?.content?.trim();
      return out || 'Non ho capito, puoi riformulare?';

    } catch (e) {
      clearTimeout(t);

      // estrai info utili
      const status = e?.status || e?.response?.status;
      const data = e?.response?.data || e?.data;
      const msg = e?.message || data?.error?.message;
      const headers = e?.response?.headers || {};
      const retryAfter = Number(headers['retry-after']) || 0;

      console.error('OpenAI failure', {
        attempt, status, msg, retryAfter
      });

      // 429 → rispetta Retry-After o fai backoff
      if (status === 429) {
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * attempt + Math.floor(Math.random() * 300);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(waitMs);
          continue;
        }
        return 'Sto ricevendo molte richieste. Riprova tra qualche secondo 🙏';
      }

      // 5xx o timeout → backoff e ritenta
      if ((status >= 500 && status < 600) || String(msg).includes('aborted')) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt + Math.floor(Math.random() * 300));
          continue;
        }
        return 'Ho un momentaneo problema di connessione, riprova tra poco 🙏';
      }

      // 4xx non recuperabili (es. chiave invalida, modello sbagliato)
      if (status >= 400 && status < 500) {
        return 'AI non disponibile (configurazione). Riprova più tardi 🙏';
      }

      // fallback
      if (attempt === MAX_ATTEMPTS) {
        return `In questo momento non riesco a usare l’AI. Intanto ho letto: "${text}"`;
      }
    }
  }
}
