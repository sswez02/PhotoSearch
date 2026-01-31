CREATE TABLE IF NOT EXISTS photos(
  id bigserial PRIMARY KEY,
  original_filename text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'UPLOADED', 'PROCESSED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

