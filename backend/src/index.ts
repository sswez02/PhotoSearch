import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { makePool } from './db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = makePool();

app.get('/health', async (_req, res) => {
  // DB ping to confirm Cloud SQL wiring
  const r = await pool.query('select 1 as ok');
  res.json({ ok: true, db: r.rows[0]?.ok === 1 });
});

app.post('/photos', async (req, res) => {
  const schema = z.object({
    originalFilename: z.string().min(1).max(300),
  });
  const body = schema.parse(req.body);

  const r = await pool.query(
    `insert into photos (original_filename, status)
     values ($1, 'PENDING')
     returning id, original_filename, status, created_at`,
    [body.originalFilename],
  );

  res.status(201).json(r.rows[0]);
});

app.get('/photos', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const r = await pool.query(
    `select id, original_filename, status, created_at
     from photos
     order by created_at desc
     limit $1 offset $2`,
    [limit, offset],
  );

  res.json({ items: r.rows, limit, offset });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
