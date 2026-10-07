// Reacties en duimpjes voor de weekblog.
// /api/blog?type=comments  (GET, POST, DELETE)   /api/blog?type=likes  (GET, POST)
// Opslag: Upstash Redis via REST (geen npm-pakketten nodig).
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...cmds) {
  if (!URL_ || !TOKEN) throw new Error('Database niet gekoppeld');
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('Database-fout ' + r.status);
  const out = await r.json();
  return out.map((x) => x.result);
}

// SHA-256 van de beheerderssleutel (de sleutel zelf staat niet in de code).
const ADMIN_HASH = '0ffe6847ae58347322f4c7d9b79d30d93be98e27aa4d53d7a27d5b1daa20aa07';
const isAdmin = (key) =>
  typeof key === 'string' && crypto.createHash('sha256').update(key).digest('hex') === ADMIN_HASH;

const visitor = (req) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'onbekend';
  return crypto.createHash('sha256').update('ah-salt:' + ip).digest('hex').slice(0, 24);
};

const validPost = (p) => typeof p === 'string' && /^week-[1-9][0-9]?$/.test(p);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}


async function comments(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const post = req.query.post;
      if (!validPost(post)) return res.status(400).json({ error: 'Ongeldige post' });
      const [items] = await redis(['LRANGE', 'comments:' + post, '0', '199']);
      const list = (items || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      return res.status(200).json({ comments: list.reverse() }); // oudste eerst
    }

    const body = await readBody(req);

    if (req.method === 'POST') {
      const { post, website } = body;
      const name = String(body.name || '').trim().slice(0, 60);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!validPost(post)) return res.status(400).json({ error: 'Ongeldige post' });
      if (website) return res.status(200).json({ ok: true }); // spam-val
      if (!name || !text) return res.status(400).json({ error: 'Vul je naam en een reactie in.' });

      const v = visitor(req);
      const [count] = await redis(['INCR', 'rate:' + v], ['EXPIRE', 'rate:' + v, '600', 'NX']);
      if (count > 5) return res.status(429).json({ error: 'Even geduld: je hebt al een paar reacties geplaatst. Probeer het straks opnieuw.' });

      const c = { id: crypto.randomBytes(8).toString('hex'), name, text, ts: Date.now() };
      await redis(['LPUSH', 'comments:' + post, JSON.stringify(c)], ['LTRIM', 'comments:' + post, '0', '199']);
      return res.status(201).json({ comment: c });
    }

    if (req.method === 'DELETE') {
      const { post, id, key } = body;
      if (!isAdmin(key)) return res.status(403).json({ error: 'Geen toegang' });
      if (!validPost(post)) return res.status(400).json({ error: 'Ongeldige post' });
      const [items] = await redis(['LRANGE', 'comments:' + post, '0', '-1']);
      const raw = (items || []).find((s) => { try { return JSON.parse(s).id === id; } catch { return false; } });
      if (raw) await redis(['LREM', 'comments:' + post, '1', raw]);
      return res.status(200).json({ ok: true, removed: !!raw });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Methode niet toegestaan' });
  } catch (e) {
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het later opnieuw.' });
  }
}

async function likes(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const v = visitor(req);
    if (req.method === 'GET') {
      const post = req.query.post;
      if (!validPost(post)) return res.status(400).json({ error: 'Ongeldige post' });
      const [count, liked] = await redis(['SCARD', 'likes:' + post], ['SISMEMBER', 'likes:' + post, v]);
      return res.status(200).json({ count, liked: liked === 1 });
    }
    if (req.method === 'POST') {
      const { post } = await readBody(req);
      if (!validPost(post)) return res.status(400).json({ error: 'Ongeldige post' });
      const [isIn] = await redis(['SISMEMBER', 'likes:' + post, v]);
      const [, count] = await redis([isIn ? 'SREM' : 'SADD', 'likes:' + post, v], ['SCARD', 'likes:' + post]);
      return res.status(200).json({ count, liked: !isIn });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Methode niet toegestaan' });
  } catch (e) {
    return res.status(500).json({ error: 'Er ging iets mis.' });
  }
}

module.exports = async (req, res) => {
  const t = req.query.type;
  if (t === 'comments') return comments(req, res);
  if (t === 'likes') return likes(req, res);
  return res.status(404).json({ error: 'Onbekend' });
};
