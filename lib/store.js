import { redis, getJSON, setJSON, hgetallJSON, hsetJSON } from './redis.js';
import { norm } from './parse.js';
import seed from '../data/seed.json' with { type: 'json' };

export const TZ = 'Asia/Tashkent';
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

// Синонимы и фасовка по умолчанию (как пишут в ZAMES)
const DEFAULT_ALIASES = { 'хуа чжу ча': 'Жасмин чай', 'зеленый с жасмином': 'Жасмин чай', 'жасмин': 'Жасмин чай', 'зеленый чай с жасмином': 'Жасмин чай', 'кофе': 'Кофе молотый', 'зерно': 'Кофе молотый', 'кофе зерно': 'Кофе молотый', 'лактел': 'Молоко безлактозное', 'чорток': 'Вода Чорток б/г 0,33', 'кола зеро': 'Кола Зеро' };
const DEFAULT_PACKS = { 'Молоко': 1000, 'Молоко безлактозное': 1000, 'Альтернативное молоко': 1000, 'Сливки 10%': 1000 };
export async function ensureSeed() {
  if (!(await redis('GET', 'seed_v2'))) {
    for (const [a, p] of Object.entries(DEFAULT_ALIASES)) if (!(await redis('HGET', 'alias', norm(a)))) await redis('HSET', 'alias', norm(a), p);
    for (const [p, v] of Object.entries(DEFAULT_PACKS)) if (!(await redis('HGET', 'pack', p))) await redis('HSET', 'pack', p, String(v));
    await redis('SET', 'seed_v2', '1');
  }
  if (await redis('GET', 'seeded')) return;
  for (const [code, tk] of Object.entries(seed.techcards)) await hsetJSON('tk', code, tk);
  for (const [name, p] of Object.entries(seed.products)) {
    if (!(await redis('HGET', 'prod', name))) await hsetJSON('prod', name, { unit: p.unit, stock: 0, cost: 0 });
  }
  await redis('SET', 'seeded', '1');
}

