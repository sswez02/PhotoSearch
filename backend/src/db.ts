import { Pool } from 'pg';

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * For Cloud Run + Cloud SQL:
 * - set INSTANCE_CONNECTION_NAME and DB creds
 * - connect via Unix socket at /cloudsql/<connectionName>
 */
export function makePool(): Pool {
  const dbHost = process.env.INSTANCE_CONNECTION_NAME
    ? `/cloudsql/${must('INSTANCE_CONNECTION_NAME')}`
    : (process.env.PGHOST ?? '127.0.0.1');

  return new Pool({
    host: dbHost,
    port: Number(process.env.PGPORT ?? 5432),
    database: must('PGDATABASE'),
    user: must('PGUSER'),
    password: must('PGPASSWORD'),
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}
