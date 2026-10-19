// Aanwezigheidsformulier WPL1: Stephanie ondertekent elke stagedag.
// De dagen zelf staan hieronder in DAYS (Claude past ze aan op vraag van Alexander).
// GET  /api/stage                 -> { days }
// POST /api/stage { action: "sign", i, sig } | { action: "unsign", i }
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const N = 21;
const KEY = 'stage:sig';

// Index 0-2 = week 1, 3-5 = week 2, ... 18-20 = week 7.
const DAYS = {
  0: { datum: '2026-10-07', start: '09:00', einde: '17:00', taken: 'Eerste stagedag: kennismaking met het marketingteam en de werking van de afdeling; eerste brochures nagelezen.' },
  3: { datum: '2026-10-12', start: '09:00', einde: '17:00', taken: 'Brochures nagelezen en gecontroleerd; zo een beter beeld gekregen van de opleidingen van AMS.' },
  4: { datum: '2026-10-13', start: '09:00', einde: '17:00', taken: 'Geboekte tickets voor het event in het KMSKA gecontroleerd in Odoo.' },
  5: { datum: '2026-10-14', start: '09:00', einde: '17:00', taken: 'Brainstorm over wat AMS kan aanbieden tijdens de opendeurdagen; verder gewerkt in Odoo.' },
};

async function redis(...cmds) {
  if (!URL_ || !TOKEN) throw new Error('Database niet gekoppeld');
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('Database-fout ' + r.status);
  return (await r.json()).map((x) => x.result);
}

const visitor = (req) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'onbekend';
  return crypto.createHash('sha256').update('ah-salt:' + ip).digest('hex').slice(0, 24);
};
const fid = (i) => 'd' + String(i).padStart(2, '0');
const complete = (d) => d && d.datum && d.start && d.einde && String(d.taken).trim();

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

async function allDays() {
  const [flat] = await redis(['HGETALL', KEY]);
  const sigs = {};
  for (let k = 0; k + 1 < (flat || []).length; k += 2) {
    try { sigs[flat[k]] = JSON.parse(flat[k + 1]); } catch { /* overslaan */ }
  }
  return Array.from({ length: N }, (_, i) => {
    const d = DAYS[i] || { datum: '', start: '', einde: '', taken: '' };
    const s = sigs[fid(i)] || {};
    return { ...d, sig: s.sig || null, sigAt: s.sigAt || null };
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json({ days: await allDays() });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Methode niet toegestaan' });
    }

    const v = visitor(req);
    const [count] = await redis(['INCR', 'stagerate:' + v], ['EXPIRE', 'stagerate:' + v, '600', 'NX']);
    if (count > 40) return res.status(429).json({ error: 'Even geduld. Probeer het over enkele minuten opnieuw.' });

    const b = await readBody(req);
    const i = b.i;
    if (!Number.isInteger(i) || i < 0 || i >= N) return res.status(400).json({ error: 'Ongeldige dag' });

    if (b.action === 'sign') {
      if (!complete(DAYS[i])) return res.status(400).json({ error: 'Deze dag is nog niet ingevuld.' });
      const sig = String(b.sig || '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 120000) return res.status(400).json({ error: 'De handtekening kon niet bewaard worden.' });
      const [ok] = await redis(['HSETNX', KEY, fid(i), JSON.stringify({ sig, sigAt: new Date().toISOString() })]);
      if (!ok) return res.status(409).json({ error: 'Deze dag is al ondertekend.' });
    } else if (b.action === 'unsign') {
      await redis(['HDEL', KEY, fid(i)]);
    } else {
      return res.status(400).json({ error: 'Onbekende actie' });
    }
    return res.status(200).json({ days: await allDays() });
  } catch (e) {
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het later opnieuw.' });
  }
};
