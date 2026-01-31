alter table photos
  add column if not exists gcs_bucket text,
  add column if not exists gcs_object text,
  add column if not exists content_type text,
  add column if not exists size_bytes bigint,
  add column if not exists uploaded_at timestamptz;