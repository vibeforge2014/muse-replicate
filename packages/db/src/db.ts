import { Pool, type PoolConfig } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "./schema.js";

export interface DbHandle {
  pool: Pool;
  db: Kysely<Database>;
  close(): Promise<void>;
}

export function createDb(connectionString?: string): DbHandle {
  const cfg: PoolConfig = {
    connectionString: connectionString ?? process.env.DATABASE_URL ?? "postgres://mas@localhost:5433/mas_dev",
    max: 20,
  };
  const pool = new Pool(cfg);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    pool,
    db,
    async close() {
      await db.destroy();
      await pool.end();
    },
  };
}
