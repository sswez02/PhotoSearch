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
  select column_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'photos'
  order by ordinal_position
`;

const r = await pool.query(sql);
console.log(r.rows.map(x => x.column_name));
await pool.end();