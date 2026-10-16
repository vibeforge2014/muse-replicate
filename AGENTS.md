# AGENTS.md

Workspace instructions for ZCode agents working on this repository.

## What this is

企业私有化 Managed Agents 平台（Meta Muse 复刻）—— a self-hosted MAS platform that drives `codex app-server` inside isolated sandboxes. TypeScript monorepo, pnpm workspace, Node.js 22 LTS.

## Monorepo layout

```
apps/
  server/      — Fastify HTTP API (event admission, SSE, CRUD, deployments, webhooks)
  worker/      — session runner (claim → fence → drive runtime → settle → checkpoint)
  egress-proxy/— sandbox egress gateway (credential injection, TLS termination, denylist)
  model-gateway/— Responses API proxy (usage metering, token injection)
packages/
  core/        — shared types, errors, otel, dialect detection
  db/          — Kysely migrations + repos (schema, sessions, events, executions)
  runtime/     — AgentRuntimeDriver interface + FakeCodexDriver + CodexDriver
  sdk/         — generated TS client (@mas/sdk, OpenAPI 3.1 → schema.d.ts)
  egress/      — egress token signing, CA management, TLS
  sandbox/     — SandboxProvider interface + Fake/Docker/K8s/K8sCrd/OpenSandbox providers
```

## Commands

| Task | Command |
| --- | --- |
| Run all tests | `pnpm test` |
| Run one test file | `pnpm vitest run tests/steer.test.ts` |
| Watch mode | `pnpm test:watch` |
| Typecheck all packages | `pnpm -r typecheck` |
| Build | `pnpm build` |
| Migrate DB | `pnpm migrate` |
| Chaos gate (release) | `pnpm test:chaos 200` |
| Perf harness | `pnpm perf` |
| Generate SDK | `pnpm gen:sdk` |

## Test environment

- Postgres container `mas-test-pg` on `127.0.0.1:5433` (user `mas`, DBs `mas_test` + `mas_demo`, trust auth).
- Tests auto-start an api+worker pair per test file via `tests/helpers.ts` → `setupEnv()`.
- FakeCodexDriver is the default runtime (zero codex quota consumption). Real CodexDriver E2E is gated behind `MAS_CODEX_E2E=1`.
- K8s/Docker/OpenSandbox E2E tests are gated behind `MAS_K8S_E2E=1` / `MAS_DOCKER_E2E=1` / `MAS_OSB_E2E=1`.

## Authoritative references

- `spec.md` — full backend architecture spec (chapters §1–§19).
- `plan.md` — milestone execution plan.
- `test-case-plan.md` — acceptance test cases (AGT/ENV/SES/EVT/TOOL/CT/DEP/MEM/SKL/…).
- `docs/DESIGN.md` — capability matrix, design-to-spec mapping, known deviations.
- `docs/OPS.md` — deployment, backup, troubleshooting, alerting.
- `docs/openapi.yaml` — API contract (74 routes, zero-drift with fastify registry).

## Architecture boundaries

- **API (apps/server)** writes user input to `session_events` (queued, `processed_at=null`) and manages CRUD. Never drives runtime.
- **Worker (apps/worker)** claims executions via `FOR UPDATE SKIP LOCKED`, holds a fence (generation), drives the runtime driver, appends normalized events, settles. Single writer per session at any time.
- **Runtime driver (packages/runtime)** — `AgentRuntimeDriver` interface with two implementations:
  - `FakeCodexDriver` — scripted JSON-RPC over stdio subprocess (`packages/runtime/fake-codex.mjs`), used by all tests.
  - `CodexDriver` — drives real `codex app-server` (v2 protocol). `MAS_RUNTIME_DRIVER=codex` to activate.
- **SandboxProvider (packages/sandbox)** — `Fake` / `Docker` (gVisor) / `K8s` (Pod) / `K8sCrd` (CR) / `OpenSandbox` providers behind a single interface.

## Key patterns and gotchas

### Kysely

- **`orderBy("col1", "col2")` does NOT work** — the second arg is parsed as a direction expression, not a column. Use separate calls: `.orderBy("col1").orderBy("col2")`.
- **PostgreSQL arrays are 1-indexed** — `input_event_ids[1]` is the first element, not `[0]`.
- Concurrency primitives: `FOR UPDATE SKIP LOCKED` for claim, `generation` for fencing (compare-and-swap on update).
- Migrations are **forward-only, append-only** — add new entries to `packages/db/src/migrations.ts`, never modify published ones.

### Events API

- POST events returns **201** for creates, **200** for admits (idempotency replay).
- GET events strips `seq` — payload fields are spread top-level (`e.content`, not `e.payload.content`).
- Queued events have `processed_at=null`; processed events have monotonically unique `seq`.

### Testing

- `tests/helpers.ts` provides `setupEnv()`, `call()`, `createSession()`, `listEvents()`, `makeAgentAndEnv()`, `waitFor()`.
- FakeCodexDriver echo behavior: input `"echo: X"` → reply `"X"` (prefix stripped); plain input → reply `"echo: X"` (prefix added). Match expectations accordingly.
- FakeCodexDriver steer behavior: `"sleep N"` sets activeTurns flag; `consumeSteers()` at sleep-end emits `item/started{itemType:"userMessage"}` + `agentMessage "ack steer: <text>"`.
- Agent `metadata.steer_mode` controls steer classification: `"auto"` (default, steer during running) vs `"queue"` (opt-out, strict FIFO).

## Constraints

- **Never commit secrets** — `auth.json`, API keys, passwords, tokens. `.env` is gitignored. Dev MinIO/egress-secret defaults are documented change-me values.
- **`.video_agent/` is the user's** — do not touch, modify, or commit it.
- **Do not disturb the user's homelab cluster** — only operate in the `mas` namespace. Other namespaces (migrated-dify/gitlab/supabase/aigw/openproject/n8n) are off-limits.
- **Running real codex turns consumes account quota** — always gated behind `MAS_CODEX_E2E=1`.
- **Git remote**: `vibeforge2014/muse-replicate`. Commit and push when the user asks.
