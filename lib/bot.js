import { redis, getJSON, setJSON, hsetJSON } from './redis.js';
import { norm, detectHeader, detectDept, parseItems, parseLine, toBase, parseDate, MOVE_RE, guessType } from './parse.js';
import { ensureSeed, products, techcards, aliases, findProduct, addOp, opsBetween, applyMoves, undoLast, revertOp, today, round, packs as packsOf } from './store.js';
import { reply, sendFile, downloadFile, esc, react } from './telegram.js';
import { readSalesPhoto, readItemsPhoto, readAnyPhoto, testGemini } from './vision.js';
import { notifyOwner, lowStock, priceAlertText, cmdOrder, cmdPrices, cmdCalc, cmdShift, cmdShifts, cmdDept, cmdSheet, weeklyDigest, cmdSupplier, thursdayReminder, wednesdayHeadsUp } from './extra.js';
import { dprods, applyDept, DEPTS } from './store.js';
import { tg } from './telegram.js';

// В группе без команды бот не пишет — только ставит реакцию. QUIET=0 включает текстовые ответы.
const quiet = msg => process.env.QUIET !== '0' && msg.chat.type !== 'private';
async function problem(msg, text) {
  await redis('RPUSH', `problems:${msg.chat.id}`, JSON.stringify({ t: Date.now(), who: userName(msg), text: text.slice(0, 600) }));
}
// Отчёты — в личку тому, кто спросил (в группе молчим)
const PRIVATE_CMDS = new Set(['/day', '/del', '/supplier', '/order', '/prices', '/calc', '/shifts', '/dept', '/sheet', '/sheet_reset', '/month', '/report', '/foodcost', '/stock', '/log', '/problems', '/tk']);
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
/day — отчёт за день (<code>/day 21.11</code>, без даты — вчера)
/month — продажи за месяц (/month 11.2026, /month прошлый)
/log — последние записи; /del 2 5 — удалить ошибочные по номерам
/pack Молоко 1 л — фасовка (для «Молоко 12 шт»)
/supplier — какие продукты у какой фирмы (<code>/supplier Нестле: Сливки 10%</code>)
/order — что заказать (на 7 дней, <code>/order 14</code>)
/prices — где дешевле, история цен (<code>/prices молоко</code>)
/calc — себестоимость и цена новой позиции по рецепту
/shift Валижон, Камрон — кто на смене; /shifts — смены, списания и недостачи по людям
/dept — склады кухни, пиццерии, кондитерской (<code>/dept кухня</code>)
/sheet — ссылки для Google Таблицы
/import — загрузить старые сообщения группы: перешлите их в личку или скопируйте пачкой и вставьте одним сообщением
/reset — начать учёт с нуля
/problems — что бот не понял (он ставит 🤔)
/id — id этого чата

Отчёты (/report, /foodcost, /stock, /log, /problems) бот присылает в личку. Каждое утро в 9:00 — отчёт за вчера (если продаж нет — напомню прислать фото), 1-го числа — итоги месяца. В среду — «завтра заказы», в четверг — жёсткое напоминание отдать заказы фирмам (и ещё одно в 15:00, если приходов нет).

