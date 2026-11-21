// Мини-клиент Upstash Redis (REST). Без зависимостей.
// Переменные: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// (или KV_REST_API_URL / KV_REST_API_TOKEN — так их называет Vercel).

const mem = new Map(); // для локальных тестов (MEMORY_DB=1)

function memCmd([cmd, key, ...a]) {
  cmd = cmd.toUpperCase();
  const get = () => mem.get(key);
  switch (cmd) {
    case 'PING': return 'PONG';
    case 'GET': return get() ?? null;
    case 'SET': mem.set(key, a[0]); return 'OK';
    case 'DEL': return mem.delete(key) ? 1 : 0;
    case 'HSET': { const h = get() || {}; for (let i = 0; i < a.length; i += 2) h[a[i]] = a[i + 1]; mem.set(key, h); return 1; }
    case 'HGET': return (get() || {})[a[0]] ?? null;
    case 'HDEL': { const h = get() || {}; delete h[a[0]]; mem.set(key, h); return 1; }
    case 'HGETALL': { const h = get() || {}; return Object.entries(h).flat(); }
    case 'RPUSH': { const l = get() || []; l.push(...a); mem.set(key, l); return l.length; }
    case 'RPOP': { const l = get() || []; const v = l.pop(); mem.set(key, l); return v ?? null; }
    case 'LRANGE': { const l = get() || []; const s = +a[0], e = +a[1]; return l.slice(s, e === -1 ? undefined : e + 1); }
    case 'KEYS': { const re = new RegExp('^' + key.replace(/\*/g, '.*') + '$'); return [...mem.keys()].filter(k => re.test(k)); }
    default: throw new Error('mem: ' + cmd);
  }
}

let working = null; // какая пара переменных реально работает
const pairs = () => [
  [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
  [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
  [process.env.REDIS_REST_URL, process.env.REDIS_REST_TOKEN],
].filter(([u, t]) => u && t && /^https?:/.test(u));

export async function redis(...cmd) {
  if (process.env.MEMORY_DB) return memCmd(cmd.map(String));
  const list = working ? [working, ...pairs().filter(p => p[0] !== working[0])] : pairs();
  if (!list.length) throw new Error('Нет настроек Redis (подключите Storage → Upstash Redis)');
  let lastErr;
  for (const [url, token] of list) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd.map(String)),
      });
      const j = await r.json();
      if (j.error) throw new Error('Redis: ' + j.error);
      working = [url, token];
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export const getJSON = async (k, def = null) => { const v = await redis('GET', k); return v ? JSON.parse(v) : def; };
export const setJSON = (k, v) => redis('SET', k, JSON.stringify(v));
export async function hgetallJSON(k) {
  const arr = (await redis('HGETALL', k)) || [];
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = JSON.parse(arr[i + 1]);
  return o;
}
export const hsetJSON = (k, f, v) => redis('HSET', k, f, JSON.stringify(v));
