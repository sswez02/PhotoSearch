import { Storage } from '@google-cloud/storage';

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function getBucketName(): string {
  return must('GCS_BUCKET');
}

export function makeStorage(): Storage {
  // Cloud Run uses the attached service account automatically (ADC).
  return new Storage();
}

export async function createUploadUrl(params: {
  bucket: string;
  objectPath: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<{ uploadUrl: string }> {
  const { bucket, objectPath, contentType } = params;
  const expiresInSeconds = params.expiresInSeconds ?? 10 * 60;

  const storage = makeStorage();
  const file = storage.bucket(bucket).file(objectPath);

  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + expiresInSeconds * 1000,
    contentType,
  });

  return { uploadUrl };
}