<b>В личке</b> просто присылайте фото: отчёт продаж iiko — внесу продажи, остатки — проведу инвентаризацию, накладную — приход (подпись «списание»/«перемещение кухня» поменяет тип).`;

export async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const allowed = (process.env.ALLOWED_CHATS || '').split(',').map(s => s.trim()).filter(Boolean);
  const text = (msg.text || msg.caption || '').trim();
  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : null;

  if (cmd === '/id') return reply(msg, `id чата: <code>${msg.chat.id}</code>`);
  // Telegram повторяет запрос, если бот долго думал (фото) — не обрабатываем одно сообщение дважды
  const seenKey = `seen:${msg.chat.id}:${msg.message_id}`;
  if (!(await redis('SET', seenKey, '1', 'NX', 'EX', '75'))) return; // идёт обработка или уже обработано
  try { return await handleInner(msg, text, cmd); }
  finally { await redis('SET', seenKey, '1', 'EX', '172800').catch(() => {}); }
}

async function handleInner(msg, text, cmd) {
  const allowed = (process.env.ALLOWED_CHATS || '').split(',').map(s => s.trim()).filter(Boolean);
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
      case '/start': case '/help': return await reply(msg, HELP);
      case '/stock': return await privateRun(msg, () => cmdStock(m, args));
      case '/report': return await privateRun(msg, () => cmdReport(m, args));
      case '/foodcost': return await privateRun(msg, () => cmdFoodcost(m, args));
      case '/tk': return await privateRun(msg, () => cmdTk(m, args));
      case '/price': return await cmdPrice(msg, args);
      case '/alias': return await cmdAlias(msg, args);
      case '/undo': return await cmdUndo(msg);
      case '/done': return await finishSales(msg, args);
      case '/cancel': await clearPending(msg.chat.id); return await reply(msg, 'Черновик продаж очищен.');
      case '/sales': return await salesText(msg, args);
      case '/topic': return await cmdTopic(msg, args);
      case '/gemini': return await cmdGemini(msg, args);
      case '/import': return await cmdImport(msg, args);
      case '/pack': return await cmdPack(msg, args);
      case '/reset': return await cmdReset(msg, args);
      case '/del': return await privateRun(msg, () => cmdDel(m, args));
      case '/month': return await privateRun(msg, () => cmdMonth(m, args));
      case '/day': return await privateRun(msg, () => cmdDay(m, args));
      case '/order': return await privateRun(msg, () => cmdOrder(m, args));
      case '/supplier': return await privateRun(msg, () => cmdSupplier(m, args));
      case '/prices': return await privateRun(msg, () => cmdPrices(m, args));
      case '/calc': return await privateRun(msg, () => cmdCalc(m, args));
      case '/shift': return await cmdShift(msg, args);
      case '/shifts': return await privateRun(msg, () => cmdShifts(m, args, periodFromArgs));
      case '/dept': return await privateRun(msg, () => cmdDept(m, args, periodFromArgs));
      case '/sheet': case '/sheet_reset': {
        const owner = await redis('GET', 'owner');
        if (owner && owner !== String(msg.from.id)) return await privateRun(msg, () => reply(m, 'Ссылки на таблицу выдаются только владельцу бота.'));
        if (cmd === '/sheet_reset') await redis('DEL', 'export_token');
        return await privateRun(msg, () => cmdSheet(m));
      }
      case '/log': return await privateRun(msg, () => cmdLog(m, args));
      case '/problems': return await privateRun(msg, () => cmdProblems(m));
    }
    if (cmd) return;
    if (msg.chat.type === 'private' && (msg.forward_origin || msg.forward_date)) return await importForward(msg, text);
    if (msg.chat.type === 'private' && PASTE_HEAD.test(text)) return await importPaste(msg, text);
    if (msg.chat.type === 'private' && /^(AIza[\w-]{20,}|AQ\.[\w.\-]{20,})$/.test(text)) return await cmdGemini(msg, text);

    const topic = await topicInfo(msg);
    const head = detectHeader(text);
    const type = head.type || topic.type;

    if (msg.photo || (msg.document && /image/.test(msg.document.mime_type || ''))) {
      if (type === 'sales' || /продаж|iiko/i.test(text)) return await salesPhoto(msg);
      const tDept = detectDept(topic.name || '') || topic.dept;
      if (type) return await photoMovement(msg, type, type === 'move' ? (head.dept || tDept) : (detectDept(text) || tDept));
      if (msg.chat.type === 'private') return await privatePhoto(msg, text);
      return;
    }
    if (!text || !type) return; // обычная переписка — молчим
    if (type === 'sales') return await salesText(msg, head.type ? text.split('\n').slice(1).join('\n') : text);
    const topicDept = detectDept(topic.name || '') || topic.dept;
    const dept = type === 'move' ? (head.dept || topicDept) : (detectDept(text.split('\n')[0]) || topicDept);
    return await movement(msg, type, dept, text, !!head.type);
  } catch (e) {
    console.error(e);
    const t = e.message === 'NO_GEMINI_KEY' ? 'Фото не прочитано: нет ключа Gemini (пришлите ключ боту в личку)'
      : e.message.startsWith('GEMINI_BUSY') ? 'Google сейчас перегружен и не успел прочитать фото. Пришлите это фото ещё раз через 2–3 минуты — повтор не задвоится.'
      : 'Ошибка: ' + e.message;
    await redis('RPUSH', 'errors', JSON.stringify({ t: new Date().toISOString(), e: String(e.message).replace(/AIza[\w-]{10,}|AQ\.[\w.-]{10,}/g, '***').slice(0, 300) })).catch(() => {});
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
  await tg('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
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

async function movement(msg, type, dept, text, hasHeader, pre, tag = '', opts = {}) {
  let { items, bad } = pre || parseItems(text, hasHeader);
  // Разнести строки по датам («15.11 …») и цехам («на кухню», «на пицца цех»): в любой теме это перемещения
  if (!opts.noSplit && items.length) {
    const yr = +today().slice(0, 4);
    const head0 = text.split('\n')[0];
    const headDept = type !== 'inv' && /(^|\s)(на|в|во|для)\s+(кухн|пицц|кондит)/i.test(head0) ? detectDept(head0) : null;
    const groups = new Map();
    for (const it of items) {
      let t = type, d = dept;
      if (type !== 'inv' && (it.moveDept || headDept)) { t = 'move'; d = it.moveDept || headDept; }
      const dt = it.date ? parseDate(it.date, yr) : null;
      const k = `${t}|${d || ''}|${dt || ''}`;
      if (!groups.has(k)) groups.set(k, { t, d, dt, items: [] });
      groups.get(k).items.push(it);
    }
    const g0 = [...groups.values()][0];
    if (groups.size > 1 || g0.t !== type || g0.d !== dept || g0.dt) {
      const collect = [];
      let first = true;
      for (const g of groups.values()) {
        await movement(msg, g.t, g.d, text, false, { items: g.items, bad: first ? bad : [], supplier: pre?.supplier }, tag, { ...opts, noSplit: true, collect, date: g.dt || opts.date, reclass: type === 'out' && g.t === 'move' });
        first = false;
      }
      if (opts.collect) { opts.collect.push(...collect); return; }
      const emoji = collect.some(c => c.emoji === '🤔') ? '🤔' : '👍';
      return opts.silent ? react(msg, emoji === '🤔' ? '🤔' : '✍') : say(msg, collect.map(c => c.out).join('\n\n'), emoji);
    }
  }
  if (!items.length) {
    if (pre) { await problem(msg, `${TYPE_NAMES[type]}: на фото не нашёл строк с продуктами`); return say(msg, 'На фото не нашёл строк с продуктами', '🤔'); }
    if (hasHeader) { await problem(msg, `${TYPE_NAMES[type]}: не понял сообщение «${text.slice(0, 80)}»`); return say(msg, 'Не нашёл ни одной строки вида «Продукт 2 кг». Пример: <code>Молоко 2 л</code>', '🤔'); }
    return;
  }
  if (type === 'move' && !dept) dept = 'Кухня';
  const date = opts.date || parseDate(text.split('\n')[0], +today().slice(0, 4)) || today();
  // поставщик: «Приход Макро» в первой строке или с фото накладной
  let supplier = pre?.supplier || '';
  if (type === 'in' && hasHeader && !supplier) supplier = text.split('\n')[0].replace(/^\s*(приход\S*|поступлен\S*|закуп\S*|принял\S*)/i, '').replace(/\d{1,2}\.\d{1,2}(\.\d{2,4})?/, '').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim();
  if (supplier.length > 40 || /\d+\s*(кг|г|л|мл|шт)/i.test(supplier)) supplier = '';
  const loc = (type === 'out' || type === 'inv') && dept ? dept : null; // склад цеха
  const prods = await products(); const al = await aliases(); const packs = await packsOf();
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
    if (bu === 'шт' && pu !== 'шт' && packs[name]) { q = it.qty * packs[name]; bu = pu; notes.push(`${esc(name)}: ${it.qty} шт × ${fq(packs[name], pu)}`); }
    if (!bu) { // единица не указана
      if (pu !== 'шт' && it.qty <= 30) { q = it.qty * 1000; notes.push(`${esc(name)}: ${it.qty} без единицы — считал как ${pu === 'г' ? 'кг' : 'л'}`); }
      bu = pu;
    }
    if (bu !== pu && !(['г', 'мл'].includes(bu) && ['г', 'мл'].includes(pu))) { unknown.push(`${it.name} (${it.unit}, а в базе ${pu}${bu === 'шт' ? ` — укажите фасовку: /pack ${name} 1 л` : ''})`); continue; }
    const m = { p: name, unit: pu, reason: it.reason || undefined };
    if (type === 'in') {
      m.delta = q;
      if (it.price) {
        const units = pu === 'шт' ? q : q / 1000;           // кг / л / шт
        const asTotal = it.price, asPerUnit = it.price * units;
        let perUnit = it.perUnit;
        if (perUnit == null && units > 1) {
          const known = (prods[name].lastPrice || prods[name].cost || 0) * (pu === 'шт' ? 1 : 1000); // сум за кг/л/шт
          const impliedTotal = it.price / units;               // цена за кг, если сумма — за всю строку
          if (known > 0) perUnit = Math.abs(Math.log(it.price / known)) < Math.abs(Math.log(impliedTotal / known));
          else perUnit = impliedTotal < (pu === 'шт' ? 1500 : 5000); // за кг дешевле 5 000 сум не бывает
        }
        m.price = perUnit ? asPerUnit : asTotal;
        if (perUnit) notes.push(`${esc(name)}: ${fmt(it.price)} — цена за ${pu === 'шт' ? 'шт' : pu === 'г' ? 'кг' : 'л'}, сумма ${fmt(asPerUnit)}`);
      }
    }
    else if (type === 'inv') m.setTo = q;
    else m.delta = -q;
    moves.push(m);
  }
  // Один и тот же приход текстом и фото счёта: второй раз не прибавляем, только берём цену со счёта
  if (type === 'in' && !loc && moves.length) {
    const dayIns = (await opsBetween(date, date)).filter(o => o.type === 'in' && !o.loc);
    const keep = [];
    for (const m of moves) {
      // дубль = то же количество в тот же день, и хотя бы одна запись без цены (текст) либо цены совпадают
      const dup = dayIns.flatMap(o => o.items).find(r => r.p === m.p && Math.abs(r.q - m.delta) <= Math.max(1, m.delta * 0.02) && (!r.priced || !m.price || Math.abs(r.sum - m.price) <= m.price * 0.01));
      if (!dup) { keep.push(m); continue; }
      if (m.price && !dup.priced) {
        const unitCost = m.price / m.delta;
        prods[m.p].cost = unitCost; prods[m.p].lastPrice = unitCost;
        await hsetJSON('prod', m.p, prods[m.p]);
        await redis('RPUSH', `price:${m.p}`, JSON.stringify({ d: date, s: supplier || '', u: unitCost }));
        notes.push(`${esc(m.p)}: этот приход уже был записан — добавил только цену (${fmt(m.price)} сум)`);
      } else notes.push(`${esc(m.p)}: этот приход уже был записан сегодня — повторно не добавляю`);
    }
    if (!keep.length) {
      const out = `ℹ️ <b>Приход уже был записан</b> · ${ddmm(date)}\n• ${notes.join('\n• ')}`;
      if (opts.collect) { opts.collect.push({ out, emoji: '👍' }); return; }
      return opts.silent ? react(msg, '👌') : say(msg, out, '👌');
    }
    moves.length = 0; moves.push(...keep);
  }
  if (!moves.length) { await problem(msg, `${TYPE_NAMES[type]}: не нашёл продукты ${unknown.join(', ')}`); if (opts.collect) { opts.collect.push({ out: `❓ Не нашёл: ${unknown.map(esc).join(', ')}`, emoji: '🤔' }); return; } if (opts.silent) return react(msg, '🤔'); return say(msg, `Не нашёл продукты: ${unknown.map(esc).join(', ')}.\nДобавьте так: <code>/alias как пишете = Название из /stock</code>`, '🤔'); }
  let res, prev, alerts = [];
  if (loc) {
    ({ res, prev } = await applyDept(loc, moves, prods));
    if (type === 'inv') { const dp = await dprods(); for (const r of res) r.fact = dp[`${loc}|${r.p}`]?.stock ?? 0; }
  } else {
    ({ res, prev, alerts } = await applyMoves(moves, prods, { supplier, date }));
    if (type === 'move') await applyDept(dept, res.map(r => ({ p: r.p, delta: -r.q, unit: r.unit })), prods); // пополнить склад цеха
  }
  res.forEach((r, i) => { if (moves[i]?.reason) r.reason = moves[i].reason; });
  if (opts.dates) opts.dates.push(date);
  await addOp({ type, reclass: opts.reclass || undefined, imported: opts.imported || undefined, dept: loc ? null : dept, loc, supplier: supplier || undefined, date, user: who(msg), userName: userName(msg), items: res, prev, raw: text.slice(0, 500) });
  if (alerts.length) await notifyOwner(await priceAlertText(alerts));

  const sign = type === 'in' ? '+' : '';
  let out = `✅ ${tag}${opts.reclass ? '🔁 ' : ''}<b>${TYPE_NAMES[type]}${loc ? ' · склад ' + loc : dept ? ' → ' + dept : ''}</b>${supplier ? ' · ' + esc(supplier) : ''} · ${ddmm(date)}\n`;
  let total = 0;
  for (const r of res) {
    total += r.sum;
    if (type === 'inv') {
      const d = r.q;
      out += `• ${esc(r.p)}: факт ${fq(loc ? r.fact : prods[r.p].stock, r.unit)} (${d === 0 ? 'сошлось' : d > 0 ? 'излишек +' + fq(d, r.unit) : 'недостача ' + fq(d, r.unit)}${d && !r.noCost ? ', ' + fmt(r.sum) + ' сум' : ''})\n`;
    } else out += `• ${esc(r.p)}: ${sign}${fq(r.q, r.unit)}${r.noCost ? '' : ` · ${fmt(r.sum)} сум`}${r.reason ? ` (${esc(r.reason)})` : ''}\n`;
  }
  if (type !== 'inv' && total) out += `Итого: <b>${fmt(total)} сум</b>\n`;
  if (notes.length) out += `\nℹ️ ${notes.join('\n• ')}\n`;
  if (unknown.length) out += `\n❓ Не нашёл: ${unknown.map(esc).join(', ')} — <code>/alias как пишете = Название</code>\n`;
  if (bad.length) out += `\n❓ Не понял строки: ${bad.map(esc).join(' | ')}\n`;
  if (opts.reclass) out += `ℹ️ Было в «Списании», но это перемещение — записал как перемещение.\n`;
  out += `\nОшиблись? /undo`;
  if (unknown.length || bad.length) await problem(msg, `${TYPE_NAMES[type]}: ${unknown.length ? 'не нашёл ' + unknown.join(', ') : ''} ${bad.length ? 'не понял: ' + bad.join(' | ') : ''}`);
  const emoji = unknown.length || bad.length ? '🤔' : '👍';
  if (opts.collect) { opts.collect.push({ out, emoji }); return; }
  if (opts.silent) return react(msg, emoji === '🤔' ? '🤔' : '✍');
  return say(msg, out, emoji);
}

// ---------- продажи ----------
async function salesPhoto(msg) {
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const buf = await downloadFile(fileId);
  const data = await readSalesPhoto(buf, msg.document?.mime_type || 'image/jpeg');
  return addToPending(msg, data);
}

// Черновик продаж: каждое фото — отдельная запись в списке (несколько фото подряд не затирают друг друга)
async function loadPending(chatId) {
  const old = await getJSON(`pend:${chatId}`); // формат прошлой версии
  const parts = ((await redis('LRANGE', `pendl:${chatId}`, 0, -1)) || []).map(JSON.parse);
  const p = old || { rows: {}, from: null, to: null, totals: {}, drows: {} };
  p.drows ||= {};
  const yr = +today().slice(0, 4);
  for (const d of parts) {
    if (d.from) p.from = parseDate(d.from, yr);
    if (d.to) p.to = parseDate(d.to, yr);
    Object.assign(p.totals, d.totals || {});
    for (const r of d.rows || []) {
      if (r.section && !/бар/i.test(r.section)) {
        const dep = /кондит/i.test(r.section) ? 'Кондитерская' : /пицц/i.test(r.section) ? 'Пиццерия' : /кухн/i.test(r.section) ? 'Кухня' : null;
        if (dep) p.drows[`${dep}|${r.code || norm(r.name)}`] = +r.sum || 0;
        continue;
      }
      const k = String(r.code || norm(r.name));
      p.rows[k] = { code: r.code ? String(r.code) : null, name: r.name, qty: +r.qty || 0, sum: +r.sum || 0 };
    }
  }
  return p;
}
async function clearPending(chatId) { await redis('DEL', `pend:${chatId}`); await redis('DEL', `pendl:${chatId}`); }

async function addToPending(msg, data) {
  const before = await loadPending(msg.chat.id);
  const had = Object.keys(before.rows).length;
  await redis('RPUSH', `pendl:${msg.chat.id}`, JSON.stringify(data));
  const p = await loadPending(msg.chat.id);
  const n = Object.keys(p.rows).length, added = n - had;
  const sum = Object.values(p.rows).reduce((a, r) => a + r.sum, 0);
  const total = p.totals['Бар'];
  const match = total && Math.abs(total - sum) <= Math.max(1, total * 0.003);
  if (match && p.from) return finishSales(msg, '', true);
  if (quiet(msg) && !msg.text?.startsWith('/')) return react(msg, '✍');
  const chk = total ? (match ? ' ✅ сходится с «Итого Бар»' : ` · в отчёте «Итого Бар» ${fmt(total)}, не хватает ${fmt(total - sum)} — пришлите остальные фото или /done`) : ' · «Итого Бар» пока не видно — пришлите последнее фото отчёта или /done';
  return reply(msg, `📸 Прочитал фото: +${added} позиций. В черновике ${n} позиций бара на <b>${fmt(sum)} сум</b>${chk}.\nПериод: ${p.from ? ddmm(p.from) : '?'}–${p.to ? ddmm(p.to) : '?'}\n\nЕщё фото — шлите. Всё? /done (можно с датой: <code>/done 21.11</code>). Сбросить — /cancel`);
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
  const p = await loadPending(msg.chat.id);
  if (!Object.keys(p.rows).length) return reply(msg, 'Черновик продаж пуст. Пришлите фото отчёта iiko.');
  const yr = +today().slice(0, 4);
  const dates = (args.match(/\d{1,2}\.\d{1,2}(\.\d{2,4})?/g) || []).map(d => parseDate(d, yr));
  const from = dates[0] || p.from || today();
  const to = dates[1] || (dates[0] ? dates[0] : p.to) || from;
  const force = /force|заново|перезап/i.test(args);

  const prior = (await opsBetween(from, '9999-12-31')).filter(o => o.type === 'sales' && !(o.periodTo < from || o.periodFrom > to));
  if (prior.length && !force && auto) { await clearPending(msg.chat.id); await problem(msg, `Продажи ${ddmm(from)}–${ddmm(to)} уже были внесены — фото не учтено`); return react(msg, '🤔'); }
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
  await clearPending(msg.chat.id);

  let out = `✅ <b>Продажи ${ddmm(from)}–${ddmm(to)}</b> внесены\nВыручка бара: <b>${fmt(revenue)} сум</b>\nСписано по техкартам: ${res.length} продуктов`;
  if (cost) out += ` на ${fmt(cost)} сум\nФудкост: <b>${(cost / revenue * 100).toFixed(1)}%</b>`;
  const noCost = res.filter(r => r.noCost).length;
  if (noCost) out += `\nℹ️ У ${noCost} продуктов ещё нет цены закупки — фудкост посчитается после приходов с суммой или /price`;
  if (noTk.length) out += `\n❓ Нет техкарты: ${noTk.slice(0, 15).map(esc).join(', ')}`;
  const neg = res.filter(r => prods[r.p].stock < 0);
  if (neg.length) out += `\n⚠️ Ушли в минус (нужна инвентаризация или приход): ${neg.slice(0, 10).map(r => esc(r.p)).join(', ')}${neg.length > 10 ? '…' : ''}`;
  out += `\n\nПодробно: /report ${ddmm(from)}-${ddmm(to)}`;
  if (noTk.length) await problem(msg, `Продажи ${ddmm(from)}–${ddmm(to)}: нет техкарты для ${noTk.join(', ')}`);
  if (auto && quiet(msg)) {
    await react(msg, '👍');
    const owner = await redis('GET', 'owner');
    if (owner && from === to) await cmdDay(ownerMsg(owner), ddmm(from)); // отчёт за день — владельцу в личку
    return;
  }
  await reply(msg, out);
  if (from === to && msg.chat.type === 'private') return cmdDay(msg, ddmm(from)); // сразу подробный отчёт за день
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
  const n = Math.min(+args || 15, 40);
  const t = today(); const d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() - 14);
  const ops = (await opsBetween(d.toISOString().slice(0, 10), t)).slice(-n).reverse();
  if (!ops.length) return reply(msg, 'За две недели записей нет.');
  await setJSON(`logmap:${msg.from.id}`, ops.map(o => ({ id: o.id, date: o.date })));
  return reply(msg, '🧾 <b>Последние записи</b> (удалить неверные: <code>/del 2 5</code>)\n\n' + ops.map((o, i) => {
    const head = `<b>${i + 1}.</b> <b>${TYPE_NAMES[o.type]}${o.loc ? ' · склад ' + o.loc : ''}${o.dept ? ' → ' + o.dept : ''}</b> · ${ddmm(o.date)}${o.userName ? ' · ' + esc(o.userName) : ''}`;
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

const ownerMsg = id => ({ chat: { id: +id, type: 'private' }, from: { id: +id } });
// Ежедневный отчёт владельцу (вызывается из api/cron.js)
// Четверг 15:00 — второе напоминание, если заказы не внесены
export async function thursdayLastCall() {
  await ensureSeed();
  const owner = await redis('GET', 'owner');
  if (!owner || new Date(today() + 'T12:00:00').getDay() !== 4) return 'skip';
  return thursdayReminder({ chat: { id: +owner, type: 'private' }, from: { id: +owner } }, 'last');
}

export async function dailyReport() {
  await ensureSeed();
  const owner = await redis('GET', 'owner');
  if (!owner) return 'no owner';
  const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() - 1);
  const y = d.toISOString().slice(0, 10);
  const fake = { chat: { id: +owner, type: 'private' }, from: { id: +owner } };
  await cmdDay(fake, `${ddmm(y)}`);
  if (today().endsWith('-01')) await cmdMonth(fake, 'прошлый');
  const low = await lowStock();
  if (low.length) await reply(fake, '⏳ <b>Скоро закончится</b>\n' + low.slice(0, 15).map(l => `• ${esc(l.p)} — ${l.stock <= 0 ? '<b>уже нет</b>' : `осталось ${fq(l.stock, l.unit)}, хватит на ~${l.left < 1 ? 'сегодня' : Math.floor(l.left) + ' дн.'}`}`).join('\n') + '\n\nЧто заказать: /order');
  const wd = new Date(today() + 'T12:00:00').getDay();
  if (wd === 1) await weeklyDigest(fake, periodFromArgs);
  if (wd === 3) await wednesdayHeadsUp(fake);
  if (wd === 4) await thursdayReminder(fake, 'morning');
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

// ---------- импорт старых сообщений (пересылка в личку) ----------
const IMP = msg => `import:${msg.from.id}`;
async function cmdImport(msg, args) {
  if (msg.chat.type !== 'private') return reply(msg, 'Импорт делается в личке бота.');
  const st = await getJSON(IMP(msg));
  if (/^(готово|стоп|done|конец|всё|все)$/i.test(args.trim())) {
    if (!st || !st.n) { await redis('DEL', IMP(msg)); return reply(msg, 'Импорт пуст — пересланных сообщений не было.'); }
    await redis('DEL', IMP(msg));
    await reply(msg, `📥 <b>Импорт завершён</b>: ${st.n} сообщений за ${ddmm(st.from)}–${ddmm(st.to)}${st.reclass ? `\n🔁 Из «Списания» перенёс в перемещения: ${st.reclass} строк` : ''}${st.skip ? `\n⏭ Повторы пропущены: ${st.skip}` : ''}${st.unknown ? `\n🤔 Не понял: ${st.unknown} — смотрите /problems` : ''}`);
    return cmdReport(msg, `${ddmm(st.from)}-${ddmm(st.to)}`);
  }
  const h = detectHeader(args);
  if (!h.type) return reply(msg, `📥 <b>Импорт старых сообщений</b>
