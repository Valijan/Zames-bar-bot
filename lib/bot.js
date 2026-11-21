import { redis, getJSON, setJSON, hsetJSON } from './redis.js';
import { norm, detectHeader, detectDept, parseItems, parseLine, toBase, parseDate } from './parse.js';
import { ensureSeed, products, techcards, aliases, findProduct, addOp, opsBetween, applyMoves, undoLast, today, round } from './store.js';
import { reply, sendFile, downloadFile, esc, react } from './telegram.js';
import { readSalesPhoto, readItemsPhoto, readAnyPhoto, testGemini } from './vision.js';
import { notifyOwner, lowStock, priceAlertText, cmdOrder, cmdPrices, cmdCalc, cmdShift, cmdShifts, cmdDept, cmdSheet, weeklyDigest } from './extra.js';
import { dprods, applyDept, DEPTS } from './store.js';
import { tg } from './telegram.js';

// В группе без команды бот не пишет — только ставит реакцию. QUIET=0 включает текстовые ответы.
const quiet = msg => process.env.QUIET !== '0' && msg.chat.type !== 'private';
async function problem(msg, text) {
  await redis('RPUSH', `problems:${msg.chat.id}`, JSON.stringify({ t: Date.now(), who: userName(msg), text: text.slice(0, 600) }));
}
// Отчёты — в личку тому, кто спросил (в группе молчим)
const PRIVATE_CMDS = new Set(['/order', '/prices', '/calc', '/shifts', '/dept', '/sheet', '/sheet_reset', '/month', '/report', '/foodcost', '/stock', '/log', '/problems', '/tk']);
function toPrivate(msg) {
  return { ...msg, chat: { id: msg.from.id, type: 'private' }, is_topic_message: false, message_id: undefined, _orig: msg };
}
const say = (msg, text, emoji = '👍') => quiet(msg) ? react(msg, emoji) : reply(msg, text);

const TYPE_NAMES = { in: 'Приход', out: 'Списание', move: 'Перемещение', inv: 'Инвентаризация', sales: 'Продажи' };
const fmt = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fq = (q, u) => {
  const a = Math.abs(q);
  if (u === 'г' && a >= 1000) return `${round(q / 1000)} кг`;
  if (u === 'мл' && a >= 1000) return `${round(q / 1000)} л`;
  return `${round(q)} ${u}`;
};
const ddmm = d => d.slice(8, 10) + '.' + d.slice(5, 7);

const HELP = `<b>Бот учёта бара</b>

В группе бот молчит: записал — ставит 👍, не понял — 🤔 (смотрите /problems). Фото тоже читает: отчёт iiko в «Продажах», накладные и списки в остальных темах.

Пишите в темах группы — бот понимает тип по названию темы («Приход», «Списание», «Перемещение», «Продажи», «Инвентаризация») или по первому слову сообщения.

<b>Приход</b> (сумма — за всю строку):
<code>Приход
Молоко 10 л 120 000
Лимон 3 кг 45000
Кола 24 шт</code>

<b>Списание</b>:
<code>Списание
Молоко 1 л прокисло</code>

<b>Перемещение</b> (кухня / пиццерия / кондитерская):
<code>Перемещение на кухню
Сливки 10% 1 л
Лимон 500 г</code>

<b>Продажи</b> — фото отчёта iiko «Общие продажи блюд» (можно несколько фото подряд), потом /done.

<b>Инвентаризация</b> — фактические остатки:
<code>Инвентаризация
Молоко 4 л
Ассам 350 г</code>

<b>Команды</b>
/stock — остатки
/report 16.11-20.11 — отчёт за период (без даты — сегодня; «неделя», «месяц»)
/foodcost 16.11-20.11 — фудкост по позициям
/tk ассам — техкарта
/price Молоко 1 л 12000 — цена закупки вручную
/alias сгущенка = Сгущённое молоко — как ещё пишут продукт
/undo — отменить вашу последнюю операцию
/month — продажи за месяц (/month 11.2026, /month прошлый)
/log — последние записи
/order — что заказать (на 7 дней, <code>/order 14</code>)
/prices — где дешевле, история цен (<code>/prices молоко</code>)
/calc — себестоимость и цена новой позиции по рецепту
/shift Валижон, Камрон — кто на смене; /shifts — смены, списания и недостачи по людям
/dept — склады кухни, пиццерии, кондитерской (<code>/dept кухня</code>)
/sheet — ссылки для Google Таблицы
/problems — что бот не понял (он ставит 🤔)
/id — id этого чата

Отчёты (/report, /foodcost, /stock, /log, /problems) бот присылает в личку. Каждое утро в 9:00 — отчёт за вчера, 1-го числа — итоги месяца.

<b>В личке</b> просто присылайте фото: отчёт продаж iiko — внесу продажи, остатки — проведу инвентаризацию, накладную — приход (подпись «списание»/«перемещение кухня» поменяет тип).`;

