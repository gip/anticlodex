import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://localhost:5432/acx",
});

type PoolErrorLogger = {
  warn(bindings: { err: Error }, message: string): void;
};

type PoolErrorTarget = {
  on(event: "error", listener: (error: Error) => void): unknown;
};

const registeredPoolErrorTargets = new WeakSet<object>();

export function registerPoolErrorHandler(
  log: PoolErrorLogger,
  target: PoolErrorTarget = pool,
) {
  if (registeredPoolErrorTargets.has(target as object)) {
    return;
  }

  target.on("error", (error) => {
    log.warn({ err: error }, "Postgres pool client error");
  });

  registeredPoolErrorTargets.add(target as object);
}

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
