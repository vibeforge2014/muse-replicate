import { afterAll, describe, expect, test } from "vitest";
import { Client, Pool } from "pg";
import { runMigrations } from "../packages/db/src/migrate.ts";
import { MIGRATIONS } from "../packages/db/src/migrations.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

/**
 * 并发迁移回归（部署实测暴露）：server/worker 同时启动会在 CREATE TYPE 上
 * 撞 pg_type 唯一键。advisory lock 后：并发 runMigrations 全部成功、恰好应用一次。
 */

let env: TestEnv;
const tempDbs: string[] = [];

afterAll(async () => {
  for (const db of tempDbs) {
    const c = new Client({ connectionString: `${process.env.DATABASE_URL!.replace(/\/[^/]+$/, "/postgres")}` });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await c.end();
  }
});

describe("migrations 并发（advisory lock）", () => {
  test("8 路并发 runMigrations 全部成功且恰好应用一次", async () => {
    env = await setupEnv();
    const dbName = `mas_migration_race_${Date.now().toString(36)}`;
    const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, "/postgres") });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    tempDbs.push(dbName);
    await admin.end();

    const pool = new Pool({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, `/${dbName}`), max: 8 });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => runMigrations(pool).then(
          (ran) => ({ ok: true as const, ran }),
          (e) => ({ ok: false as const, error: String(e) }),
        )),
      );
      const failures = results.filter((r) => !r.ok);
      expect(failures).toEqual([]);
      // 每个迁移在任何成功返回里至多出现一次；全部迁移都被应用
      const allRan = results.flatMap((r) => (r.ok ? r.ran : []));
      const names = new Set(allRan);
      expect(names.size).toBe(allRan.length); // 无重复应用
      expect(names.size).toBe(MIGRATIONS.length); // 全量
      void env;
    } finally {
      await pool.end();
    }
  });
});
