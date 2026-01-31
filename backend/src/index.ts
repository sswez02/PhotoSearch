import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { makePool } from './db.js';
import { createUploadUrl, getBucketName } from './storage.js';
import { makePubSub } from './pubsub.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = makePool();

const pubsub = makePubSub();
const TOPIC = process.env.PUBSUB_TOPIC ?? 'photo-uploaded';

app.get('/health', async (_req, res) => {
  const r = await pool.query('select 1 as ok');
  res.json({ ok: true, db: r.rows[0]?.ok === 1 });
});

app.post('/photos', async (req, res) => {
  const schema = z.object({
    originalFilename: z.string().min(1).max(300),
    contentType: z.string().min(3).max(200).default('application/octet-stream'),
  });
  const body = schema.parse(req.body);

  const bucket = getBucketName();

  const datePrefix = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(16).toString('hex');
  const safeName = body.originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

  const objectPath = `uploads/${datePrefix}/${rand}_${safeName}`;

  const r = await pool.query(
    `insert into photos (original_filename, status, gcs_bucket, gcs_object, content_type)
     values ($1, 'PENDING', $2, $3, $4)
     returning id, original_filename, status, gcs_bucket, gcs_object, content_type, created_at`,
    [body.originalFilename, bucket, objectPath, body.contentType],
  );

  res.status(201).json(r.rows[0]);
});

app.post('/photos/:id/upload-url', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const schema = z.object({
    contentType: z.string().min(3).max(200),
  });
  const body = schema.parse(req.body);

  const r = await pool.query(
    `select id, gcs_bucket, gcs_object
     from photos
     where id = $1`,
    [id],
  );

  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.gcs_bucket || !row.gcs_object) {
    return res.status(500).json({ error: 'Missing gcs fields on row' });
  }

  const { uploadUrl } = await createUploadUrl({
    bucket: row.gcs_bucket,
    objectPath: row.gcs_object,
    contentType: body.contentType,
    expiresInSeconds: 10 * 60,
  });

  res.json({
    id: row.id,
    bucket: row.gcs_bucket,
    objectPath: row.gcs_object,
    uploadUrl,
  });
});

app.post('/photos/:id/complete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const schema = z.object({
    sizeBytes: z.number().int().nonnegative().optional(),
    contentType: z.string().min(3).max(200).optional(),
  });
  const body = schema.parse(req.body);

  const r = await pool.query(
    `update photos
     set status = 'UPLOADED',
         size_bytes = coalesce($2, size_bytes),
         content_type = coalesce($3, content_type),
         uploaded_at = now()
     where id = $1
     returning id, original_filename, status, gcs_bucket, gcs_object, content_type, size_bytes, uploaded_at`,
    [id, body.sizeBytes ?? null, body.contentType ?? null],
  );

  if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });

  await pubsub.topic(TOPIC).publishMessage({
    json: { photoId: r.rows[0].id },
  });

  res.json(r.rows[0]);
});

app.get('/photos', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const r = await pool.query(
    `select id, original_filename, status, gcs_bucket, gcs_object, content_type, size_bytes, created_at, uploaded_at
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
