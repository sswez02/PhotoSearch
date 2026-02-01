ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS error_reason text,
  ADD COLUMN IF NOT EXISTS error_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_ms int,
  ADD COLUMN IF NOT EXISTS processed_attempt int;

CREATE INDEX IF NOT EXISTS photos_status_idx ON photos(status);

