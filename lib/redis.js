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
// Ищем все пары URL+TOKEN Upstash в переменных, с любым префиксом (ZAMES_KV_REST_API_URL, STORAGE_URL и т.п.)
const pairs = () => {
  const env = process.env, out = [];
  const add = (u, t) => { if (u && t && /^https:\/\//.test(u) && !out.some(p => p[0] === u)) out.push([u, t]); };
  // новые подключения (с префиксом) — первыми, старые KV_/UPSTASH_ — в конце
  const keys = Object.keys(env).filter(k => /URL$/.test(k) && /^https:\/\/.*upstash\.io/.test(env[k] || ''));
  keys.sort((a, b) => (/^(KV_|UPSTASH_)/.test(a) ? 1 : 0) - (/^(KV_|UPSTASH_)/.test(b) ? 1 : 0));
  for (const k of keys) {
    const base = k.replace(/URL$/, '');
    add(env[k], env[base + 'TOKEN'] || env[base.replace(/REST_API_$/, 'REST_API_') + 'TOKEN']);
  }
  add(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  add(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  return out;
};

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
