import Fastify from "fastify";

async function test(name: string, setup: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify({ logger: false });
  setup(app);
  app.get("/healthz", async () => ({ ok: true }));
  const r = await Promise.race([
    app.inject({ method: "GET", url: "/healthz" }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), 2000)),
  ]).catch((e) => ({ statusCode: String(e?.message ?? e) }));
  console.log(name, "→", (r as { statusCode: unknown }).statusCode);
  await app.close();
}

await test("bare", () => {});
await test("noop-async", (app) => {
  app.addHook("onRequest", async () => {});
});
await test("noop-sync", (app) => {
  app.addHook("onRequest", () => {});
});
process.exit(0);