export const products = () => hgetallJSON('prod');
export async function packs() { const a = (await redis('HGETALL', 'pack')) || []; const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = +a[i + 1]; return o; }
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
// Совпадение только по целым словам: «апельсин» ≠ «апельсиновый фреш».
export function findProduct(raw, prods, al) {
  const n = norm(raw);
  if (!n) return null;
  if (al[n]) return al[n];
  const names = Object.keys(prods);
  const byNorm = names.find(x => norm(x) === n);
  if (byNorm) return byNorm;
  const STOP = new Set(['с', 'м', 'сок', 'смесь', '0', '33', 'и', 'для']);
  const stem = t => t.length > 5 ? t.replace(/(ами|ями|ом|ем|ым|им|ой|ей|ая|яя|ое|ее|ые|ие|ый|ий|ов|ев|ах|ях|у|ю|ы|и|а|я)$/, '') : t;
  const toks = x => norm(x).split(' ').filter(t => t && !STOP.has(t)).map(stem);
  const rt = toks(raw);
  if (!rt.length) return null;
  // все слова из написанного есть в названии (или все слова названия есть в написанном)
  // 1) всё написанное входит в название («ягодный» → «Концентрат ягодный»), самое короткое название
  // лишними в названии могут быть только слова, которые обычно не пишут: «концентрат», «молотый», «чай»…
  const OMIT = new Set(['концентрат', 'молотый', 'чай', '10%', '10', 'зеленый', 'листовой', 'свежий']);
  const sub = names.filter(x => { const xt = toks(x); return rt.every(t => xt.includes(t)) && xt.filter(t => !rt.includes(t)).every(t => OMIT.has(t)); }).sort((a, b) => toks(a).length - toks(b).length);
  if (sub.length === 1 || (sub.length > 1 && toks(sub[0]).length < toks(sub[1]).length)) return sub[0];
  if (sub.length > 1) return null;
  // 2) название целиком входит в написанное («Молоко каллех» → «Молоко»), самое длинное совпадение
  const sup = names.filter(x => { const xt = toks(x); return xt.length && xt.every(t => rt.includes(t)); }).sort((a, b) => toks(b).length - toks(a).length);
  if (sup.length === 1 || (sup.length > 1 && toks(sup[0]).length > toks(sup[1]).length)) return sup[0];
  if (sup.length > 1) return null;
  // опечатки — только по всему названию целиком и только для длинных слов
  let best = null, bd = 99;
  for (const x of names) { const dd = lev(norm(x), n); if (dd < bd) { bd = dd; best = x; } }
  const lim = n.length <= 5 ? 0 : n.length <= 10 ? 1 : 2;
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
export async function applyMoves(moves, prods, ctx = {}) {
  const prev = [];
  const res = [];
  const alerts = [];
  for (const m of moves) {
    const p = prods[m.p] || { unit: m.unit || 'шт', stock: 0, cost: 0 };
    prev.push([m.p, { ...p }]);
    if (m.delta > 0 && m.price) { // приход с суммой: средневзвешенная цена + история цен поставщиков
      const unitCost = m.price / m.delta;
      const last = p.lastPrice || p.cost;
      if (last > 0 && Math.abs(unitCost / last - 1) >= 0.1) alerts.push({ p: m.p, from: last, to: unitCost, unit: p.unit, supplier: ctx.supplier || '' });
      p.lastPrice = unitCost;
      await redis('RPUSH', `price:${m.p}`, JSON.stringify({ d: ctx.date || today(), s: ctx.supplier || '', u: unitCost }));
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
  return { res, prev, alerts };
}

// ---- склады цехов (Кухня / Пиццерия / Кондитерская) ----
export const DEPTS = ['Кухня', 'Пиццерия', 'Кондитерская'];
export const dprods = () => hgetallJSON('dprod'); // ключ "Кухня|Молоко" -> {stock}
export async function applyDept(dept, moves, prods) {
  const res = [], prev = [];
  for (const m of moves) {
    const k = `${dept}|${m.p}`;
    const cur = JSON.parse((await redis('HGET', 'dprod', k)) || '{"stock":0}');
    prev.push([k, { ...cur }]);
    let delta = m.setTo !== undefined ? m.setTo - cur.stock : m.delta;
    cur.stock = round(cur.stock + delta);
    await hsetJSON('dprod', k, cur);
    const cost = prods[m.p]?.cost || 0;
    res.push({ p: m.p, q: round(delta), unit: prods[m.p]?.unit || m.unit, sum: Math.round(Math.abs(delta) * cost), noCost: !cost });
  }
  return { res, prev };
}

export async function undoLast(user) {
  const last = await getJSON(`last:${user}`);
  if (!last) return null;
  const list = (await redis('LRANGE', `ops:${last.date}`, 0, -1)) || [];
  const op = list.map(s => JSON.parse(s)).find(o => o.id === last.id);
  if (!op) return null;
  await revertOp(op);
  await redis('DEL', `last:${user}`);
  return op;
}

// Отменить любую операцию: вернуть остатки (и склад цеха), пометить удалённой
export async function revertOp(op) {
  if (await redis('HGET', 'deleted', op.id)) return false;
  if (op.loc) { // операция по складу цеха
    for (const it of op.items || []) {
      const k = `${op.loc}|${it.p}`; const cur = JSON.parse((await redis('HGET', 'dprod', k)) || '{"stock":0}');
      cur.stock = round(cur.stock - it.q); await hsetJSON('dprod', k, cur);
    }
    await redis('HSET', 'deleted', op.id, '1');
    return true;
  }
  if (op.type === 'move' && op.dept) { // перемещение пополнило склад цеха — вернуть
    for (const it of op.items || []) {
      const k = `${op.dept}|${it.p}`; const cur = JSON.parse((await redis('HGET', 'dprod', k)) || '{"stock":0}');
      cur.stock = round(cur.stock + it.q); await hsetJSON('dprod', k, cur);
    }
  }
  const prods = await products();
  (op.items || []).forEach((it, i) => {
    const cur = prods[it.p]; if (!cur) return;
    cur.stock = round(cur.stock - it.q);
    const pr = (op.prev || [])[i]; if (pr && pr[0] === it.p) cur.cost = pr[1].cost;
  });
  for (const it of op.items || []) if (prods[it.p]) await hsetJSON('prod', it.p, prods[it.p]);
  await redis('HSET', 'deleted', op.id, '1');
  return true;
}

export const round = x => Math.round(x * 1000) / 1000;
