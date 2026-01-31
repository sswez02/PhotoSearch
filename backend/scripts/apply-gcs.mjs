import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

const sql = `
alter table photos
  add column if not exists gcs_bucket text,
  add column if not exists gcs_object text,
  add column if not exists content_type text,
  add column if not exists size_bytes bigint,
  add column if not exists uploaded_at timestamptz;
`;

await pool.query(sql);
console.log("Applied ALTER TABLE.");
await pool.end();