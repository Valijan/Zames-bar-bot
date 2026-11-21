// Доп. функции: сигналы, закупка, цены поставщиков, калькулятор цены, смены, склады цехов, выгрузка в Google Таблицу
import { redis, getJSON, setJSON, hgetallJSON } from './redis.js';
import { norm, parseLine, toBase, parseDate } from './parse.js';
import { products, techcards, aliases, findProduct, opsBetween, today, round, dprods, DEPTS } from './store.js';
import { reply, sendFile, esc } from './telegram.js';

export const fmt = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const fq = (q, u) => {
  const a = Math.abs(q);
  if (u === 'г' && a >= 1000) return `${round(q / 1000)} кг`;
  if (u === 'мл' && a >= 1000) return `${round(q / 1000)} л`;
  return `${round(q)} ${u || ''}`.trim();
};
export const ddmm = d => d.slice(8, 10) + '.' + d.slice(5, 7);
const shift = (date, n) => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const perKgL = (cost, unit) => unit === 'г' ? `${fmt(cost * 1000)} сум/кг` : unit === 'мл' ? `${fmt(cost * 1000)} сум/л` : `${fmt(cost)} сум/шт`;

// ---------- уведомления владельцу ----------
export async function notifyOwner(text) {
  const owner = await redis('GET', 'owner');
  if (!owner) return;
  return reply({ chat: { id: +owner, type: 'private' }, from: { id: +owner } }, text);
}

// Средний расход бара в день по продуктам (продажи + списания + перемещения)
export async function usage(days = 14) {
  const to = today(), from = shift(to, -days);
  const ops = await opsBetween(from, to);
  const first = ops.length ? ops.reduce((a, o) => o.date < a ? o.date : a, to) : to;
  const span = Math.max(1, Math.min(days, Math.round((new Date(to) - new Date(first)) / 864e5) + 1));
  const u = {};
  for (const o of ops) if (['sales', 'out', 'move'].includes(o.type) && !o.loc)
    for (const r of o.items) if (r.q < 0) u[r.p] = (u[r.p] || 0) - r.q;
  for (const k in u) u[k] /= span;
  return { perDay: u, span };
}

// 1. Сигналы: что скоро закончится
export async function lowStock() {
  const prods = await products(); const { perDay, span } = await usage(14);
  if (span < 2) return [];
  const out = [];
  for (const [p, d] of Object.entries(perDay)) {
    const s = prods[p]?.stock ?? 0;
    if (d <= 0) continue;
    const left = s / d;
    if (left < 2) out.push({ p, left, stock: s, unit: prods[p]?.unit, perDay: d });
  }
  return out.sort((a, b) => a.left - b.left);
}

