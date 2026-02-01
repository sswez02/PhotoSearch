import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { makePool } from './db.js';
import { createUploadUrl, createDownloadUrl, getBucketName } from './storage.js';
import { makePubSub } from './pubsub.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Request correlation + structured access logs
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = (req.header('x-request-id') ?? crypto.randomBytes(8).toString('hex')).slice(
    0,
    64,
  );
  res.setHeader('x-request-id', requestId);
  (res.locals as any).requestId = requestId;

  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    const photoId = req.params?.id ? Number(req.params.id) : undefined;
    console.log(
      JSON.stringify({
        type: 'http_request',
        request_id: requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(durMs),
        photo_id: Number.isFinite(photoId as any) ? photoId : undefined,
      }),
    );
  });

  next();
});

const pool = makePool();

const pubsub = makePubSub();

const TOPIC = process.env.PUBSUB_TOPIC ?? 'photo-uploaded';

app.get('/health', async (_req, res) => {
  const r = await pool.query('select 1 as ok');
  res.json({ ok: true, db: r.rows[0]?.ok === 1 });
});

/**
 * Create a photo placeholder row and reserve a GCS object path
 *
 * - Generate the object path server-side
 * - State machine starts at PENDING
 */
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

  // Reserved path for the original upload
  const objectPath = `uploads/${datePrefix}/${rand}_${safeName}`;

  const r = await pool.query(
    `insert into photos (original_filename, status, gcs_bucket, gcs_object, content_type)
     values ($1, 'PENDING', $2, $3, $4)
     returning id, original_filename, status, gcs_bucket, gcs_object, content_type, created_at`,
    [body.originalFilename, bucket, objectPath, body.contentType],
  );

  res.status(201).json(r.rows[0]);
});

/**
 * Generate a short-lived signed PUT URL so the client uploads bytes directly to GCS
 *
 * - Avoids proxying large file uploads through the API service
 * - Reduces latency + egress + memory pressure on Cloud Run
 */
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
    expiresInSeconds: 10 * 60, // small TTL: reduces blast radius if leaked
  });

  res.json({
    id: row.id,
    bucket: row.gcs_bucket,
    objectPath: row.gcs_object,
    uploadUrl,
  });
});

/**
 * Client confirms upload is complete
 *
 * - Mark row UPLOADED
 * - Publish a Pub/Sub message so the worker performs EXIF extraction + thumbnailing
 */
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

  const photo = r.rows[0];

  const requestId = (res.locals as any).requestId as string | undefined;

  const pubsubMessageId = await pubsub.topic(TOPIC).publishMessage({
    json: { photoId: photo.id },
    attributes: requestId ? { requestId } : {},
  });

  console.log(
    JSON.stringify({
      type: 'pubsub_publish',
      request_id: requestId,
      topic: TOPIC,
      photo_id: photo.id,
      pubsub_message_id: pubsubMessageId,
    }),
  );

  res.json(photo);
});

/**
 * Fetch one photo row (metadata + lifecycle state)
 */
app.get('/photos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const r = await pool.query(
    `select id, original_filename, status, gcs_bucket, gcs_object, content_type, size_bytes,
            width, height, taken_at, exif_json, thumb_bucket, thumb_object, processed_at,
            processing_ms, processed_attempt, error_reason, error_at,
            created_at, uploaded_at
     from photos
     where id = $1`,
    [id],
  );

  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });

  res.json(row);
});

/**
 * Generate a signed GET URL to fetch the thumbnail bytes from GCS
 */
app.get('/photos/:id/thumbnail-url', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const r = await pool.query(
    `select id, status, thumb_bucket, thumb_object
     from photos
     where id = $1`,
    [id],
  );

  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });

  if (row.status !== 'PROCESSED') {
    return res.status(409).json({ error: 'Photo not processed yet', status: row.status });
  }

  if (!row.thumb_bucket || !row.thumb_object) {
    return res.status(500).json({ error: 'Missing thumbnail fields on row' });
  }

  const { url } = await createDownloadUrl({
    bucket: row.thumb_bucket,
    objectPath: row.thumb_object,
    expiresInSeconds: 10 * 60,
  });

  res.json({ id: row.id, url });
});

/**
 * List/search photos with optional filters
 *
 * - q: filename fuzzy match (pg_trgm) / substring fallback
 * - from/to: taken_at range (EXIF-derived; may be null if missing)
 *
 * - taken_at can be null => those rows will be excluded from from/to filters
 * - q uses the % trigram operator if pg_trgm is enabled
 */
app.get('/photos', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';

  // Accept either YYYY-MM-DD or ISO timestamps
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const hasFrom = fromDate instanceof Date && !isNaN(fromDate.getTime());
  const hasTo = toDate instanceof Date && !isNaN(toDate.getTime());

  const where: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (q) {
    // `%` uses pg_trgm similarity; ILIKE covers the non-extension case
    where.push(`original_filename % $${i} OR original_filename ILIKE '%' || $${i} || '%'`);
    params.push(q);
    i++;
  }

  if (hasFrom) {
    where.push(`taken_at >= $${i}`);
    params.push(fromDate);
    i++;
  }

  if (hasTo) {
    where.push(`taken_at <= $${i}`);
    params.push(toDate);
    i++;
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  params.push(limit, offset);
  const limitParam = i++;
  const offsetParam = i++;

  const r = await pool.query(
    `
    select id, original_filename, status, gcs_bucket, gcs_object, content_type, size_bytes,
           width, height, taken_at, thumb_bucket, thumb_object, processed_at,
           processing_ms, processed_attempt, error_reason, error_at,
           created_at, uploaded_at
    from photos
    ${whereSql}
    order by created_at desc
    limit $${limitParam} offset $${offsetParam}
    `,
    params,
  );

  res.json({
    items: r.rows,
    limit,
    offset,
    q: q || null,
    from: hasFrom ? from : null,
    to: hasTo ? to : null,
  });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
