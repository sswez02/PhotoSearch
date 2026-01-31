alter table photos
  add column if not exists exif_json jsonb,
  add column if not exists width int,
  add column if not exists height int,
  add column if not exists taken_at timestamptz,
  add column if not exists thumb_bucket text,
  add column if not exists thumb_object text,
  add column if not exists processed_at timestamptz;