// 1. Сигналы: цех берёт больше обычного (последние 7 дней против среднего за 3 недели до этого)
export async function deptOveruse() {
  const to = today();
  const ops = await opsBetween(shift(to, -28), to);
  const cut = shift(to, -7);
  const agg = {};
  for (const o of ops) if (o.type === 'move') for (const r of o.items) {
    const k = `${o.dept || 'Кухня'}|${r.p}`; const a = agg[k] ||= { now: 0, before: 0, sumNow: 0, unit: r.unit };
    if (o.date > cut) { a.now += -r.q; a.sumNow += r.sum; } else a.before += -r.q;
  }
  const out = [];
  for (const [k, a] of Object.entries(agg)) {
    const avg = a.before / 3;
    if (avg > 0 && a.now > avg * 1.3) { const [dept, p] = k.split('|'); out.push({ dept, p, now: a.now, avg, pct: Math.round((a.now / avg - 1) * 100), unit: a.unit, sum: a.sumNow }); }
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// 1. Сигналы: цена закупки изменилась — какие позиции подорожали
export async function priceAlertText(alerts) {
  if (!alerts?.length) return null;
  const tks = await techcards(); const prods = await products();
  const lines = [];
  for (const a of alerts) {
    const up = a.to > a.from;
    lines.push(`${up ? '🔺' : '🔻'} <b>${esc(a.p)}</b>: ${perKgL(a.from, a.unit)} → ${perKgL(a.to, a.unit)} (${up ? '+' : ''}${Math.round((a.to / a.from - 1) * 100)}%)${a.supplier ? ' · ' + esc(a.supplier) : ''}`);
    const hit = Object.values(tks).filter(t => t.items.some(([i]) => i === a.p));
    for (const t of hit.slice(0, 6)) {
      const n = t.items.find(([i]) => i === a.p)[1];
      const cost = t.items.reduce((s, [i, q]) => s + q * (prods[i]?.cost || 0), 0);
      lines.push(`   • ${esc(t.name)}: +${fmt(n * (a.to - a.from))} сум на порцию, себестоимость ≈ ${fmt(cost)}`);
    }
  }
  return `💲 <b>Изменились цены закупки</b>\n${lines.join('\n')}\n\nФудкост по позициям: /foodcost`;
}

// 2. Список закупки
export async function cmdOrder(msg, args) {
  const days = Math.min(+((args.match(/\d+/) || [])[0]) || 7, 31);
  const prods = await products(); const { perDay, span } = await usage(14);
  if (!Object.keys(perDay).length) return reply(msg, 'Пока мало данных о расходе. Нужно несколько дней продаж, списаний и перемещений.');
  const best = await bestSuppliers();
  const fixed = await supplierMap();
  const rows = [];
  for (const [p, d] of Object.entries(perDay)) {
    const s = Math.max(prods[p]?.stock ?? 0, 0);
    const need = d * days * 1.15 - s; // +15% запас
    if (need <= 0) continue;
    const unit = prods[p]?.unit;
    const cost = need * (prods[p]?.lastPrice || prods[p]?.cost || 0);
    rows.push({ p, need, unit, s, d, cost, sup: fixed[p] ? { s: fixed[p] } : best[p] });
  }
  if (!rows.length) return reply(msg, `✅ На ${days} дней всего хватает.`);
  rows.sort((a, b) => b.cost - a.cost);
  const bySup = {};
  for (const r of rows) (bySup[r.sup?.s || 'Без фирмы (рынок / магазин)'] ||= []).push(r);
  let total = 0;
  let out = `🛒 <b>Закупка на ${days} дней</b> (расход за ${span} дн. + 15% запас)\n`;
  if (span < 3) out += `⚠️ Данных всего за ${span} дн. — цифры примерные, через неделю будут точнее.\n`;
  for (const [sup, list] of Object.entries(bySup)) {
    out += `\n<b>${esc(sup)}</b>\n` + list.map(r => { total += r.cost; return `• ${esc(r.p)} — <b>${fq(r.need, r.unit)}</b> (есть ${fq(r.s, r.unit)}, уходит ${fq(r.d, r.unit)}/день)${r.cost ? ' ≈ ' + fmt(r.cost) : ''}`; }).join('\n') + '\n';
  }
  if (total) out += `\nИтого ≈ <b>${fmt(total)} сум</b>`;
  out += `\n\nОстатки точнее после инвентаризации. Другое число дней: <code>/order 14</code>`;
  return reply(msg, out);
}

// Привязка продуктов к фирмам (hash 'sup': продукт -> фирма). По умолчанию — кола и Чорток.
const DEFAULT_SUP = { 'Кола': 'Coca-Cola', 'Кола Зеро': 'Coca-Cola', 'Вода Чорток б/г 0,33': 'Чорток', 'Вода Чорток газ 0,33': 'Чорток' };
export async function supplierMap() {
  if (!(await redis('GET', 'sup_seeded'))) {
    for (const [p, f] of Object.entries(DEFAULT_SUP)) await redis('HSET', 'sup', p, f);
    await redis('SET', 'sup_seeded', '1');
  }
  const arr = (await redis('HGETALL', 'sup')) || [];
  const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o;
}

export async function cmdSupplier(msg, args) {
  const map = await supplierMap();
  if (!args.includes(':')) {
    const by = {}; for (const [p, f] of Object.entries(map)) (by[f] ||= []).push(p);
    return reply(msg, '🏢 <b>Фирмы и их продукты</b>\n' + (Object.entries(by).map(([f, ps]) => `<b>${esc(f)}</b>: ${ps.map(esc).join(', ')}`).join('\n') || 'пока пусто') +
      '\n\nПривязать: <code>/supplier Нестле: Сливки 10%, Молоко</code>\nЗаказ фирмам — до четверга, напомню сам.');
  }
  const [firm, list] = args.split(':');
  const prods = await products(); const al = await aliases();
  const done = [], miss = [];
  for (const raw of list.split(/[,\n]/).map(x => x.trim()).filter(Boolean)) {
    const p = findProduct(raw, prods, al);
    if (p) { await redis('HSET', 'sup', p, firm.trim()); done.push(p); } else miss.push(raw);
  }
  return reply(msg, `🏢 ${esc(firm.trim())}: ${done.map(esc).join(', ') || '—'}${miss.length ? `\n❓ Не нашёл: ${miss.map(esc).join(', ')}` : ''}`);
}

// 3. Цены поставщиков
async function bestSuppliers() {
  const keys = (await redis('KEYS', 'price:*')) || [];
  const out = {};
  for (const k of keys) {
    const list = ((await redis('LRANGE', k, -30, -1)) || []).map(JSON.parse).filter(x => x.s);
    const last = {}; for (const x of list) last[x.s] = x; // последняя цена у каждого поставщика
    const best = Object.values(last).sort((a, b) => a.u - b.u)[0];
    if (best) out[k.slice(6)] = best;
  }
  return out;
}

export async function cmdPrices(msg, args) {
  const prods = await products(); const al = await aliases();
  if (!args.trim()) {
    const best = await bestSuppliers();
    if (!Object.keys(best).length) return reply(msg, 'Истории цен пока нет. Она появляется из приходов с суммой: <code>Приход Макро\nМолоко 12 л 144000</code> — первая строка после «Приход» — поставщик. С фото накладной поставщик берётся автоматически.');
    return reply(msg, '🏷 <b>Где дешевле всего (последние цены)</b>\n' + Object.entries(best).sort().map(([p, b]) => `• ${esc(p)} — ${perKgL(b.u, prods[p]?.unit)} · ${esc(b.s)} (${ddmm(b.d)})`).join('\n') + '\n\nИстория по продукту: <code>/prices молоко</code>');
  }
  const p = findProduct(args, prods, al);
  if (!p) return reply(msg, `Не нашёл «${esc(args)}».`);
  const list = ((await redis('LRANGE', `price:${p}`, -15, -1)) || []).map(JSON.parse);
  if (!list.length) return reply(msg, `По «${esc(p)}» ещё не было приходов с суммой.`);
  const unit = prods[p].unit;
  const sup = {}; for (const x of list) if (x.s) (sup[x.s] ||= []).push(x.u);
  let out = `🏷 <b>${esc(p)}</b> — история закупок\n` + list.slice().reverse().map(x => `• ${ddmm(x.d)} — ${perKgL(x.u, unit)}${x.s ? ' · ' + esc(x.s) : ''}`).join('\n');
  const sups = Object.entries(sup).map(([s, a]) => [s, a[a.length - 1]]).sort((a, b) => a[1] - b[1]);
  if (sups.length > 1) out += `\n\nДешевле всего сейчас: <b>${esc(sups[0][0])}</b> (${perKgL(sups[0][1], unit)}), дороже: ${esc(sups[sups.length - 1][0])} (+${Math.round((sups[sups.length - 1][1] / sups[0][1] - 1) * 100)}%)`;
  return reply(msg, out);
}

// 4. Калькулятор цены новой позиции
export async function cmdCalc(msg, args) {
  if (!args.trim()) return reply(msg, 'Пришлите рецепт:\n<code>/calc Mont Blanc 25%\nКофе молотый 18 г\nМолоко 150 мл\nСливки 10% 50 мл\nСироп ваниль 20 мл</code>\nПервая строка — название и желаемый фудкост (по умолчанию 25%).');
  const lines = args.split('\n');
  const head = lines.shift();
  const target = +((head.match(/(\d{1,2})\s*%/) || [])[1]) || 25;
  const name = head.replace(/\d{1,2}\s*%/, '').trim() || 'Новая позиция';
  const prods = await products(); const al = await aliases();
  let cost = 0; const out = [], miss = [];
  for (const l of lines) {
    const it = parseLine(l); if (!it) continue;
    const p = findProduct(it.name, prods, al);
    if (!p) { miss.push(it.name); continue; }
    let [q] = toBase(it.qty, it.unit || prods[p].unit);
    const c = q * (prods[p].cost || 0); cost += c;
    out.push(`• ${esc(p)} — ${fq(q, prods[p].unit)}${prods[p].cost ? ' · ' + fmt(c) : ' · нет цены'}`);
  }
  const r1000 = x => Math.ceil(x / 1000) * 1000;
  let txt = `🧮 <b>${esc(name)}</b>\n${out.join('\n')}\n\nСебестоимость: <b>${fmt(cost)} сум</b>\n`;
  txt += [20, 25, 30, 35].map(f => `${f === target ? '👉 ' : ''}фудкост ${f}% → цена <b>${fmt(r1000(cost / f * 100))}</b>`).join('\n');
  if (![20, 25, 30, 35].includes(target)) txt += `\n👉 фудкост ${target}% → цена <b>${fmt(r1000(cost / target * 100))}</b>`;
  if (miss.length) txt += `\n\n❓ Нет в базе: ${miss.map(esc).join(', ')} — внесите приход с суммой или /price`;
  const noPrice = out.filter(x => x.includes('нет цены')).length;
  if (noPrice) txt += `\nℹ️ У ${noPrice} ингредиентов нет цены закупки — себестоимость занижена.`;
  return reply(msg, txt);
}

// 5. Смены
export async function cmdShift(msg, args) {
  const yr = +today().slice(0, 4);
  const date = parseDate(args, yr) || today();
  const names = args.replace(/\d{1,2}\.\d{1,2}(\.\d{2,4})?/, '').split(/[,\n]| и /).map(s => s.trim()).filter(Boolean);
  if (!names.length) {
    const cur = await getJSON(`shift:${date}`);
    return reply(msg, cur ? `Смена ${ddmm(date)}: ${cur.map(esc).join(', ')}` : 'Кто на смене: <code>/shift Валижон, Камрон</code> (можно с датой: <code>/shift 20.11 Камрон</code>)');
  }
  await setJSON(`shift:${date}`, names);
  return reply(msg, `👥 Смена ${ddmm(date)}: ${names.map(esc).join(', ')}`);
}

export async function cmdShifts(msg, args, periodFromArgs) {
  const [from, to] = periodFromArgs(args.trim() ? args : 'месяц');
  const ops = await opsBetween(from, to);
  const days = {};
  for (const o of ops) {
    const d = days[o.date] ||= { who: new Set(), out: 0, inv: 0, outBy: {} };
    if (o.userName && o.type !== 'sales') d.who.add(o.userName);
    if (o.type === 'out') { const s = o.items.reduce((a, r) => a + r.sum, 0); d.out += s; d.outBy[o.userName || '?'] = (d.outBy[o.userName || '?'] || 0) + s; }
    if (o.type === 'inv') d.inv += o.items.reduce((a, r) => a + (r.q < 0 ? -r.sum : r.sum), 0);
  }
  const people = {};
  let out = `👥 <b>Смены ${ddmm(from)}–${ddmm(to)}</b>\n`;
  for (const date of Object.keys(days).sort()) {
    const d = days[date];
    const set = await getJSON(`shift:${date}`);
    const staff = set || [...d.who];
    for (const n of staff) { const p = people[n] ||= { days: 0, out: 0, short: 0 }; p.days++; if (d.inv < 0) p.short += -d.inv; }
    for (const [n, s] of Object.entries(d.outBy)) (people[n] ||= { days: 0, out: 0, short: 0 }).out += s;
    if (d.out || d.inv) out += `\n${ddmm(date)} · ${staff.map(esc).join(', ') || '—'}${d.out ? ` · списано ${fmt(d.out)}` : ''}${d.inv < 0 ? ` · ❗недостача ${fmt(-d.inv)}` : d.inv > 0 ? ` · излишек ${fmt(d.inv)}` : ''}`;
  }
  if (!Object.keys(people).length) return reply(msg, 'За этот период нет записей со сменами.');
  out += `\n\n<b>По людям</b>\n` + Object.entries(people).sort((a, b) => b[1].short - a[1].short).map(([n, p]) => `• ${esc(n)}: ${p.days} смен · списал ${fmt(p.out)}${p.short ? ` · недостачи в его смены ${fmt(p.short)}` : ''}`).join('\n');
  out += `\n\nКто на смене, бот видит по тем, кто пишет в группу. Точно задать: <code>/shift Валижон, Камрон</code>`;
  return reply(msg, out);
}

// 6. Склады цехов
export async function cmdDept(msg, args, periodFromArgs) {
  const [from, to] = periodFromArgs(args.replace(/кухн\S*|пицц\S*|кондит\S*/gi, '').trim() || 'неделя');
  const only = DEPTS.find(d => norm(args).includes(norm(d).slice(0, 4)));
  const ops = await opsBetween(from, to);
  const prods = await products(); const dp = await dprods();
  let out = `🏭 <b>Цеха ${ddmm(from)}–${ddmm(to)}</b>\n`;
  for (const dept of only ? [only] : DEPTS) {
    let got = 0, wo = 0, inv = 0, rev = 0;
    for (const o of ops) {
      if (o.type === 'move' && (o.dept || 'Кухня') === dept) got += o.items.reduce((a, r) => a + r.sum, 0);
      if (o.loc === dept && o.type === 'out') wo += o.items.reduce((a, r) => a + r.sum, 0);
      if (o.loc === dept && o.type === 'inv') inv += o.items.reduce((a, r) => a + (r.q < 0 ? -r.sum : r.sum), 0);
      if (o.type === 'sales' && o.deptRevenue?.[dept]) rev += o.deptRevenue[dept];
    }
    const stock = Object.entries(dp).filter(([k, v]) => k.startsWith(dept + '|') && v.stock).map(([k, v]) => [k.split('|')[1], v.stock]);
    const sv = stock.reduce((a, [p, s]) => a + Math.max(s, 0) * (prods[p]?.cost || 0), 0);
    if (!got && !wo && !inv && !rev && !stock.length) { out += `\n<b>${dept}</b>: движений нет\n`; continue; }
    out += `\n<b>${dept}</b>\n➡️ получено с бара: ${fmt(got)}\n`;
    if (wo) out += `🗑 списано: ${fmt(wo)}\n`;
    if (inv) out += `📋 инвентаризация: ${inv < 0 ? 'недостача ' + fmt(-inv) : 'излишек ' + fmt(inv)}\n`;
    if (rev) out += `💰 выручка (iiko): ${fmt(rev)} · получено/выручка <b>${(got / rev * 100).toFixed(1)}%</b>\n`;
    if (stock.length) out += `📦 остаток: ${fmt(sv)} сум` + (only ? '\n' + stock.sort().map(([p, s]) => `   • ${esc(p)}: ${fq(s, prods[p]?.unit)}`).join('\n') : '') + '\n';
  }
  out += `\nСписание/инвентаризация цеха — в первой строке укажите цех: <code>Списание кухня</code>, <code>Инвентаризация пиццерия</code>. Остатки цеха: <code>/dept кухня</code>`;
  return reply(msg, out);
}

// 7. Выгрузка в Google Таблицу (IMPORTDATA)
export async function cmdSheet(msg) {
  let t = await redis('GET', 'export_token');
  if (!t) { t = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join(''); await redis('SET', 'export_token', t); }
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || (await redis('GET', 'host')) || 'foodcost-mini-app.vercel.app';
  const u = k => `https://${host}/api/export?t=${t}&kind=${k}`;
  const f = k => `<code>=IMPORTDATA("${u(k)}")</code>`;
  return reply(msg, `📊 <b>Google Таблица</b>
Создайте таблицу на sheets.google.com, сделайте листы и в ячейку A1 каждого вставьте формулу. Данные обновляются сами (примерно раз в час).

<b>Остатки</b> (бар и цеха):
${f('stock')}

<b>Продажи по дням и позициям</b>:
${f('sales')}

<b>Все движения</b> (приход, списание, перемещения, инвентаризации):
${f('ops')}

<b>Цены закупки</b>:
${f('prices')}

Можно добавить период: в конце ссылки <code>&from=2026-11-01&to=2026-11-30</code>.
⚠️ Ссылки дают доступ к цифрам бара — не публикуйте их. Новые ссылки (старые перестанут работать): /sheet_reset`);
}

export async function exportCSV(kind, from, to) {
  const rows = [];
  const prods = await products();
  if (kind === 'stock') {
    rows.push(['Склад', 'Продукт', 'Ед', 'Остаток', 'Цена за ед', 'Сумма']);
    for (const [p, v] of Object.entries(prods).sort()) rows.push(['Бар', p, v.unit, round(v.stock), round(v.cost || 0), Math.round(Math.max(v.stock, 0) * (v.cost || 0))]);
    for (const [k, v] of Object.entries(await dprods()).sort()) { const [d, p] = k.split('|'); if (v.stock) rows.push([d, p, prods[p]?.unit || '', round(v.stock), round(prods[p]?.cost || 0), Math.round(Math.max(v.stock, 0) * (prods[p]?.cost || 0))]); }
  } else if (kind === 'prices') {
    rows.push(['Продукт', 'Дата', 'Поставщик', 'Цена за кг/л/шт']);
    for (const k of ((await redis('KEYS', 'price:*')) || []).sort()) {
      const p = k.slice(6); const mul = ['г', 'мл'].includes(prods[p]?.unit) ? 1000 : 1;
      for (const x of ((await redis('LRANGE', k, 0, -1)) || []).map(JSON.parse)) rows.push([p, x.d, x.s, Math.round(x.u * mul)]);
    }
  } else {
    const ops = await opsBetween(from, to);
    if (kind === 'sales') {
      rows.push(['Дата', 'Код', 'Позиция', 'Кол-во', 'Сумма']);
      for (const o of ops) if (o.type === 'sales') for (const p of o.positions || []) rows.push([o.periodFrom === o.periodTo ? o.date : `${o.periodFrom}..${o.periodTo}`, p.code || '', p.name, p.qty, p.sum]);
    } else {
      const T = { in: 'Приход', out: 'Списание', move: 'Перемещение', inv: 'Инвентаризация', sales: 'Продажи (техкарты)' };
      rows.push(['Дата', 'Операция', 'Цех/куда', 'Кто', 'Продукт', 'Кол-во', 'Ед', 'Сумма']);
      for (const o of ops) for (const r of o.items) rows.push([o.date, T[o.type], o.loc || o.dept || '', o.userName || '', r.p, r.q, r.unit, r.sum]);
    }
  }
  return rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
}

// Еженедельная сводка (понедельник): закупка, перерасход цехов, смены
export async function weeklyDigest(fake, periodFromArgs) {
  await cmdOrder(fake, '7');
  const over = await deptOveruse();
  if (over.length) await reply(fake, '📈 <b>Цеха взяли больше обычного</b> (неделя против среднего за 3 недели)\n' + over.slice(0, 12).map(o => `• ${o.dept}: ${esc(o.p)} — ${fq(o.now, o.unit)} вместо ~${fq(o.avg, o.unit)} (+${o.pct}%)${o.sum ? ' · ' + fmt(o.sum) : ''}`).join('\n'));
  await cmdShifts(fake, 'неделя', periodFromArgs);
}

// Четверг — последний день заказов поставщикам
const THU_MORNING = [
  '🚨🚨🚨 <b>ЧЕТВЕРГ, БЛЯТЬ!</b>\nСегодня последний день, когда фирмы принимают заказы. Не закажешь — до следующей недели будешь объяснять гостям, почему колы нет. Сам будешь рожать, ага.',
  '⏰ <b>ЭЙ, СТОЙ. СЕГОДНЯ ЧЕТВЕРГ.</b>\nКрайний день заказов. Кола, Чорток и остальные ждут. Заказал — красавчик. Не заказал — неделю без товара, и это будет на тебе.',
  '📢 <b>ЧЕТВЕРГ! ЗАКАЗЫ!</b>\nПоследний шанс отдать заявки фирмам. Потом только бегать по магазинам с пакетом и материться.',
];
const THU_LAST = '🔥 <b>ЧЕТВЕРГ, 15:00, А ПРИХОДА ВСЁ ЕЩЁ НЕТ.</b>\nЗаказы фирмам до сих пор не внесены. Позвони поставщикам ПРЯМО СЕЙЧАС, пока они не ушли домой. Потом внеси приход — и я отстану.';

export async function thursdayReminder(fake, stage = 'morning') {
  if (stage === 'last') {
    const ops = await opsBetween(shift(today(), -2), today());
    if (ops.some(o => o.type === 'in' && o.supplier)) return 'ok, заказы внесены';
    await reply(fake, THU_LAST);
  } else {
    await reply(fake, THU_MORNING[Math.floor(Math.random() * THU_MORNING.length)]);
  }
  await cmdOrder(fake, '7');
  return 'sent';
}
export const wednesdayHeadsUp = fake => reply(fake, '👀 Завтра <b>четверг</b> — последний день заказов поставщикам. Проверь остатки: /order');