export async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const allowed = (process.env.ALLOWED_CHATS || '').split(',').map(s => s.trim()).filter(Boolean);
  const text = (msg.text || msg.caption || '').trim();
  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : null;

  if (cmd === '/id') return reply(msg, `id чата: <code>${msg.chat.id}</code>`);
  if (allowed.length && !allowed.includes(String(msg.chat.id))) return;
  await ensureSeed();

  const args = cmd ? text.replace(/^\/\S+[ \t]*/, '').trim() : '';
  let m = msg;
  if (cmd && PRIVATE_CMDS.has(cmd) && msg.chat.type !== 'private') {
    m = toPrivate(msg);
    m.chatId = msg.chat.id; // группа, к которой относится отчёт (для /problems)
  }
  if (msg.chat.type === 'private' && (cmd === '/start' || cmd === '/owner')) await redis('SET', 'owner', String(msg.from.id));
  try {
    switch (cmd) {
      case '/start': case '/help': return reply(msg, HELP);
      case '/stock': return privateRun(msg, () => cmdStock(m, args));
      case '/report': return privateRun(msg, () => cmdReport(m, args));
      case '/foodcost': return privateRun(msg, () => cmdFoodcost(m, args));
      case '/tk': return privateRun(msg, () => cmdTk(m, args));
      case '/price': return cmdPrice(msg, args);
      case '/alias': return cmdAlias(msg, args);
      case '/undo': return cmdUndo(msg);
      case '/done': return finishSales(msg, args);
      case '/cancel': await redis('DEL', `pend:${msg.chat.id}`); return reply(msg, 'Черновик продаж очищен.');
      case '/sales': return salesText(msg, args);
      case '/topic': return cmdTopic(msg, args);
      case '/gemini': return cmdGemini(msg, args);
      case '/month': return privateRun(msg, () => cmdMonth(m, args));
      case '/order': return privateRun(msg, () => cmdOrder(m, args));
      case '/prices': return privateRun(msg, () => cmdPrices(m, args));
      case '/calc': return privateRun(msg, () => cmdCalc(m, args));
      case '/shift': return cmdShift(msg, args);
      case '/shifts': return privateRun(msg, () => cmdShifts(m, args, periodFromArgs));
      case '/dept': return privateRun(msg, () => cmdDept(m, args, periodFromArgs));
      case '/sheet': case '/sheet_reset': {
        const owner = await redis('GET', 'owner');
        if (owner && owner !== String(msg.from.id)) return privateRun(msg, () => reply(m, 'Ссылки на таблицу выдаются только владельцу бота.'));
        if (cmd === '/sheet_reset') await redis('DEL', 'export_token');
        return privateRun(msg, () => cmdSheet(m));
      }
      case '/log': return privateRun(msg, () => cmdLog(m, args));
      case '/problems': return privateRun(msg, () => cmdProblems(m));
    }
    if (cmd) return;
    if (msg.chat.type === 'private' && /^(AIza[\w-]{20,}|AQ\.[\w.\-]{20,})$/.test(text)) return cmdGemini(msg, text);

    const topic = await topicInfo(msg);
    const head = detectHeader(text);
    const type = head.type || topic.type;

    if (msg.photo || (msg.document && /image/.test(msg.document.mime_type || ''))) {
      if (type === 'sales' || /продаж|iiko/i.test(text)) return salesPhoto(msg);
      const tDept = detectDept(topic.name || '') || topic.dept;
      if (type) return photoMovement(msg, type, type === 'move' ? (head.dept || tDept) : (detectDept(text) || tDept));
      if (msg.chat.type === 'private') return privatePhoto(msg, text);
      return;
    }
    if (!text || !type) return; // обычная переписка — молчим
    if (type === 'sales') return salesText(msg, head.type ? text.split('\n').slice(1).join('\n') : text);
    const topicDept = detectDept(topic.name || '') || topic.dept;
    const dept = type === 'move' ? (head.dept || topicDept) : (detectDept(text.split('\n')[0]) || topicDept);
    return movement(msg, type, dept, text, !!head.type);
  } catch (e) {
    console.error(e);
    const t = e.message === 'NO_GEMINI_KEY' ? 'Фото не прочитано: в Vercel не добавлен GEMINI_API_KEY' : 'Ошибка: ' + e.message;
    if (cmd || !quiet(msg)) return reply(msg, '⚠️ ' + esc(t));
    await problem(msg, t);
    return react(msg, '🤔');
  }
}

// Тип темы: по названию темы (Telegram присылает его в reply_to_message.forum_topic_created) или по /topic
async function topicInfo(msg) {
  const key = `${msg.chat.id}:${msg.message_thread_id || 0}`;
  const saved = await getJSON(`topic:${key}`);
  if (saved) return saved;
  const name = msg.reply_to_message?.forum_topic_created?.name || '';
  if (name) {
    const t = { name, type: detectHeader(name).type, dept: detectDept(name) };
    await setJSON(`topic:${key}`, t);
    return t;
  }
  return {};
}

async function cmdTopic(msg, args) {
  const h = detectHeader(args);
  if (!h.type) return reply(msg, 'Напишите так: <code>/topic списание</code> (или приход, перемещение кухня, продажи, инвентаризация)');
  await setJSON(`topic:${msg.chat.id}:${msg.message_thread_id || 0}`, { name: args, type: h.type, dept: h.dept });
  return reply(msg, `Эта тема теперь: <b>${TYPE_NAMES[h.type]}${h.dept ? ' → ' + h.dept : ''}</b>`);
}

