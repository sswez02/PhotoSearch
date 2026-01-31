import 'dotenv/config';
import express from 'express';
import { makePool } from './db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = makePool();

// Health
app.get('/health', async (_req, res) => {
  const r = await pool.query('select 1 as ok');
  res.json({ ok: true, db: r.rows[0]?.ok === 1 });
});

/**
 * Pub/Sub push sends:
 * { message: { data: "base64..." }, subscription: "..." }
 * API published json: { photoId: ... }
 */
app.post('/tasks/process', async (req, res) => {
  try {
    const msg = req.body?.message;
    const dataB64 = msg?.data;
    if (!dataB64) return res.status(400).send('missing message.data');

    const jsonStr = Buffer.from(dataB64, 'base64').toString('utf8');
    const payload = JSON.parse(jsonStr);

    const photoId = Number(payload.photoId);
    if (!Number.isFinite(photoId)) return res.status(400).send('bad photoId');

    await pool.query(
      `update photos
       set status='PROCESSED', processed_at=now()
       where id=$1`,
      [photoId],
    );

    res.status(204).send();
  } catch (e) {
    console.error(e);
    // non-2xx => Pub/Sub retries
    res.status(500).send('worker failed');
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`worker listening on ${port}`));
