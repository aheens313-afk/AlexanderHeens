// Aanwezigheidsformulier WPL1: 21 stagedagen met handtekening van de mentor.
// GET  /api/stage              -> { role, days }       (header X-Code verplicht)
// POST /api/stage { action }   -> edit | sign | unsign | setcode
// Rollen: "student" (beheerderssleutel van de site) en "mentor" (eigen code, hash staat in Redis).
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const N = 21;
const KEY = 'stage:dagen';

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

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ADMIN_HASH = '0ffe6847ae58347322f4c7d9b79d30d93be98e27aa4d53d7a27d5b1daa20aa07';
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const visitor = (req) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'onbekend';
  return sha('ah-salt:' + ip).slice(0, 24);
};

async function roleOf(code) {
  if (typeof code !== 'string' || code.length < 6 || code.length > 100) return null;
  const h = sha(code);
  if (same(h, ADMIN_HASH)) return 'student';
  const [mh] = await redis(['GET', 'stage:mentorhash']);
  if (mh && same(h, mh)) return 'mentor';
  return null;
}

// Startgegevens: de dagen die al gepresteerd waren toen het formulier online kwam.
const SEED = {
  d00: { datum: '2026-10-07', start: '09:00', einde: '17:00', taken: 'Eerste stagedag: kennismaking met het marketingteam en de werking van de afdeling; eerste brochures nagelezen.' },
  d03: { datum: '2026-10-12', start: '09:00', einde: '17:00', taken: 'Brochures nagelezen en gecontroleerd; zo een beter beeld gekregen van de opleidingen van AMS.' },
  d04: { datum: '2026-10-13', start: '09:00', einde: '17:00', taken: 'Geboekte tickets voor het event in het KMSKA gecontroleerd in Odoo.' },
  d05: { datum: '2026-10-14', start: '09:00', einde: '17:00', taken: 'Brainstorm over wat AMS kan aanbieden tijdens de opendeurdagen; verder gewerkt in Odoo.' },
};
const fid = (i) => 'd' + String(i).padStart(2, '0');
const empty = () => ({ datum: '', start: '', einde: '', taken: '', sig: null, sigAt: null });

async function readDays() {
  const [flat] = await redis(['HGETALL', KEY]);
  const map = {};
  for (let k = 0; k + 1 < (flat || []).length; k += 2) {
    try { map[flat[k]] = JSON.parse(flat[k + 1]); } catch { /* overslaan */ }
  }
  return Array.from({ length: N }, (_, i) => Object.assign(empty(), map[fid(i)] || SEED[fid(i)] || {}));
}
async function readDay(i) {
  const [s] = await redis(['HGET', KEY, fid(i)]);
  try { return Object.assign(empty(), s ? JSON.parse(s) : (SEED[fid(i)] || {})); } catch { return empty(); }
}
const writeDay = (i, d) => redis(['HSET', KEY, fid(i), JSON.stringify(d)]);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

const validIndex = (i) => Number.isInteger(i) && i >= 0 && i < N;
const validDate = (s) => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s);
const validTime = (s) => s === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const complete = (d) => d.datum && d.start && d.einde && String(d.taken).trim();

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const v = visitor(req);
    const [fails] = await redis(['GET', 'stagefail:' + v]);
    if (Number(fails) >= 15) return res.status(429).json({ error: 'Te veel foute pogingen. Probeer het over tien minuten opnieuw.' });

    const role = await roleOf(req.headers['x-code']);
    if (!role) {
      await redis(['INCR', 'stagefail:' + v], ['EXPIRE', 'stagefail:' + v, '600', 'NX']);
      return res.status(401).json({ error: 'Deze toegangscode klopt niet.' });
    }

    if (req.method === 'GET') {
      return res.status(200).json({ role, days: await readDays() });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Methode niet toegestaan' });
    }

    const b = await readBody(req);
    const i = b.i;

    if (b.action === 'setcode') {
      if (role !== 'student') return res.status(403).json({ error: 'Alleen Alexander kan de mentorcode instellen.' });
      if (typeof b.code !== 'string' || b.code.length < 8 || b.code.length > 60) return res.status(400).json({ error: 'Code moet 8 tot 60 tekens lang zijn.' });
      await redis(['SET', 'stage:mentorhash', sha(b.code)]);
      return res.status(200).json({ ok: true });
    }

    if (!validIndex(i)) return res.status(400).json({ error: 'Ongeldige dag' });
    const d = await readDay(i);

    if (b.action === 'edit') {
      if (role !== 'student') return res.status(403).json({ error: 'Alleen Alexander kan de dagen invullen.' });
      if (d.sig) return res.status(409).json({ error: 'Deze dag is al ondertekend en kan niet meer gewijzigd worden.' });
      const datum = String(b.datum || ''), start = String(b.start || ''), einde = String(b.einde || '');
      const taken = String(b.taken || '').slice(0, 1500);
      if (!validDate(datum) || !validTime(start) || !validTime(einde)) return res.status(400).json({ error: 'Datum of uur heeft een ongeldige vorm.' });
      Object.assign(d, { datum, start, einde, taken });
      await writeDay(i, d);
      return res.status(200).json({ day: d });
    }

    if (b.action === 'sign') {
      if (role !== 'mentor') return res.status(403).json({ error: 'Alleen de mentor kan ondertekenen.' });
      if (d.sig) return res.status(409).json({ error: 'Deze dag is al ondertekend.' });
      if (!complete(d)) return res.status(400).json({ error: 'Deze dag is nog niet volledig ingevuld.' });
      const sig = String(b.sig || '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 120000) return res.status(400).json({ error: 'De handtekening kon niet bewaard worden.' });
      d.sig = sig; d.sigAt = new Date().toISOString();
      await writeDay(i, d);
      return res.status(200).json({ day: d });
    }

    if (b.action === 'unsign') {
      d.sig = null; d.sigAt = null;
      await writeDay(i, d);
      return res.status(200).json({ day: d });
    }

    return res.status(400).json({ error: 'Onbekende actie' });
  } catch (e) {
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het later opnieuw.' });
  }
};
