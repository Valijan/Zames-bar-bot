import { dailyReport } from '../lib/bot.js';
export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('no');
  res.status(200).send(await dailyReport());
}