Боты не видят историю группы, поэтому пересылайте её сюда:
1. Напишите тип: <code>/import списание</code> (или <code>приход</code>, <code>перемещение кухня</code>, <code>перемещение пиццерия</code>, <code>инвентаризация</code>).
2. Откройте эту тему в группе, выделите сообщения (долгое нажатие → «Выбрать») → «Переслать» → этот бот.
3. Следующая тема — снова <code>/import …</code> с другим типом.
4. В конце: <code>/import готово</code> — пришлю отчёт за весь период.
Даты беру из оригинальных сообщений. Строки «на кухню / в пиццерию / отдал» в списаниях сам запишу как перемещения. Повторно пересланное не задвоится.`);
  await setJSON(IMP(msg), { ...(st || { n: 0, from: null, to: null }), type: h.type, dept: h.dept });
  return reply(msg, `📥 Жду пересланные сообщения: <b>${TYPE_NAMES[h.type]}${h.dept ? ' → ' + h.dept : ''}</b>. Пересылайте. Закончите — <code>/import готово</code>`);
}

async function importForward(msg, text) {
  const st = await getJSON(IMP(msg)) || { n: 0, from: null, to: null };
  const ts = msg.forward_origin?.date || msg.forward_date || Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });
  const sig = `${ts}:${(text || '').slice(0, 200)}:${msg.photo ? msg.photo[0].file_unique_id : ''}`;
  if (await redis('HGET', 'imported', sig)) { st.skip = (st.skip || 0) + 1; await setJSON(IMP(msg), st); return react(msg, '👌'); }
  const head = detectHeader(text || '');
  const type = head.type || st.type || (text ? guessType(text) : null);
  if (msg.photo || msg.document) { await redis('HSET', 'imported', sig, '1'); return privatePhoto(msg, text || (type ? TYPE_NAMES[type] : '')); }
  if (!text || !type) { st.unknown = (st.unknown || 0) + 1; await setJSON(IMP(msg), st); await problem(msg, `Импорт ${ddmm(date)}: не знаю тип — «${(text || '').slice(0, 60)}». Сначала /import списание (или другой тип)`); return react(msg, '🤔'); }
  const dept = type === 'move' ? (head.dept || detectDept(text) || st.dept) : (detectDept(text.split('\n')[0]) || (type === st.type ? st.dept : null));
  const collect = [];
  await movement(msg, type, dept, text, !!head.type, null, '📥 ', { date, collect, imported: true });
  await redis('HSET', 'imported', sig, '1');
  st.n++; st.from = !st.from || date < st.from ? date : st.from; st.to = !st.to || date > st.to ? date : st.to;
  st.reclass = (st.reclass || 0) + collect.filter(c => c.out.includes('🔁')).length;
  if (collect.some(c => c.emoji === '🤔')) st.unknown = (st.unknown || 0) + 1;
  await setJSON(IMP(msg), st);
  return react(msg, collect.some(c => c.emoji === '🤔') ? '🤔' : '✍');
}

// Удалить записи по номерам из /log (остатки возвращаются)
async function cmdDel(msg, args) {
  const owner = await redis('GET', 'owner');
  if (owner && owner !== String(msg.from.id)) return reply(msg, 'Удалять записи может только владелец бота.');
  const nums = (args.match(/\d+/g) || []).map(Number);
  const map = await getJSON(`logmap:${msg.from.id}`);
  if (!nums.length || !map) return reply(msg, 'Сначала /log, потом <code>/del 2 5</code> — номера из списка.');
  const done = [];
  for (const n of nums) {
    const ref = map[n - 1]; if (!ref) continue;
    const op = ((await redis('LRANGE', `ops:${ref.date}`, 0, -1)) || []).map(JSON.parse).find(o => o.id === ref.id);
    if (op && await revertOp(op)) done.push(`${n}. ${TYPE_NAMES[op.type]} ${ddmm(op.date)} (${op.items.map(r => esc(r.p)).slice(0, 3).join(', ')})`);
  }
  return reply(msg, done.length ? `🗑 Удалил, остатки вернул:\n${done.join('\n')}\n\nТеперь можно внести заново правильно.` : 'Ничего не удалено — проверьте номера (/log).');
}

// Фасовка: сколько мл/г в одной штуке (для «Молоко 12 шт»)
async function cmdPack(msg, args) {
  const it = parseLine(args);
  const prods = await products(); const al = await aliases();
  const name = it && findProduct(it.name, prods, al);
  if (!it || !name || !it.unit) return reply(msg, 'Формат: <code>/pack Молоко 1 л</code> — сколько в одной штуке/бутылке.');
  const [q] = toBase(it.qty, it.unit);
  await redis('HSET', 'pack', name, String(q));
  return reply(msg, `📦 ${esc(name)}: 1 шт = ${fq(q, prods[name].unit)}`);
}

// ---------- вставка истории, скопированной из Telegram («ZXC, [18 ноя. 2026 в 10:54]») ----------
const PASTE_HEAD = /^\s*(.+?),\s*\[(\d{1,2})\s+([а-яё]+)\.?\s+(\d{4})\s+в\s+(\d{1,2}):(\d{2})\]\s*$/im;
const MONTHS = { янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };
export function splitPaste(text) {
  const out = []; let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(PASTE_HEAD);
    if (m) {
      const mon = MONTHS[m[3].slice(0, 3).toLowerCase()];
      if (mon) { cur = { who: m[1].trim(), date: `${m[4]}-${String(mon).padStart(2, '0')}-${m[2].padStart(2, '0')}`, time: `${m[5]}:${m[6]}`, body: [] }; out.push(cur); continue; }
    }
    if (cur) cur.body.push(line);
  }
  return out.map(x => ({ ...x, body: x.body.join('\n').trim() })).filter(x => x.body);
}

async function importPaste(msg, text) {
  const st = await getJSON(IMP(msg)) || {};
  const list = splitPaste(text);
  if (!list.length) return reply(msg, 'Не нашёл сообщений в формате «Имя, [18 ноя. 2026 в 10:54]».');
  const collect = [], dates = []; let skip = 0;
  for (const m of list) {
    const sig = `${m.date} ${m.time}:${m.body.slice(0, 200)}`;
    if (await redis('HGET', 'imported', sig)) { skip++; continue; }
    const head = detectHeader(m.body);
    const type = head.type || st.type || guessType(m.body);
    if (type === 'sales') continue;
    const dept = type === 'move' ? (head.dept || detectDept(m.body) || st.dept) : (detectDept(m.body.split('\n')[0]) && head.type ? detectDept(m.body.split('\n')[0]) : null);
    const before = collect.length;
    await movement({ ...msg, from: { ...msg.from, first_name: m.who, last_name: '' } }, type, dept, m.body, !!head.type, null, '', { date: m.date, collect, dates, imported: true });
    if (collect.length === before) collect.push({ out: `❓ ${ddmm(m.date)} не понял: «${esc(m.body.slice(0, 60))}»`, emoji: '🤔' });
    await redis('HSET', 'imported', sig, '1');
  }
  const from = dates.length ? dates.reduce((a, b) => a < b ? a : b) : null, to = dates.length ? dates.reduce((a, b) => a > b ? a : b) : null;
  const bad = collect.filter(c => c.emoji === '🤔').length;
  await reply(msg, `📥 <b>Загружено сообщений: ${list.length - skip}</b>${skip ? ` (повторы пропущены: ${skip})` : ''}${bad ? ` · 🤔 с вопросами: ${bad}` : ''}\n\n` + collect.map(c => c.out.replace(/\n\nОшиблись\? \/undo/g, '').replace(/\nОшиблись\? \/undo/g, '')).join('\n\n') + '\n\nОшибка — /log и /del номер, затем пришлите строку заново.');
  if (from) return cmdReport(msg, `${ddmm(from)}-${ddmm(to)}`);
}

// Полная очистка учёта (техкарты, синонимы, фасовка, поставщики, ключи — остаются)
async function cmdReset(msg, args) {
  if (msg.chat.type !== 'private') return reply(msg, 'Только в личке.');
  const owner = await redis('GET', 'owner');
  if (owner && owner !== String(msg.from.id)) return reply(msg, 'Только владелец.');
  if (!/^да$/i.test(args.trim())) return reply(msg, '⚠️ Это удалит ВСЕ записи: приходы, списания, перемещения, продажи, остатки, цены, склады цехов. Техкарты, синонимы, фасовка, фирмы и ключ Gemini останутся.\nТочно? Напишите <code>/reset да</code>');
  const pats = ['ops:*', 'last:*', 'pend:*', 'price:*', 'problems:*', 'logmap:*', 'import:*'];
  for (const p of pats) { const ks = (await redis('KEYS', p)) || []; for (const k of ks) await redis('DEL', k); }
  for (const k of ['opdates', 'deleted', 'dprod', 'imported']) await redis('DEL', k);
  const prods = await products();
  for (const [n, p] of Object.entries(prods)) await hsetJSON('prod', n, { unit: p.unit, stock: 0, cost: 0 });
  return reply(msg, '🧹 Учёт очищен. Теперь вставьте сюда историю из группы (скопированные сообщения) или пересылайте их — я разберу заново. Начните с инвентаризации.');
}

// ---------- Ежедневный отчёт ----------
async function cmdDay(msg, args) {
  const t = today(); const yr = +t.slice(0, 4);
  let date = parseDate(args, yr);
  if (!date) { const d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() - (/сегодня/i.test(args) ? 0 : 1)); date = d.toISOString().slice(0, 10); }
  const ops = await opsBetween(date, date);
  const sales = (await opsBetween(date, '9999-12-31')).filter(o => o.type === 'sales' && o.periodFrom <= date && o.periodTo >= date);
  const prods = await products();
  let out = `📅 <b>Отчёт бара за ${ddmm(date)}</b>\n\n`;
  const daySales = sales.filter(o => o.periodFrom === o.periodTo);
  if (daySales.length) {
    let revenue = 0, cost = 0, cups = 0; const pos = {};
    for (const o of daySales) { revenue += o.revenue || 0; cost += o.items.reduce((a, r) => a + r.sum, 0); for (const p of o.positions || []) { const a = pos[p.code || p.name] ||= { name: p.name, qty: 0, sum: 0 }; a.qty += p.qty; a.sum += p.sum; cups += p.qty; } }
    out += `💰 Выручка: <b>${fmt(revenue)} сум</b> · продано ${round(cups)} позиций\n`;
    if (cost) out += `🍹 Себестоимость: ${fmt(cost)} · фудкост <b>${(cost / revenue * 100).toFixed(1)}%</b>\n`;
    const top = Object.values(pos).sort((a, b) => b.sum - a.sum).slice(0, 8);
    out += `\n<b>Топ продаж</b>\n` + top.map((r, i) => `${i + 1}. ${esc(r.name)} — ${round(r.qty)} · ${fmt(r.sum)}`).join('\n') + '\n';
    const usedTop = daySales.flatMap(o => o.items).sort((a, b) => b.sum - a.sum).slice(0, 5);
    if (usedTop.some(r => r.sum)) out += `\n<b>Больше всего ушло по техкартам</b>\n` + usedTop.filter(r => r.sum).map(r => `• ${esc(r.p)}: ${fq(-r.q, r.unit)} · ${fmt(r.sum)}`).join('\n') + '\n';
  } else if (sales.length) out += `💰 Продажи внесены за период ${ddmm(sales[0].periodFrom)}–${ddmm(sales[0].periodTo)} (по дням не разбить)\n`;
  else out += `📸 Продаж за ${ddmm(date)} нет — пришлите фото отчёта iiko «Общие продажи блюд» за этот день.\n`;
  const sum = (type, f = () => true) => ops.filter(o => o.type === type && f(o)).reduce((a, o) => a + o.items.reduce((b, r) => b + Math.abs(r.sum), 0), 0);
  const lines = [];
  const inSum = sum('in'); if (inSum || ops.some(o => o.type === 'in')) lines.push(`📥 Приход: ${fmt(inSum)}${ops.filter(o => o.type === 'in' && o.supplier).map(o => ' · ' + esc(o.supplier)).join('')}`);
  const wo = ops.filter(o => o.type === 'out');
  if (wo.length) lines.push(`🗑 Списано: ${fmt(sum('out'))}\n` + wo.flatMap(o => o.items.map(r => `   • ${esc(r.p)} ${fq(-r.q, r.unit)}${r.reason ? ' (' + esc(r.reason) + ')' : ''}${o.loc ? ' — ' + o.loc : ''}`)).slice(0, 10).join('\n'));
  for (const d of DEPTS) { const mv = ops.filter(o => o.type === 'move' && (o.dept || 'Кухня') === d); if (mv.length) lines.push(`➡️ ${d}: ${fmt(sum('move', o => (o.dept || 'Кухня') === d))} — ` + mv.flatMap(o => o.items.map(r => `${esc(r.p)} ${fq(-r.q, r.unit)}`)).slice(0, 6).join(', ')); }
  const inv = ops.filter(o => o.type === 'inv');
  if (inv.length) { const v = inv.reduce((a, o) => a + o.items.reduce((b, r) => b + (r.q < 0 ? -r.sum : r.sum), 0), 0); lines.push(`📋 Инвентаризация: ${v < 0 ? '❗недостача ' + fmt(-v) : v > 0 ? 'излишек ' + fmt(v) : 'всё сошлось'}`); }
  if (lines.length) out += `\n<b>Движения</b>\n` + lines.join('\n') + '\n';
  const neg = Object.entries(prods).filter(([, p]) => p.stock < 0).length;
  if (neg) out += `\n⚠️ В минусе ${neg} продуктов — нужна инвентаризация (фото остатков сюда).`;
  const probs = ((await redis('KEYS', 'problems:*')) || []).length;
  if (probs) out += `\n🤔 Есть непонятые сообщения — /problems`;
  return reply(msg, out);
}
