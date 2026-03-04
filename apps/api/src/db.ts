import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://localhost:5432/acx",
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}

export async function close() {
  await pool.end();
}

export default pool;
