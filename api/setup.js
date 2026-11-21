// Один раз открыть в браузере: https://<проект>.vercel.app/api/setup?key=<SETUP_KEY>
export default async function handler(req, res) {
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (!process.env.SETUP_KEY || key !== process.env.SETUP_KEY) return res.status(401).send('Нужен ?key=SETUP_KEY');
  const api = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
  const post = (m, b) => fetch(`${api}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const hook = await post('setWebhook', {
    url: `https://${req.headers.host}/api/telegram`,
    secret_token: process.env.WEBHOOK_SECRET || undefined,
    allowed_updates: ['message'], drop_pending_updates: true,
  });
  const cmds = await post('setMyCommands', { commands: [
    ['stock', 'Остатки'], ['report', 'Отчёт: /report 16.11-20.11'], ['foodcost', 'Фудкост по позициям'],
    ['tk', 'Техкарта: /tk ассам'], ['done', 'Внести продажи из фото'], ['cancel', 'Сбросить черновик продаж'],
    ['price', 'Цена: /price Молоко 1 л 12000'], ['alias', 'Синоним продукта'], ['undo', 'Отменить мою последнюю операцию'],
    ['topic', 'Назначить тип теме'], ['id', 'id чата'], ['help', 'Как пользоваться'],
  ].map(([command, description]) => ({ command, description })) });
  // старый бот food cost: убрать кнопку Mini App и обновить описание
  await post('setChatMenuButton', { menu_button: { type: 'commands' } });
  await post('setMyDescription', { description: 'Учёт бара ZAMES: приход, списание, перемещения на кухню/в пиццерию/в кондитерскую, продажи по фото iiko, остатки и фудкост. Добавьте в рабочую группу и сделайте админом.' });
  await post('setMyShortDescription', { short_description: 'Учёт бара ZAMES: остатки, списания, фудкост' });
  const me = await post('getMe', {});
  res.status(200).json({ webhook: hook, commands: cmds, bot: me.result?.username });
}
