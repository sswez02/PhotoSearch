ALTER TABLE photos
  DROP CONSTRAINT IF EXISTS photos_status_check;

ALTER TABLE photos
  ADD CONSTRAINT photos_status_check CHECK (status IN ('PENDING', 'UPLOADED', 'PROCESSED', 'FAILED', 'ERROR'));

