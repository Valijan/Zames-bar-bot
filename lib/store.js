import { redis, getJSON, setJSON, hgetallJSON, hsetJSON } from './redis.js';
import { norm } from './parse.js';
import seed from '../data/seed.json' with { type: 'json' };

export const TZ = 'Asia/Tashkent';
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

export async function ensureSeed() {
  if (await redis('GET', 'seeded')) return;
  for (const [code, tk] of Object.entries(seed.techcards)) await hsetJSON('tk', code, tk);
  for (const [name, p] of Object.entries(seed.products)) {
    if (!(await redis('HGET', 'prod', name))) await hsetJSON('prod', name, { unit: p.unit, stock: 0, cost: 0 });
  }
  await redis('SET', 'seeded', '1');
}

export const products = () => hgetallJSON('prod');
export const techcards = () => hgetallJSON('tk');
export const aliases = async () => {
  const arr = (await redis('HGETALL', 'alias')) || [];
  const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o;
};

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Найти продукт по тому, как его написали. Возвращает каноническое имя или null.
export function findProduct(raw, prods, al) {
  const n = norm(raw);
  if (!n) return null;
  if (al[n]) return al[n];
  const names = Object.keys(prods);
  const byNorm = names.find(x => norm(x) === n);
  if (byNorm) return byNorm;
  // без "с/м", скобок и т.п.
  const core = x => norm(x).replace(/\b(с м|сок|смесь|0 33)\b/g, '').replace(/\s+/g, ' ').trim();
  const c = names.filter(x => core(x) === core(raw));
  if (c.length === 1) return c[0];
  // начало слова / вхождение
  const sw = names.filter(x => norm(x).startsWith(n) || n.startsWith(norm(x)));
  if (sw.length === 1) return sw[0];
  const inc = names.filter(x => norm(x).includes(n));
  if (inc.length === 1) return inc[0];
  // опечатки
  let best = null, bd = 99;
  for (const x of names) { const dd = lev(norm(x), n); if (dd < bd) { bd = dd; best = x; } }
  const lim = n.length <= 5 ? 1 : n.length <= 10 ? 2 : 3;
  return bd <= lim ? best : null;
}

// ---- операции ----
export async function addOp(op) {
  op.id = op.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  op.date = op.date || today();
  await redis('RPUSH', `ops:${op.date}`, JSON.stringify(op));
  await redis('HSET', 'opdates', op.date, '1');
  if (op.user) await setJSON(`last:${op.user}`, { id: op.id, date: op.date });
  return op;
}

export async function opsBetween(from, to) {
  const dates = Object.keys((await hgetallRaw('opdates'))).filter(d => d >= from && d <= to).sort();
  const deleted = await hgetallRaw('deleted');
  const out = [];
  for (const d of dates) {
    const list = (await redis('LRANGE', `ops:${d}`, 0, -1)) || [];
    for (const s of list) { const o = JSON.parse(s); if (!deleted[o.id]) out.push(o); }
  }
  return out;
}
async function hgetallRaw(k) {
  const arr = (await redis('HGETALL', k)) || [];
  const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o;
}

// Применить движение к остаткам. effects: [[product, delta(base), costTotal|null]]
// Возвращает список с себестоимостью и откат (prev).
export async function applyMoves(moves, prods) {
  const prev = [];
  const res = [];
  for (const m of moves) {
    const p = prods[m.p] || { unit: m.unit || 'шт', stock: 0, cost: 0 };
    prev.push([m.p, { ...p }]);
    if (m.delta > 0 && m.price) { // приход с суммой: средневзвешенная цена
      const base = Math.max(p.stock, 0);
      p.cost = (base * p.cost + m.price) / (base + m.delta);
    }
    if (m.setTo !== undefined) { m.delta = m.setTo - p.stock; }
    p.stock = round(p.stock + m.delta);
    const sum = m.price ?? Math.abs(m.delta) * (p.cost || 0);
    res.push({ p: m.p, q: round(m.delta), unit: p.unit, sum: Math.round(sum), noCost: !p.cost && !m.price });
    prods[m.p] = p;
    await hsetJSON('prod', m.p, p);
  }
  return { res, prev };
}

export async function undoLast(user) {
  const last = await getJSON(`last:${user}`);
  if (!last) return null;
  const list = (await redis('LRANGE', `ops:${last.date}`, 0, -1)) || [];
  const op = list.map(s => JSON.parse(s)).find(o => o.id === last.id);
  if (!op) return null;
  const prods = await products();
  (op.items || []).forEach((it, i) => {
    const cur = prods[it.p]; if (!cur) return;
    cur.stock = round(cur.stock - it.q);
    const pr = (op.prev || [])[i]; if (pr && pr[0] === it.p) cur.cost = pr[1].cost;
  });
  for (const it of op.items || []) if (prods[it.p]) await hsetJSON('prod', it.p, prods[it.p]);
  await redis('HSET', 'deleted', op.id, '1');
  await redis('DEL', `last:${user}`);
  return op;
}

export const round = x => Math.round(x * 1000) / 1000;
