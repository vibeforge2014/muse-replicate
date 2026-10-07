#!/usr/bin/env bash
# 部署烟测（docs/OPS.md）：对运行中的 MAS 实例走一轮真实会话回路。
# 用法：BASE_URL=http://127.0.0.1:18090 MAS_API_KEY=mas_sk_... ./scripts/smoke.sh
# 成功退出码 0；任一步失败打印错误并退出 1。
set -euo pipefail

BASE_URL="${BASE_URL:?need BASE_URL, e.g. http://127.0.0.1:18090}"
KEY="${MAS_API_KEY:?need MAS_API_KEY}"
STAMP="$(date +%s)"

AUTH="authorization: Bearer ${KEY}"
CT="content-type: application/json"

jsonget() { python3 -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d)' "$1"; }

echo "[smoke] base=${BASE_URL}"

# 1. environment
ENVID=$(curl -sf -H "$AUTH" -H "$CT" -X POST "$BASE_URL/v1/environments" \
  -d "{\"name\":\"smoke-${STAMP}\",\"config\":{\"type\":\"cloud\",\"networking\":{\"type\":\"unrestricted\"}}}" | jsonget id)
echo "[smoke] environment: ${ENVID}"

# 2. agent
AGID=$(curl -sf -H "$AUTH" -H "$CT" -X POST "$BASE_URL/v1/agents" \
  -d "{\"name\":\"smoke-${STAMP}\",\"model\":{\"id\":\"glm-5.3\"}}" | jsonget id)
echo "[smoke] agent: ${AGID}"

# 3. session（agent 纯字符串引用形态）
SID=$(curl -sf -H "$AUTH" -H "$CT" -X POST "$BASE_URL/v1/sessions" \
  -d "{\"agent\":\"${AGID}\",\"environment_id\":\"${ENVID}\"}" | jsonget id)
echo "[smoke] session: ${SID}"

# 4. 投递 user.message（content 为块数组）
curl -sf -H "$AUTH" -H "$CT" -X POST "$BASE_URL/v1/sessions/${SID}/events" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"deployment smoke"}]}]}' >/dev/null
echo "[smoke] user.message sent"

# 5. 轮询 worker 回路（agent.message 出现 + 回到 idle）
for i in $(seq 1 30); do
  TYPES=$(curl -sf -H "$AUTH" "$BASE_URL/v1/sessions/${SID}/events" | python3 -c 'import json,sys; print("\n".join(e["type"] for e in json.load(sys.stdin)["data"]))')
  STATUS=$(curl -sf -H "$AUTH" "$BASE_URL/v1/sessions/${SID}" | jsonget status)
  if echo "$TYPES" | grep -q "^agent.message$" && [ "$STATUS" = "idle" ]; then
    echo "[smoke] roundtrip ok: user.message -> status_running -> agent.message -> idle"
    break
  fi
  [ "$i" = 30 ] && { echo "[smoke] FAIL: no agent roundtrip; status=${STATUS}; events:"; echo "$TYPES"; exit 1; }
  sleep 1
done

# 6. 指标端点（无 token 时开放；配置了则需 x-internal-token）
if METRICS=$(curl -sf "$BASE_URL/internal/metrics" || curl -sf -H "x-internal-token: ${MAS_INTERNAL_TOKEN:-}" "$BASE_URL/internal/metrics"); then
  echo "$METRICS" | grep -q "^mas_api_requests_total" && echo "[smoke] /internal/metrics ok"
fi

echo "[smoke] PASS"
