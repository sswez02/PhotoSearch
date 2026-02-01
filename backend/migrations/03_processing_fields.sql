ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS exif_json jsonb,
  ADD COLUMN IF NOT EXISTS width int,
  ADD COLUMN IF NOT EXISTS height int,
  ADD COLUMN IF NOT EXISTS taken_at timestamptz,
  ADD COLUMN IF NOT EXISTS thumb_bucket text,
  ADD COLUMN IF NOT EXISTS thumb_object text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

