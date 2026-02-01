import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import sharp from 'sharp';
import * as exifr from 'exifr';
import { Storage } from '@google-cloud/storage';
import { makePool } from './db.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const pool = makePool();
const storage = new Storage();

const BUCKET_DEFAULT = process.env.GCS_BUCKET;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 5);

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function nowIso(): string {
  return new Date().toISOString();
}

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify(obj));
}

function getAttempt(req: express.Request, deliveryAttempt: unknown): number {
  const header = req.header('x-goog-delivery-attempt');
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;

  const fromBody = typeof deliveryAttempt === 'number' ? deliveryAttempt : NaN;
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;

  return 1;
}

const pubsubSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string().optional(),
  deliveryAttempt: z.number().int().nonnegative().optional(),
});

app.get('/health', async (_req, res) => {
  const r = await pool.query('select 1 as ok');
  res.json({ ok: true, db: r.rows[0]?.ok === 1 });
});

/**
 * Pub/Sub push payload:
 * { message: { data: "base64(JSON)", messageId?: "...", attributes?: {...} }, subscription?: "..." }
 * Where JSON is: { photoId: number }
 */
app.post('/tasks/process', async (req, res) => {
  const startedAt = Date.now();

  // Parse envelope (invalid envelopes should ACK to avoid retries)
  let env: z.infer<typeof pubsubSchema>;
  try {
    env = pubsubSchema.parse(req.body);
  } catch (e) {
    log({
      type: 'photo_process_bad_envelope',
      ts: nowIso(),
      error: truncate(String(e), 400),
    });
    return res.status(204).send();
  }

  const attempt = getAttempt(req, env.deliveryAttempt);
  const pubsubMessageId = env.message.messageId ?? null;
  const requestId = env.message.attributes?.requestId ?? null;

  // Decode payload
  let payload: any;
  try {
    const jsonStr = Buffer.from(env.message.data, 'base64').toString('utf8');
    payload = JSON.parse(jsonStr);
  } catch (e) {
    log({
      type: 'photo_process_bad_payload',
      ts: nowIso(),
      pubsub_message_id: pubsubMessageId,
      request_id: requestId,
      attempt,
      error: truncate(String(e), 400),
    });
    return res.status(204).send();
  }

  const photoId = Number(payload?.photoId);
  if (!Number.isFinite(photoId)) {
    log({
      type: 'photo_process_bad_photo_id',
      ts: nowIso(),
      pubsub_message_id: pubsubMessageId,
      request_id: requestId,
      attempt,
      photo_id_raw: payload?.photoId,
    });
    return res.status(204).send();
  }

  log({
    type: 'photo_process_start',
    ts: nowIso(),
    photo_id: photoId,
    pubsub_message_id: pubsubMessageId,
    request_id: requestId,
    attempt,
  });

  async function markError(reason: string) {
    await pool.query(
      `update photos
     set status='ERROR',
         error_reason=$2,
         error_at=now(),
         processed_attempt = greatest(coalesce(processed_attempt, 0), $3)
     where id=$1`,
      [photoId, truncate(reason, 300), attempt],
    );
  }

  function retryOrFail(reason: string, err: unknown) {
    log({
      type: 'photo_process_retryable_error',
      ts: nowIso(),
      photo_id: photoId,
      pubsub_message_id: pubsubMessageId,
      request_id: requestId,
      attempt,
      reason,
      error: truncate(String(err), 600),
    });

    // Returning non-2xx triggers Pub/Sub retry
    if (attempt < MAX_ATTEMPTS) {
      return res.status(500).send('retry');
    }

    // After MAX_ATTEMPTS, mark ERROR and ACK
    return (async () => {
      await markError(reason);
      log({
        type: 'photo_process_give_up',
        ts: nowIso(),
        photo_id: photoId,
        pubsub_message_id: pubsubMessageId,
        request_id: requestId,
        attempt,
        reason,
      });
      return res.status(204).send();
    })();
  }

  try {
    // Load row
    const r = await pool.query(
      `select id, status, gcs_bucket, gcs_object, uploaded_at
   from photos
   where id = $1`,
      [photoId],
    );

    const row = r.rows[0] as
      | {
          id: number;
          status: string;
          gcs_bucket: string | null;
          gcs_object: string | null;
          uploaded_at: Date | null;
        }
      | undefined;

    if (!row) {
      log({
        type: 'photo_process_missing_row',
        ts: nowIso(),
        photo_id: photoId,
        pubsub_message_id: pubsubMessageId,
        request_id: requestId,
        attempt,
      });
      return res.status(204).send();
    }

    // Idempotency: if already terminal, ACK
    if (row.status === 'PROCESSED' || row.status === 'ERROR') {
      return res.status(204).send();
    }

    if (row.status !== 'UPLOADED' || !row.uploaded_at) {
      return retryOrFail(
        'row_not_uploaded',
        new Error(`status=${row.status} uploaded_at=${row.uploaded_at}`),
      );
    }

    const bucketName = row.gcs_bucket ?? BUCKET_DEFAULT;
    const objectPath = row.gcs_object;

    if (!bucketName || !objectPath) {
      await markError('missing_gcs_fields');
      return res.status(204).send();
    }

    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);

    const tExists0 = Date.now();
    const [exists] = await file.exists();
    const existsMs = Date.now() - tExists0;

    if (!exists) {
      return retryOrFail(
        'gcs_object_missing',
        new Error(`bucket=${bucketName} object=${objectPath} exists=false`),
      );
    }

    // Download original bytes
    const tDl0 = Date.now();
    const [origBytes] = await file.download();
    const downloadMs = Date.now() - tDl0;

    // Extract metadata
    let takenAt: Date | null = null;
    let exifJson: unknown = null;

    const tExif0 = Date.now();
    try {
      exifJson = await exifr.parse(origBytes, { translateValues: false } as any);

      const maybe =
        (exifJson as any)?.DateTimeOriginal ??
        (exifJson as any)?.CreateDate ??
        (exifJson as any)?.ModifyDate;

      if (maybe instanceof Date && !isNaN(maybe.getTime())) {
        takenAt = maybe;
      } else if (typeof maybe === 'string') {
        const d = new Date(maybe);
        if (!isNaN(d.getTime())) takenAt = d;
      }
    } catch (e) {
      log({
        type: 'photo_process_exif_warning',
        ts: nowIso(),
        photo_id: photoId,
        pubsub_message_id: pubsubMessageId,
        request_id: requestId,
        attempt,
        error: truncate(String(e), 400),
      });
    }
    const exifMs = Date.now() - tExif0;

    // Dimensions + thumbnail
    const tThumb0 = Date.now();
    const img = sharp(origBytes, { failOnError: false });
    const meta = await img.metadata();

    const width = typeof meta.width === 'number' ? meta.width : null;
    const height = typeof meta.height === 'number' ? meta.height : null;

    const thumbBytes = await img
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
    const thumbMs = Date.now() - tThumb0;

    const datePrefix = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomBytes(8).toString('hex');
    const thumbObject = `thumbnails/${datePrefix}/${photoId}_${rand}.jpg`;

    const tUp0 = Date.now();
    await bucket.file(thumbObject).save(thumbBytes, {
      contentType: 'image/jpeg',
      resumable: false,
      metadata: {
        cacheControl: 'public, max-age=31536000',
      },
    });
    const uploadThumbMs = Date.now() - tUp0;

    // Update DB
    const processingMs = Date.now() - startedAt;
    const workerMs = Date.now() - startedAt;

    const tDb0 = Date.now();
    const upd = await pool.query(
      `
  with t as (select now() as ts)
  update photos p
  set
    status='PROCESSED',
    exif_json = $2,
    taken_at = $3,
    width = $4,
    height = $5,
    thumb_bucket = $6,
    thumb_object = $7,
    processed_at = t.ts,
    processing_ms = round(extract(epoch from (t.ts - p.uploaded_at)) * 1000)::int,
    processed_attempt = greatest(coalesce(p.processed_attempt, 0), $8),
    error_reason = null,
    error_at = null
  from t
  where p.id = $1
    and p.status = 'UPLOADED'
    and p.uploaded_at is not null
  returning p.id, p.processing_ms, p.processed_at
  `,
      [photoId, exifJson ?? null, takenAt, width, height, bucketName, thumbObject, attempt],
    );
    const dbMs = Date.now() - tDb0;

    if (upd.rowCount === 0) {
      log({
        type: 'photo_process_noop',
        ts: nowIso(),
        photo_id: photoId,
        pubsub_message_id: pubsubMessageId,
        request_id: requestId,
        attempt,
        reason: 'not_uploaded_or_already_processed',
      });
      return res.status(204).send();
    }

    log({
      type: 'photo_processed',
      ts: nowIso(),
      photo_id: photoId,
      pubsub_message_id: pubsubMessageId,
      request_id: requestId,
      attempt,
      status: 'PROCESSED',
      worker_ms: workerMs,
      processing_ms: upd.rows[0].processing_ms,
      timings_ms: {
        exists_ms: existsMs,
        download_ms: downloadMs,
        exif_ms: exifMs,
        thumb_ms: thumbMs,
        upload_thumb_ms: uploadThumbMs,
        db_ms: dbMs,
      },
      image: { width, height, taken_at: takenAt?.toISOString() ?? null },
      gcs: { bucket: bucketName, object: objectPath, thumb_object: thumbObject },
    });

    return res.status(204).send();
  } catch (e) {
    return retryOrFail('unhandled_exception', e);
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => log({ type: 'worker_listening', ts: nowIso(), port }));
