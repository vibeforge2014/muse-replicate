import { Pool } from "pg";
import { MIGRATIONS } from "./migrations.js";

export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    // 会话级 advisory lock 串行化并发迁移（server/worker 同时启动、多副本部署）：
    // 后到者阻塞至先到者提交，随后看到 __migrations 已应用直接跳过。
    await client.query("SELECT pg_advisory_lock(hashtext('mas_migrations'))");
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS __migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied = new Set(
        (await client.query<{ name: string }>("SELECT name FROM __migrations")).rows.map((r) => r.name),
      );
      const ran: string[] = [];
      for (const m of MIGRATIONS) {
        if (applied.has(m.name)) continue;
        await client.query("BEGIN");
        try {
          await client.query(m.sql);
          await client.query("INSERT INTO __migrations (name) VALUES ($1)", [m.name]);
          await client.query("COMMIT");
          ran.push(m.name);
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
      return ran;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('mas_migrations'))");
    }
  } finally {
    client.release();
  }
}

const url = process.env.DATABASE_URL;
if (url && process.argv[1]?.includes("migrate")) {
  const pool = new Pool({ connectionString: url });
  const ran = await runMigrations(pool);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
  await pool.end();
}
