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

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const BUCKET_DEFAULT = process.env.GCS_BUCKET;

// Health (protected by Cloud Run IAM in your setup)
app.get('/health', async (_req, res) => {
  const r = await pool.query('select 1 as ok');
  res.json({ ok: true, db: r.rows[0]?.ok === 1 });
});

/**
 * Pub/Sub push payload:
 * { message: { data: "base64(JSON)" }, subscription: "..." }
 * Where JSON is: { photoId: number }
 */
app.post('/tasks/process', async (req, res) => {
  const pubsubSchema = z.object({
    message: z.object({
      data: z.string().min(1),
    }),
  });

  try {
    const parsed = pubsubSchema.parse(req.body);
    const jsonStr = Buffer.from(parsed.message.data, 'base64').toString('utf8');
    const payload = JSON.parse(jsonStr);

    const photoId = Number(payload.photoId);
    if (!Number.isFinite(photoId)) return res.status(400).send('bad photoId');

    // Load row
    const r = await pool.query(
      `select id, status, gcs_bucket, gcs_object
       from photos
       where id = $1`,
      [photoId],
    );

    const row = r.rows[0] as
      | { id: number; status: string; gcs_bucket: string | null; gcs_object: string | null }
      | undefined;

    if (!row) return res.status(404).send('photo not found');

    // Idempotency: if already processed, ack the message
    if (row.status === 'PROCESSED') return res.status(204).send();

    const bucketName = row.gcs_bucket ?? BUCKET_DEFAULT;
    const objectPath = row.gcs_object;

    if (!bucketName || !objectPath) {
      // Mark error so we don't retry forever
      await pool.query(`update photos set status='ERROR' where id=$1`, [photoId]);
      return res.status(204).send();
    }

    // Download original bytes
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);

    const [exists] = await file.exists();
    if (!exists) {
      await pool.query(`update photos set status='ERROR' where id=$1`, [photoId]);
      return res.status(204).send();
    }

    const [origBytes] = await file.download();

    // Extract metadata
    let takenAt: Date | null = null;
    let exifJson: unknown = null;

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
      console.warn('exifr failed:', e);
    }

    // Dimensions + thumbnail
    const img = sharp(origBytes, { failOnError: false });
    const meta = await img.metadata();

    const width = typeof meta.width === 'number' ? meta.width : null;
    const height = typeof meta.height === 'number' ? meta.height : null;

    const thumbBytes = await img
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();

    const datePrefix = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomBytes(8).toString('hex');
    const thumbObject = `thumbnails/${datePrefix}/${photoId}_${rand}.jpg`;

    await bucket.file(thumbObject).save(thumbBytes, {
      contentType: 'image/jpeg',
      resumable: false,
      metadata: {
        cacheControl: 'public, max-age=31536000',
      },
    });

    // Update DB
    await pool.query(
      `update photos
       set status='PROCESSED',
           exif_json = $2,
           taken_at = $3,
           width = $4,
           height = $5,
           thumb_bucket = $6,
           thumb_object = $7,
           processed_at = now()
       where id = $1`,
      [
        photoId,
        exifJson ? JSON.stringify(exifJson) : null,
        takenAt,
        width,
        height,
        bucketName,
        thumbObject,
      ],
    );

    return res.status(204).send();
  } catch (e) {
    console.error(e);

    try {
      const msg = req.body?.message;
      const dataB64 = msg?.data;
      if (typeof dataB64 === 'string') {
        const jsonStr = Buffer.from(dataB64, 'base64').toString('utf8');
        const payload = JSON.parse(jsonStr);
        const photoId = Number(payload.photoId);
        if (Number.isFinite(photoId)) {
          await pool.query(`update photos set status='ERROR' where id=$1`, [photoId]);
        }
      }
    } catch {
      // ignore
    }

    return res.status(204).send();
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`worker listening on ${port}`));