const who = msg => String(msg.from?.id || 0);
const userName = msg => [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || '';

// ---------- приход / списание / перемещение / инвентаризация ----------
// Личка: бот сам понимает, что на фото (продажи iiko / остатки / накладная). Подпись может подсказать.
async function privatePhoto(msg, caption) {
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const buf = await downloadFile(fileId); const mime = msg.document?.mime_type || 'image/jpeg';
  const h = detectHeader(caption || '');
  if (/остат/i.test(caption)) h.type = 'inv';
  if (h.type && h.type !== 'sales') return photoMovement(msg, h.type, h.dept, { buf, mime });
  const d = await readAnyPhoto(buf, mime);
  if (h.type === 'sales' || d.kind === 'sales') return addToPending(msg, d);
  const items = (d.items || []).filter(i => i.name && +i.qty).map(i => ({ name: String(i.name), qty: +i.qty, unit: i.unit ? String(i.unit).toLowerCase().replace('.', '') : null, price: +i.sum || null }));
  if (d.kind === 'stock') return movement(msg, 'inv', null, d.date || '', false, { items, bad: [] }, '📷 ');
  const type = d.type || 'in';
  return movement(msg, type, d.dept || null, d.date || '', false, { items, bad: [], supplier: d.supplier }, '📷 ');
}

async function photoMovement(msg, type, dept, got) {
  if (got) {
    const data = await readItemsPhoto(got.buf, got.mime);
    const items = (data.items || []).filter(i => i.name && +i.qty).map(i => ({ name: String(i.name), qty: +i.qty, unit: i.unit ? String(i.unit).toLowerCase().replace('.', '') : null, price: +i.sum || null }));
    return movement(msg, type, dept || data.dept || null, (data.date || '') + '\n' + (msg.caption || ''), false, { items, bad: [], supplier: data.supplier }, '📷 ');
  }
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const data = await readItemsPhoto(await downloadFile(fileId), msg.document?.mime_type || 'image/jpeg');
  const items = (data.items || []).filter(i => i.name && +i.qty).map(i => ({ name: String(i.name), qty: +i.qty, unit: i.unit ? String(i.unit).toLowerCase().replace('.', '') : null, price: +i.sum || null }));
  const hdr = (data.date ? data.date + '\n' : '') + (msg.caption || '');
  return movement(msg, type, dept || data.dept || null, hdr, false, { items, bad: [], supplier: data.supplier }, '📷 ');
}

async function movement(msg, type, dept, text, hasHeader, pre, tag = '') {
  const { items, bad } = pre || parseItems(text, hasHeader);
  if (!items.length) {
    if (pre) { await problem(msg, `${TYPE_NAMES[type]}: на фото не нашёл строк с продуктами`); return say(msg, 'На фото не нашёл строк с продуктами', '🤔'); }
    if (hasHeader) { await problem(msg, `${TYPE_NAMES[type]}: не понял сообщение «${text.slice(0, 80)}»`); return say(msg, 'Не нашёл ни одной строки вида «Продукт 2 кг». Пример: <code>Молоко 2 л</code>', '🤔'); }
    return;
  }
  if (type === 'move' && !dept) dept = 'Кухня';
  const date = parseDate(text.split('\n')[0], +today().slice(0, 4)) || today();
  // поставщик: «Приход Макро» в первой строке или с фото накладной
  let supplier = pre?.supplier || '';
  if (type === 'in' && hasHeader && !supplier) supplier = text.split('\n')[0].replace(/^\s*(приход\S*|поступлен\S*|закуп\S*|принял\S*)/i, '').replace(/\d{1,2}\.\d{1,2}(\.\d{2,4})?/, '').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim();
  if (supplier.length > 40 || /\d+\s*(кг|г|л|мл|шт)/i.test(supplier)) supplier = '';
  const loc = (type === 'out' || type === 'inv') && dept ? dept : null; // склад цеха
  const prods = await products(); const al = await aliases();
  const moves = [], notes = [], unknown = [];
  for (const it of items) {
    let name = findProduct(it.name, prods, al);
    let [q, bu] = toBase(it.qty, it.unit);
    if (!name) {
      if (type !== 'in') { unknown.push(it.name); continue; }
      name = it.name.charAt(0).toUpperCase() + it.name.slice(1);
      prods[name] = { unit: bu || 'шт', stock: 0, cost: 0 };
      notes.push(`новый продукт «${esc(name)}» (${prods[name].unit})`);
    }
    const pu = prods[name].unit;
    if (!bu) { // единица не указана
      if (pu !== 'шт' && it.qty <= 30) { q = it.qty * 1000; notes.push(`${esc(name)}: ${it.qty} без единицы — считал как ${pu === 'г' ? 'кг' : 'л'}`); }
      bu = pu;
    }
    if (bu !== pu && !(['г', 'мл'].includes(bu) && ['г', 'мл'].includes(pu))) { unknown.push(`${it.name} (единица ${it.unit} ≠ ${pu})`); continue; }
    const m = { p: name, unit: pu };
    if (type === 'in') { m.delta = q; if (it.price) m.price = it.price; }
    else if (type === 'inv') m.setTo = q;
    else m.delta = -q;
    moves.push(m);
  }
  if (!moves.length) { await problem(msg, `${TYPE_NAMES[type]}: не нашёл продукты ${unknown.join(', ')}`); return say(msg, `Не нашёл продукты: ${unknown.map(esc).join(', ')}.\nДобавьте так: <code>/alias как пишете = Название из /stock</code>`, '🤔'); }
  let res, prev, alerts = [];
  if (loc) {
    ({ res, prev } = await applyDept(loc, moves, prods));
    if (type === 'inv') { const dp = await dprods(); for (const r of res) r.fact = dp[`${loc}|${r.p}`]?.stock ?? 0; }
  } else {
    ({ res, prev, alerts } = await applyMoves(moves, prods, { supplier, date }));
    if (type === 'move') await applyDept(dept, res.map(r => ({ p: r.p, delta: -r.q, unit: r.unit })), prods); // пополнить склад цеха
  }
  await addOp({ type, dept: loc ? null : dept, loc, supplier: supplier || undefined, date, user: who(msg), userName: userName(msg), items: res, prev, raw: text.slice(0, 500) });
  if (alerts.length) await notifyOwner(await priceAlertText(alerts));

  const sign = type === 'in' ? '+' : '';
  let out = `✅ ${tag}<b>${TYPE_NAMES[type]}${loc ? ' · склад ' + loc : dept ? ' → ' + dept : ''}</b>${supplier ? ' · ' + esc(supplier) : ''} · ${ddmm(date)}\n`;
  let total = 0;
  for (const r of res) {
    total += r.sum;
    if (type === 'inv') {
      const d = r.q;
      out += `• ${esc(r.p)}: факт ${fq(loc ? r.fact : prods[r.p].stock, r.unit)} (${d === 0 ? 'сошлось' : d > 0 ? 'излишек +' + fq(d, r.unit) : 'недостача ' + fq(d, r.unit)}${d && !r.noCost ? ', ' + fmt(r.sum) + ' сум' : ''})\n`;
    } else out += `• ${esc(r.p)}: ${sign}${fq(r.q, r.unit)}${r.noCost ? '' : ` · ${fmt(r.sum)} сум`}\n`;
  }
  if (type !== 'inv' && total) out += `Итого: <b>${fmt(total)} сум</b>\n`;
  if (notes.length) out += `\nℹ️ ${notes.join('\n• ')}\n`;
  if (unknown.length) out += `\n❓ Не нашёл: ${unknown.map(esc).join(', ')} — <code>/alias как пишете = Название</code>\n`;
  if (bad.length) out += `\n❓ Не понял строки: ${bad.map(esc).join(' | ')}\n`;
  out += `\nОшиблись? /undo`;
  if (unknown.length || bad.length) await problem(msg, `${TYPE_NAMES[type]}: ${unknown.length ? 'не нашёл ' + unknown.join(', ') : ''} ${bad.length ? 'не понял: ' + bad.join(' | ') : ''}`);
  return say(msg, out, unknown.length || bad.length ? '🤔' : '👍');
}

// ---------- продажи ----------
async function salesPhoto(msg) {
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const buf = await downloadFile(fileId);
  const data = await readSalesPhoto(buf, msg.document?.mime_type || 'image/jpeg');
  return addToPending(msg, data);
}

async function addToPending(msg, data) {
  const key = `pend:${msg.chat.id}`;
  const p = (await getJSON(key)) || { rows: {}, from: null, to: null, totals: {} };
  const yr = +today().slice(0, 4);
  if (data.from) p.from = parseDate(data.from, yr);
  if (data.to) p.to = parseDate(data.to, yr);
  Object.assign(p.totals, data.totals || {});
  let added = 0;
  p.drows ||= {};
  for (const r of data.rows || []) {
    if (r.section && !/бар/i.test(r.section)) {
      const dep = /кондит/i.test(r.section) ? 'Кондитерская' : /пицц/i.test(r.section) ? 'Пиццерия' : /кухн/i.test(r.section) ? 'Кухня' : null;
      if (dep) p.drows[`${dep}|${r.code || norm(r.name)}`] = +r.sum || 0;
      continue;
    }
    const k = String(r.code || norm(r.name));
    if (!p.rows[k]) added++;
    p.rows[k] = { code: r.code ? String(r.code) : null, name: r.name, qty: +r.qty || 0, sum: +r.sum || 0 }; // повтор строки на соседнем фото — перезаписываем
  }
  await setJSON(key, p);
  const n = Object.keys(p.rows).length;
  const sum = Object.values(p.rows).reduce((a, r) => a + r.sum, 0);
  const chk = p.totals['Бар'] ? (Math.abs(p.totals['Бар'] - sum) < 1 ? ` ✅ сходится с «Итого Бар»` : ` (в отчёте «Итого Бар» ${fmt(p.totals['Бар'])})`) : '';
  if (p.totals['Бар'] && Math.abs(p.totals['Бар'] - sum) < 1 && p.from) return finishSales(msg, '', true);
  if (quiet(msg) && !msg.text?.startsWith('/')) return react(msg, '✍');
  return reply(msg, `📸 Добавил ${added} новых строк. В черновике ${n} позиций бара на <b>${fmt(sum)} сум</b>${chk}.\nПериод: ${p.from ? ddmm(p.from) : '?'}–${p.to ? ddmm(p.to) : '?'}\n\nЕщё фото — шлите. Всё? /done (можно указать дату: <code>/done 20.11</code>). Сбросить — /cancel`);
}

async function salesText(msg, body) {
  if (!body.trim()) return reply(msg, 'Формат: <code>/sales 20.11\n178 32 1590000\nКапучино 16 720000</code>\n(код или название, кол-во, сумма)');
  const lines = body.split('\n');
  const tks = await techcards();
  const yr = +today().slice(0, 4);
  const data = { rows: [] };
  if (/^\s*\d{1,2}\.\d{1,2}(\.\d{2,4})?\s*$/.test(lines[0])) data.from = data.to = lines.shift().trim();
  for (const l of lines) {
    const m = l.trim().match(/^(.*?)\s+(\d+(?:[.,]\d+)?)(?:\s*[xх×]\s*\d+)?(?:\s+([\d\s]+))?$/);
    if (!m) continue;
    let code = null; const nm = m[1].trim();
    if (/^\d+$/.test(nm) && tks[nm]) code = nm;
    else code = Object.keys(tks).find(c => norm(tks[c].name) === norm(nm)) || null;
    data.rows.push({ code, name: code ? tks[code].name : nm, qty: parseFloat(m[2].replace(',', '.')), sum: m[3] ? +m[3].replace(/\s/g, '') : 0 });
  }
  return addToPending(msg, data);
}

async function finishSales(msg, args, auto = false) {
  const key = `pend:${msg.chat.id}`;
  const p = await getJSON(key);
  if (!p || !Object.keys(p.rows).length) return reply(msg, 'Черновик продаж пуст. Пришлите фото отчёта iiko.');
  const yr = +today().slice(0, 4);
  const dates = (args.match(/\d{1,2}\.\d{1,2}(\.\d{2,4})?/g) || []).map(d => parseDate(d, yr));
  const from = dates[0] || p.from || today();
  const to = dates[1] || (dates[0] ? dates[0] : p.to) || from;
  const force = /force|заново|перезап/i.test(args);

  const prior = (await opsBetween(from, '9999-12-31')).filter(o => o.type === 'sales' && !(o.periodTo < from || o.periodFrom > to));
  if (prior.length && !force && auto) { await redis('DEL', key); await problem(msg, `Продажи ${ddmm(from)}–${ddmm(to)} уже были внесены — фото не учтено`); return react(msg, '🤔'); }
  if (prior.length && !force) return reply(msg, `⚠️ Продажи за ${ddmm(prior[0].periodFrom)}–${ddmm(prior[0].periodTo)} уже внесены. Чтобы не задвоить расход, сначала /undo (тем, кто вносил) или <code>/done ${ddmm(from)}-${ddmm(to)} force</code>.`);

  const tks = await techcards(); const prods = await products();
  const cons = {}; const noTk = []; let revenue = 0; const positions = [];
  for (const r of Object.values(p.rows)) {
    revenue += r.sum;
    const tk = r.code && tks[r.code] || Object.values(tks).find(t => norm(t.name) === norm(r.name));
    positions.push({ code: r.code, name: tk ? tk.name : r.name, qty: r.qty, sum: r.sum, tk: !!tk });
    if (!tk) { if (r.sum || r.qty) noTk.push(r.name); continue; }
    for (const [ing, n] of tk.items) cons[ing] = (cons[ing] || 0) + n * r.qty;
  }
  const moves = Object.entries(cons).map(([pName, q]) => ({ p: pName, delta: -q, unit: prods[pName]?.unit }));
  const { res, prev } = await applyMoves(moves, prods);
  const cost = res.reduce((a, r) => a + r.sum, 0);
  const deptRevenue = {};
  for (const [k, v] of Object.entries(p.drows || {})) { const d = k.split('|')[0]; deptRevenue[d] = (deptRevenue[d] || 0) + v; }
  await addOp({ type: 'sales', date: to, periodFrom: from, periodTo: to, user: who(msg), userName: userName(msg), items: res, prev, revenue, positions, deptRevenue });
  await redis('DEL', key);

  let out = `✅ <b>Продажи ${ddmm(from)}–${ddmm(to)}</b> внесены\nВыручка бара: <b>${fmt(revenue)} сум</b>\nСписано по техкартам: ${res.length} продуктов`;
  if (cost) out += ` на ${fmt(cost)} сум\nФудкост: <b>${(cost / revenue * 100).toFixed(1)}%</b>`;
  const noCost = res.filter(r => r.noCost).length;
  if (noCost) out += `\nℹ️ У ${noCost} продуктов ещё нет цены закупки — фудкост посчитается после приходов с суммой или /price`;
  if (noTk.length) out += `\n❓ Нет техкарты: ${noTk.slice(0, 15).map(esc).join(', ')}`;
  const neg = res.filter(r => prods[r.p].stock < 0);
  if (neg.length) out += `\n⚠️ Ушли в минус (нужна инвентаризация или приход): ${neg.slice(0, 10).map(r => esc(r.p)).join(', ')}${neg.length > 10 ? '…' : ''}`;
  out += `\n\nПодробно: /report ${ddmm(from)}-${ddmm(to)}`;
  if (noTk.length) await problem(msg, `Продажи ${ddmm(from)}–${ddmm(to)}: нет техкарты для ${noTk.join(', ')}`);
  if (auto && quiet(msg)) return react(msg, '👍');
  return reply(msg, out);
}

// ---------- отчёты ----------
function periodFromArgs(args) {
  const t = today(); const yr = +t.slice(0, 4);
  const ds = (args.match(/\d{1,2}\.\d{1,2}(\.\d{2,4})?/g) || []).map(d => parseDate(d, yr));
  if (ds.length >= 2) return [ds[0], ds[1]];
  if (ds.length === 1) return [ds[0], ds[0]];
  const shift = n => { const d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  if (/недел/i.test(args)) return [shift(6), t];
  if (/месяц/i.test(args)) return [t.slice(0, 8) + '01', t];
  if (/вчера/i.test(args)) return [shift(1), shift(1)];
  return [t, t];
}

async function cmdReport(msg, args) {
  const [from, to] = periodFromArgs(args);
  const ops = await opsBetween(from, to);
  const prods = await products();
  const agg = {}; const A = (p, k, q, s) => { const a = agg[p] ||= { in: [0, 0], out: [0, 0], 'Кухня': [0, 0], 'Пиццерия': [0, 0], 'Кондитерская': [0, 0], sales: [0, 0], inv: [0, 0] }; a[k][0] += q; a[k][1] += s; };
  const tot = { in: 0, out: 0, move: {}, sales: 0, inv: 0, revenue: 0 };
  for (const o of ops) for (const r of o.items) {
    if (o.type === 'in') { A(r.p, 'in', r.q, r.sum); tot.in += r.sum; }
    if (o.type === 'out') { A(r.p, 'out', -r.q, r.sum); tot.out += r.sum; }
    if (o.type === 'move') { const d = o.dept || 'Кухня'; A(r.p, d in { 'Кухня': 1, 'Пиццерия': 1, 'Кондитерская': 1 } ? d : 'Кухня', -r.q, r.sum); tot.move[d] = (tot.move[d] || 0) + r.sum; }
    if (o.type === 'sales') { A(r.p, 'sales', -r.q, r.sum); tot.sales += r.sum; }
    if (o.type === 'inv') { const s = r.q >= 0 ? r.sum : -r.sum; A(r.p, 'inv', r.q, s); tot.inv += s; }
  }
  for (const o of ops) if (o.type === 'sales') tot.revenue += o.revenue || 0;

  let out = `📊 <b>Отчёт бара ${ddmm(from)}${to !== from ? '–' + ddmm(to) : ''}</b>\n\n`;
  out += `💰 Выручка бара: <b>${fmt(tot.revenue)}</b>\n`;
  out += `🍹 Расход по техкартам: ${fmt(tot.sales)}${tot.revenue && tot.sales ? ` · фудкост <b>${(tot.sales / tot.revenue * 100).toFixed(1)}%</b>` : ''}\n`;
  out += `📥 Приход: ${fmt(tot.in)}\n🗑 Списание: ${fmt(tot.out)}\n`;
  for (const [d, s] of Object.entries(tot.move)) out += `➡️ ${d}: ${fmt(s)}\n`;
  if (tot.inv) out += `📋 Инвентаризация: ${tot.inv >= 0 ? 'излишек ' : 'недостача '}${fmt(Math.abs(tot.inv))}\n`;
  const top = (k, n = 5) => Object.entries(agg).filter(([, a]) => a[k][1] > 0).sort((a, b) => b[1][k][1] - a[1][k][1]).slice(0, n);
  const block = (title, k) => { const t = top(k); if (!t.length) return ''; return `\n<b>${title}</b>\n` + t.map(([p, a]) => `• ${esc(p)}: ${fq(a[k][0], prods[p]?.unit || '')} · ${fmt(a[k][1])}`).join('\n') + '\n'; };
  out += block('Топ списаний', 'out') + block('Больше всего ушло на кухню', 'Кухня') + block('В пиццерию', 'Пиццерия') + block('В кондитерскую', 'Кондитерская') + block('Дороже всего по техкартам', 'sales');
  if (!ops.length) out += '\nЗа этот период операций нет.';
  const noCost = Object.values(prods).filter(p => !p.cost).length;
  if (noCost) out += `\nℹ️ Без цены закупки: ${noCost} продуктов — суммы по ним 0.`;
  await reply(msg, out);

  if (ops.length) {
    const head = ['Продукт', 'Ед.', 'Приход', 'Приход, сум', 'Списание', 'Списание, сум', 'Кухня', 'Кухня, сум', 'Пиццерия', 'Пиццерия, сум', 'Кондитерская', 'Кондитерская, сум', 'Продажи (техкарты)', 'Продажи, сум', 'Инвент. разница', 'Инвент., сум', 'Остаток сейчас', 'Цена за ед.'];
    const rows = Object.entries(agg).sort().map(([p, a]) => [p, prods[p]?.unit || '', ...['in', 'out', 'Кухня', 'Пиццерия', 'Кондитерская', 'sales', 'inv'].flatMap(k => [round(a[k][0]), Math.round(a[k][1])]), prods[p]?.stock ?? '', prods[p]?.cost ? round(prods[p].cost) : '']);
    const csv = [head, ...rows].map(r => r.map(v => typeof v === 'number' ? String(v).replace('.', ',') : /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(';')).join('\n');
    await sendFile(msg, `otchet_bar_${from}_${to}.csv`, csv, 'Подробно по каждому продукту (открывается в Excel)');
  }
}

async function cmdFoodcost(msg, args) {
  const [from, to] = periodFromArgs(args.trim() ? args : 'неделя');
  const ops = (await opsBetween(from, to)).filter(o => o.type === 'sales');
  const tks = await techcards(); const prods = await products();
  const pos = {};
  for (const o of ops) for (const p of o.positions || []) { const a = pos[p.code || p.name] ||= { name: p.name, code: p.code, qty: 0, sum: 0 }; a.qty += p.qty; a.sum += p.sum; }
  const rows = [];
  for (const a of Object.values(pos)) {
    const tk = a.code && tks[a.code]; if (!tk || !a.qty) continue;
    let c = 0, miss = false;
    for (const [ing, n] of tk.items) { const pr = prods[ing]; if (!pr?.cost) miss = true; c += n * (pr?.cost || 0); }
    const price = a.sum / a.qty;
    rows.push({ ...a, cost: c, price, fc: price ? c / price * 100 : 0, miss, approx: tk.approx });
  }
  if (!rows.length) return reply(msg, `Нет продаж за ${ddmm(from)}–${ddmm(to)}. Пришлите фото отчёта iiko в тему «Продажи».`);
  rows.sort((a, b) => b.fc - a.fc);
  let out = `🧮 <b>Фудкост по позициям ${ddmm(from)}–${ddmm(to)}</b>\n(себестоимость порции / цена)\n\n`;
  out += rows.slice(0, 40).map(r => `${r.fc > 35 ? '🔴' : r.fc > 25 ? '🟡' : '🟢'} ${esc(r.name)}: ${r.fc.toFixed(0)}% · ${fmt(r.cost)} из ${fmt(r.price)}${r.miss ? ' (не все цены)' : ''}${r.approx ? ' ~' : ''}`).join('\n');
  out += `\n\n~ — примерная норма, «не все цены» — нет цены закупки части ингредиентов.`;
  return reply(msg, out);
}

async function cmdStock(msg, args) {
  const prods = await products();
  const f = norm(args);
  const list = Object.entries(prods).filter(([n]) => !f || norm(n).includes(f)).sort();
  if (!list.length) return reply(msg, 'Ничего не нашёл.');
  let sum = 0;
  const lines = list.map(([n, p]) => { const v = p.stock * (p.cost || 0); sum += Math.max(v, 0); return `${p.stock < 0 ? '⚠️' : '•'} ${esc(n)}: ${fq(p.stock, p.unit)}${p.cost ? ` · ${fmt(v)}` : ''}`; });
  return reply(msg, `📦 <b>Остатки (расчётные)</b>\n${lines.join('\n')}\n\nНа сумму: <b>${fmt(sum)} сум</b>\n⚠️ — минус: расход больше прихода. Сделайте инвентаризацию, чтобы выставить факт.`);
}

async function cmdTk(msg, args) {
  const tks = await techcards();
  const f = norm(args);
  const found = Object.entries(tks).filter(([c, t]) => !f || c === args.trim() || norm(t.name).includes(f));
  if (!found.length) return reply(msg, 'Техкарта не найдена.');
  if (found.length > 8 || !f) return reply(msg, 'Техкарты:\n' + found.map(([c, t]) => `${c} — ${esc(t.name)}`).join('\n'));
  const prods = await products();
  return reply(msg, found.map(([c, t]) => {
    let cost = 0;
    const lines = t.items.map(([ing, n]) => { const pr = prods[ing]; cost += n * (pr?.cost || 0); return `• ${esc(ing)} — ${n} ${pr?.unit || ''}`; });
    return `<b>${esc(t.name)}</b> (код ${c})${t.approx ? ' ~примерная' : ''}\n${lines.join('\n')}\nСебестоимость: ${fmt(cost)} сум`;
  }).join('\n\n'));
}

async function cmdPrice(msg, args) {
  const it = parseLine(args);
  if (!it || !it.price) return reply(msg, 'Формат: <code>/price Молоко 1 л 12000</code> — сколько стоит указанное количество.');
  const prods = await products(); const al = await aliases();
  const name = findProduct(it.name, prods, al);
  if (!name) return reply(msg, `Не нашёл «${esc(it.name)}».`);
  const [q] = toBase(it.qty, it.unit || prods[name].unit);
  prods[name].cost = it.price / q;
  await hsetJSON('prod', name, prods[name]);
  return reply(msg, `💲 ${esc(name)}: ${fmt(it.price)} сум за ${fq(q, prods[name].unit)}`);
}

async function cmdAlias(msg, args) {
  const [a, b] = args.split('=').map(s => s && s.trim());
  if (!a || !b) return reply(msg, 'Формат: <code>/alias сгущенка = Сгущённое молоко</code>');
  const prods = await products();
  const target = findProduct(b, prods, {});
  if (!target) {
    await hsetJSON('prod', b, { unit: 'г', stock: 0, cost: 0 });
    await redis('HSET', 'alias', norm(a), b);
    return reply(msg, `Создал продукт «${esc(b)}» (ед. г) и запомнил: «${esc(a)}» = «${esc(b)}». Если единица другая — внесите приход с нужной единицей.`);
  }
  await redis('HSET', 'alias', norm(a), target);
  return reply(msg, `Запомнил: «${esc(a)}» = «${esc(target)}»`);
}

async function cmdUndo(msg) {
  const op = await undoLast(who(msg));
  if (!op) return reply(msg, 'Нечего отменять (отменяется только ваша последняя операция).');
  return reply(msg, `↩️ Отменил: ${TYPE_NAMES[op.type]} от ${ddmm(op.date)} (${op.items.length} строк). Остатки вернул.`);
}

async function cmdLog(msg, args) {
  const n = Math.min(+args || 10, 30);
  const t = today(); const d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() - 7);
  const ops = (await opsBetween(d.toISOString().slice(0, 10), t)).slice(-n).reverse();
  if (!ops.length) return reply(msg, 'За неделю записей нет.');
  return reply(msg, '🧾 <b>Последние записи</b>\n\n' + ops.map(o => {
    const head = `<b>${TYPE_NAMES[o.type]}${o.dept ? ' → ' + o.dept : ''}</b> · ${ddmm(o.date)}${o.userName ? ' · ' + esc(o.userName) : ''}`;
    if (o.type === 'sales') return `${head}\nвыручка ${fmt(o.revenue)}, списано по техкартам ${o.items.length} продуктов`;
    return head + '\n' + o.items.slice(0, 8).map(r => `• ${esc(r.p)}: ${o.type === 'inv' ? 'разница ' : ''}${fq(r.q, r.unit)}${r.noCost ? '' : ' · ' + fmt(r.sum)}`).join('\n') + (o.items.length > 8 ? `\n…ещё ${o.items.length - 8}` : '');
  }).join('\n\n'));
}

async function cmdProblems(msg) {
  const key = `problems:${msg.chatId || msg.chat.id}`;
  const list = ((await redis('LRANGE', key, 0, -1)) || []).map(s => JSON.parse(s)).slice(-20);
  if (!list.length) return reply(msg, 'Проблем нет 👌');
  await redis('DEL', key);
  return reply(msg, '🤔 <b>Что бот не понял</b> (список очищен)\n\n' + list.map(p => `• ${esc(p.text)}${p.who ? ' — ' + esc(p.who) : ''}`).join('\n') + '\n\nНеизвестный продукт: <code>/alias как пишут = Название</code>');
}

// Выполнить команду с ответом в личку; если бот не может написать — подсказать в группе реакцией
async function privateRun(msg, fn) {
  if (msg.chat.type === 'private') return fn();
  try {
    const r = await fn();
    const flat = [].concat(r || []).flat();
    if (flat.some(x => x && x.ok === false)) throw new Error('no dm');
    return react(msg, '👌');
  } catch (e) {
    return reply(msg, `Отчёт отправляю в личку, но бот не может вам написать. Откройте @${process.env.BOT_USERNAME || 'Food_cost_bot'} и нажмите «Старт», затем повторите команду.`);
  }
}

// Ежедневный отчёт владельцу (вызывается из api/cron.js)
export async function dailyReport() {
  await ensureSeed();
  const owner = await redis('GET', 'owner');
  if (!owner) return 'no owner';
  const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() - 1);
  const y = d.toISOString().slice(0, 10);
  const fake = { chat: { id: +owner, type: 'private' }, from: { id: +owner } };
  await cmdReport(fake, `${ddmm(y)}`);
  if (today().endsWith('-01')) await cmdMonth(fake, 'прошлый');
  const low = await lowStock();
  if (low.length) await reply(fake, '⏳ <b>Скоро закончится</b>\n' + low.slice(0, 15).map(l => `• ${esc(l.p)} — ${l.stock <= 0 ? '<b>уже нет</b>' : `осталось ${fq(l.stock, l.unit)}, хватит на ~${l.left < 1 ? 'сегодня' : Math.floor(l.left) + ' дн.'}`}`).join('\n') + '\n\nЧто заказать: /order');
  if (new Date(today() + 'T12:00:00').getDay() === 1) await weeklyDigest(fake, periodFromArgs);
  const probs = (await redis('KEYS', 'problems:*')) || [];
  for (const k of probs) { const n = ((await redis('LRANGE', k, 0, -1)) || []).length; if (n) await reply(fake, `🤔 В группе ${n} сообщений, которые бот не понял — /problems`); }
  return 'sent';
}

// Отчёт за месяц: что и сколько продали, выручка, себестоимость, фудкост
async function cmdMonth(msg, args) {
  const t = today();
  let y = +t.slice(0, 4), mo = +t.slice(5, 7);
  const m1 = args.match(/(\d{1,2})[.\/-](\d{2,4})/);
  if (m1) { mo = +m1[1]; y = +m1[2] < 100 ? 2000 + +m1[2] : +m1[2]; }
  else if (/прошл/i.test(args)) { mo -= 1; if (!mo) { mo = 12; y -= 1; } }
  const mm = String(mo).padStart(2, '0');
  const from = `${y}-${mm}-01`, to = `${y}-${mm}-31`;
  const NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const ops = (await opsBetween(from, to)).filter(o => o.type === 'sales');
  if (!ops.length) return reply(msg, `За ${NAMES[mo - 1]} ${y} продаж ещё нет. Присылайте фото отчёта iiko каждый день.`);
  const pos = {}; let revenue = 0, cost = 0; const days = new Set();
  for (const o of ops) {
    revenue += o.revenue || 0; cost += o.items.reduce((a, r) => a + r.sum, 0);
    for (let d = new Date(o.periodFrom + 'T12:00:00'); d <= new Date(o.periodTo + 'T12:00:00'); d.setDate(d.getDate() + 1)) days.add(d.toISOString().slice(0, 10));
    for (const p of o.positions || []) { const a = pos[p.code || p.name] ||= { name: p.name, code: p.code || '', qty: 0, sum: 0 }; a.qty += p.qty; a.sum += p.sum; }
  }
  const rows = Object.values(pos).sort((a, b) => b.sum - a.sum);
  let out = `📅 <b>Продажи бара за ${NAMES[mo - 1]} ${y}</b>\nДней с отчётами: ${days.size}\n\n💰 Выручка: <b>${fmt(revenue)} сум</b>\n`;
  if (cost) out += `🍹 Себестоимость по техкартам: ${fmt(cost)} · фудкост <b>${(cost / revenue * 100).toFixed(1)}%</b>\n`;
  out += `\n<b>Топ-15 по выручке</b>\n` + rows.slice(0, 15).map((r, i) => `${i + 1}. ${esc(r.name)} — ${round(r.qty)} шт · ${fmt(r.sum)} (${(r.sum / revenue * 100).toFixed(1)}%)`).join('\n');
  const low = rows.filter(r => r.qty > 0).sort((a, b) => a.qty - b.qty).slice(0, 5);
  if (rows.length > 15) out += `\n\n<b>Продаются хуже всего</b>\n` + low.map(r => `• ${esc(r.name)} — ${round(r.qty)} шт`).join('\n');
  await reply(msg, out);
  const csvRows = [['Код', 'Позиция', 'Кол-во', 'Сумма, сум', 'Ср. цена', 'Доля выручки, %'], ...rows.map(r => [r.code, r.name, round(r.qty), Math.round(r.sum), Math.round(r.qty ? r.sum / r.qty : 0), round(r.sum / revenue * 100)])];
  const csv = csvRows.map(r => r.map(v => typeof v === 'number' ? String(v).replace('.', ',') : /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(';')).join('\n');
  await sendFile(msg, `prodazhi_bar_${y}-${mm}.csv`, csv, `Все позиции за ${NAMES[mo - 1]} (открывается в Excel)`);
}

// Ключ Gemini присылают боту в личку: /gemini AIza...  (только владелец)
async function cmdGemini(msg, args) {
  if (msg.chat.type !== 'private') {
    await tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
    return reply({ ...msg, message_id: undefined }, 'Ключ отправляйте только в личку боту. Сообщение с ключом я удалил.');
  }
  const owner = await redis('GET', 'owner');
  if (owner && owner !== String(msg.from.id)) return reply(msg, 'Ключ может задать только владелец бота.');
  const key = (args.match(/(AIza[\w-]{20,}|AQ\.[\w.\-]{20,})/) || [])[0];
  if (!key) return reply(msg, 'Пришлите ключ из aistudio.google.com/apikey одним сообщением (начинается на AQ. или AIza)');
  const t = await testGemini(key);
  await tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  if (t.error) return reply({ ...msg, message_id: undefined }, '❌ Google не принял ключ: ' + esc(t.error) + '\n\nПерешлите этот ответ в чат с Claude — разберёмся.');
  await redis('SET', 'gemini_key', key);
  await redis('SET', 'gemini_model', t.model);
  if (!owner) await redis('SET', 'owner', String(msg.from.id));
  return reply({ ...msg, message_id: undefined }, '✅ Ключ сохранён и проверен (модель ' + t.model + ')' + (t.warn ? '. Сейчас модели Google перегружены — если фото не прочитается сразу, пришлите его ещё раз через пару минут' : '') + '. Теперь присылайте фото отчётов iiko, остатков и накладных. Сообщение с ключом я удалил.');
}
