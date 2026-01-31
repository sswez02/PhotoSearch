ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS gcs_bucket text,
  ADD COLUMN IF NOT EXISTS gcs_object text,
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;

