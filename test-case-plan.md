# BigModel Managed Agents API 验收测试用例计划书（test-case-plan）

> 版本：v0.2｜日期：2026-10-05（v0.2：增加 T-C 官方 SDK 黑盒目标、§5.17 SEC、§5.18 ORD、§5.19 REC，以及 §5.20 确定性混沌车道；依据 `open-managed-agents-调研报告.md` §4 的 T3/T8/T11）
> 被测对象：
> - **T-A**：智谱 BigModel Managed Agents（`https://agent-api.bigmodel.cn/api/agent/managed/v1`，`zai-version: 2026-05-26`，`zai-beta: managed-agents-2026-05-26`）
> - **T-B**：自建平台（`spec.md`），以 BigModel 方言运行
> - **T-C**：自建平台，用**官方 Anthropic SDK**（`@anthropic-ai/sdk`，`client.beta.agents/environments/sessions`，`anthropic-beta: managed-agents-2026-04-01`）黑盒运行，验证 Anthropic 方言的兼容性（spec §12.3）
>
> 依据文档：
> - OpenAPI `openapi-managed-agents.json`，76 个 operation，存档于 `research/bigmodel-raw/openapi.json`
> - 19 篇指南页，存档于 `research/bigmodel-raw/*.md`
> - 逐端点字段表：`research/bigmodel-endpoints-reference.md`
> - 文档完整性评估：`managed-agents-调研报告.md` §6

---

## 1. 可行性结论

**可行。** OpenAPI 覆盖了全部端点的路径、参数和请求/响应结构；指南正文给出了大量可以断言的行为约束（上限、枚举、状态前置条件、错误类型、事件顺序）。
不足之处在于：OpenAPI 缺少逐端点的错误码，事件 payload 没有 schema，示例很少。因此采用**三层断言来源**，每个用例标注来源等级：

| 来源等级 | 含义 | 失败时的处理 |
| --- | --- | --- |
| **S**（Spec） | OpenAPI 明确定义的结构、必填、枚举、成功码 | 判定为平台缺陷 |
| **G**（Guide） | 指南正文明确写出的行为或错误码 | 判定为平台缺陷，或文档与实现不一致（两者都要报告） |
| **P**（Probe） | 文档空白或含糊，只记录实际行为，不做通过/失败判定 | 首轮建立基线；之后基线漂移时告警 |

---

## 2. 范围

### 2.1 纳入范围（76 个 operation）

| 模块 | Operation 数 | 优先级 |
| --- | --- | --- |
| Agents | 6 | P0 |
| Environments | 6 | P0 |
| Sessions（含 resources） | 10 | P0 |
| Events（send / list / stream） | 3 | P0 |
| Files | 5 | P1 |
| Vaults / Credentials | 13 | P1 |
| Memory Stores / Memories / Versions | 14 | P1 |
| Skills / Versions | 9 | P2 |
| Deployments / Runs | 10 | P2 |

横切关注点：鉴权、版本 header、错误信封、分页、metadata 规则、限流、加密与 checkpoint header。

### 2.2 不在范围内

- Web Search / Web Fetch：文档注明尚未开放。
- 控制台：未上线。
- IM 渠道会话：只验证其 409 `operation_not_supported` 行为，不验证渠道本身。
- 模型输出质量。验收只断言协议与状态，不断言回答内容；内容只做"存在非空 text"这类弱断言。
- `user.define_outcome`、`system.message`、`agent.thread_*`、`span.outcome_*`：这些类型在 OpenAPI 枚举中出现，但正文没有定义，只做 P 级探测（§5.11）。

---

## 3. 测试框架设计

### 3.1 技术选型

| 项 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript | 与 `spec.md` 一致 |
| 测试运行器 | Vitest | 按文件并发，文件内串行 |
| HTTP 客户端 | undici | |
| Schema 校验 | 由 OpenAPI 生成的 Zod（`openapi-zod-client` 或 `orval`）+ 手写事件 schema（`schemas/events.ts`，标注 G） | |
| SSE 客户端 | 自研 | 解析 `event:` / `data:` / 注释帧，记录帧到达时间 |
| 报告 | JUnit + HTML（vitest-html-reporter） | 附带每个用例的请求/响应 trace（key 脱敏） |

### 3.2 方言层

```ts
interface Dialect {
  baseUrl: string;
  headers(): Record<string, string>;
  toolsetType: string;            // "agent_toolset_20260601"
  defaultModel: string;           // "glm-5.3-flash"（成本低）
  visionModel: string;            // "glm-5.3-flash"
  idPrefix: { session: "sess_" | "sesn_" };
}
```

- T-A 使用 `bigmodel`，T-B 使用 `mas-bigmodel-compat`。T-B 的 ID 前缀不同，用例中**不硬编码前缀**，统一通过 `dialect.idPrefix` 断言。
- **T-C 不使用自研 HTTP 客户端**，直接调用官方 SDK，`baseURL` 指向本平台（借鉴 OpenMA ADR 0005 的"官方 SDK 黑盒"做法）。这样能发现自研客户端测不出的问题：SDK 的请求形态、分页游标、SSE 解析、错误类型映射、重试 header。
  - 范围：AGT / ENV / SES / EVT-S / EVT-L / EVT-R / TOOL / VLT / FILE 中的 P0 用例，按 Anthropic 方言改写（工具集 `agent_toolset_20260401`、`x-api-key`、409 为 `conflict_error` 等）。
  - 约 45 个用例，复用同一套 fixture 和清理器。
  - SDK 版本固定，升级时先跑 T-C，差异记入方言白名单。

### 3.3 资源管理

- 每次运行生成 `run_id`，所有资源的 `metadata.test_run = run_id`，`name` 前缀为 `acc-<run_id>-`。
- `afterAll` 清理顺序：sessions（先 interrupt，再 archive 或 delete）→ deployments archive → agents archive（Agent 没有删除接口）→ environments delete → files / skills / memory stores / vaults delete。
- 夜间清理任务：按 `metadata.test_run` 扫描超过 24 小时的残留资源并清理。
- 成本控制：
  - 需要模型推理的用例统一使用 `glm-5.3-flash`、`effort: low`，提示词极短（例如"回复 OK"）。
  - 需要工具调用的用例使用确定性提示（例如"用 bash 执行 `echo acc-<nonce>`"）。
  - **每轮全量运行的推理用例不超过 60 个**。

### 3.4 等待与超时工具

| 工具函数 | 行为 |
| --- | --- |
| `waitForStatus(session, status, {timeout: 120s})` | 轮询 GET session，间隔 1 秒 |
| `collectStream(session, until: (ev)=>boolean, {timeout})` | 先开 SSE，再执行动作，按条件收集帧 |
| `runTurn(session, text)` | 开流 → 发送 `user.message` → 收集到 `session.status_idle` 为止 → 返回事件序列 |

### 3.5 限流规避

- 测试客户端内置令牌桶：写 8 次/秒，读 40 次/秒，低于官方的 10 和 50。
- 遇到 429 时按 `retry-after` 重试，最多 3 次。限流用例本身（§5.13）除外。

---

## 4. 通用断言（所有用例自动执行）

| ID | 断言 | 来源 |
| --- | --- | --- |
| C-01 | 成功响应能通过 OpenAPI 响应 schema 校验（允许多余字段） | S |
| C-02 | 错误响应为 `{type:"error", error:{type,message}, request_id}`，`request_id` 以 `req_` 开头 | G |
| C-03 | HTTP 状态码与 `error.type` 一致：400/422→`invalid_request_error`，401→`authentication_error`，403→`permission_error`，404→`not_found_error`，409→`invalid_request_error`，413→`request_too_large`，429→`rate_limit_error`，5xx→`api_error`/`timeout_error`/`overloaded_error` | G |
| C-04 | 时间戳字段符合 RFC 3339，且为 UTC | G |
| C-05 | ID 字段带有约定前缀（agent_/env_/sess_/sevt_/file_/sesrsc_/memstore_/vlt_/vcrd_/skill_/depl_/drun_） | G |
| C-06 | 列表响应为 `{data:[], next_page}`（Files 用 before_id/after_id 分页的结构） | S |

---

## 5. 用例清单

编号规则：`<模块>-<序号>`。优先级 P0/P1/P2。来源 S/G/P。类型：**F** 正向，**N** 负向/边界，**L** 生命周期/状态，**E** 事件流，**X** 跨资源。

### 5.1 鉴权与通用（AUTH / GEN）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| AUTH-01 | 不带 Authorization | 401 `authentication_error` | P0 | G |
| AUTH-02 | API Key 无效 | 401 | P0 | G |
| AUTH-03 | 缺少 `zai-version` | 400（P：记录实际状态码） | P0 | S/P |
| AUTH-04 | `zai-version` 取非枚举值（如 `2026-01-01`） | 400 | P0 | S |
| AUTH-05 | 缺少 `zai-beta` | 400（P） | P0 | P |
| AUTH-06 | `zai-beta` 带多个值（逗号分隔，含 managed-agents-2026-05-26） | 200 | P1 | G |
| AUTH-07 | 用账号 B 的 key 访问账号 A 的资源 | 404 `not_found_error`（不是 403） | P0 | G |
| GEN-01 | 写请求的 `content-type` 不是 JSON | 400/415（P） | P2 | P |
| GEN-02 | 请求体中出现未知字段（如 Agent 的 `foo`） | 400 | P1 | G |
| GEN-03 | metadata：16 个键成功，17 个键返回 400；键长 64 成功、65 返回 400；值长 512 成功、513 返回 400；值为非字符串返回 400 | 如上 | P1 | G |
| GEN-04 | metadata 更新：只传部分键时按键合并；值为 null 删除该键；metadata 整体为 null 时清空 | 如上 | P1 | G |
| GEN-05 | 分页：创建 25 个 Agent，`limit=10` 翻 3 页，结果无重复、无遗漏；最后一页 `next_page=null` | 如上 | P0 | G |
| GEN-06 | `limit=101` 截断为 100（不报错） | 如上 | P2 | G |
| GEN-07 | `order=asc` 与 `order=desc` 的顺序相反 | 如上 | P1 | G |
| GEN-08 | 篡改 `page` 游标 | 400 | P2 | P |
| GEN-09 | 响应头带 request-id（P：记录头名称） | 如上 | P2 | P |

### 5.2 Agents（AGT）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| AGT-01 | 最小创建 `{name, model:"glm-5.3-flash"}` | **201**；version=1；tools=[]；`multiagent=null`；`archived_at=null` | P0 | S/G |
| AGT-02 | 完整创建（system、description、`tools:[agent_toolset_20260601 + configs]`、custom 工具、mcp_servers + mcp_toolset、metadata） | 201；tools 规范化后补全 `default_config` 与 `configs` | P0 | G |
| AGT-03 | `model` 为对象 `{id:"glm-5.3", effort:"high"}` | 回显 `model{id,effort,speed}` | P1 | G |
| AGT-04 | 省略 `model` | P：记录是 400，还是默认 glm-5.3（文档与 OpenAPI 矛盾，G5） | P1 | P |
| AGT-05 | name 为空 / 257 字符 | 400 | P1 | G |
| AGT-06 | system 长 100001；description 长 2049 | 400 | P2 | G |
| AGT-07 | tools 129 个；mcp_servers 21 个；skills 21 个 | 400 | P2 | G |
| AGT-08 | custom 工具名不合法（`a b`、以 `mcp__x` 开头、长 129、重名） | 400 | P1 | G |
| AGT-09 | custom 工具的 `input_schema.type != "object"` | 400 | P1 | G |
| AGT-10 | configs 中出现重复的 name | 400 | P2 | G |
| AGT-11 | mcp_server 的 url 不是 https、含凭据（`https://u:p@`）、含 fragment、长度超过 2048 | 400 | P1 | G |
| AGT-12 | 声明了 mcp_server 但没有对应的同名 mcp_toolset，或 mcp_toolset 指向不存在的 server | 400 | P1 | G |
| AGT-13 | 使用 Anthropic 工具集 `agent_toolset_20260401` | P：记录是否返回 400（兼容性观测点） | P1 | P |
| AGT-14 | 挂载 skills 但 tools 不含 agent_toolset_20260601 | 400 | P2 | G |
| AGT-15 | GET 获取；GET 不存在的 ID | 200 / 404 | P0 | S/G |
| AGT-16 | 更新 name | version 变为 2；`updated_at` 变化 | P0 | G |
| AGT-17 | **无变化更新**（提交相同值） | version 不变 | P0 | G |
| AGT-18 | 乐观锁：带 `version=1`，而当前已是 2 | 409 | P0 | G |
| AGT-19 | 数组整体替换：tools 传 `[]` 或 null 均清空 | 如上 | P1 | G |
| AGT-20 | system/description 传 null 时清空；name/model 传 null 返回 400 | 如上 | P1 | G |
| AGT-21 | 把 GET 回来的对象原样 POST（含 multiagent 等只读字段） | 400 | P1 | G |
| AGT-22 | 列出版本：3 次有效更新后共 3 个版本，每个版本是完整快照，版本号递增 | 如上 | P0 | G |
| AGT-23 | 归档 | `archived_at` 有值；重复归档幂等返回 200 | P0 | G |
| AGT-24 | 归档后更新 | 409/400（P：记录状态码） | P1 | G/P |
| AGT-25 | 归档后用它创建会话失败；归档前创建的会话仍可继续对话 | 如上 | P0 | G/X |
| AGT-26 | list 默认不含已归档 Agent；`include_archived=true` 时包含 | 如上 | P1 | G |
| AGT-27 | Agent 没有 DELETE 接口 | `DELETE /v1/agents/{id}` 返回 404 或 405（P） | P2 | P |

### 5.3 Environments（ENV）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| ENV-01 | 最小创建 `{name, config:{type:"cloud"}}` | **200**；networking 默认为 unrestricted；packages 的 6 个字段都出现（规范化） | P0 | S/G |
| ENV-02 | `limited`：`allowed_hosts` 合法；`allow_package_managers` 默认 false；`allow_mcp_servers` 默认 false | 回显正确 | P0 | G |
| ENV-03 | `allowed_hosts` 带协议、端口或路径 | 400 | P1 | G |
| ENV-04 | `allowed_hosts` 257 项 | 400 | P2 | G |
| ENV-05 | `unrestricted` 下携带 `allowed_hosts` | 400 | P1 | G |
| ENV-06 | 声明了 packages，但网络为 limited 且 `allow_package_managers=false` | 400 | P1 | G |
| ENV-07 | packages：某一类 201 项；单项含空白；单项以 `-` 开头；单项长度超过 256 | 400 | P1 | G |
| ENV-08 | 自定义 registry 字段 | 400 "Extra inputs are not permitted" | P2 | G |
| ENV-09 | 更新：config 整体替换（不传 packages 时被清空）；metadata 按键合并 | 如上 | P0 | G |
| ENV-10 | 更新已归档的 Environment | **400**（不是 409） | P1 | G |
| ENV-11 | 归档后创建会话失败 | 400/409（P） | P0 | G/P |
| ENV-12 | 删除 Environment，引用它的会话下次运行时得到 not found 或 terminated（P） | 如上 | P1 | G/P |
| ENV-13 | 快照语义：会话创建后更新 Environment，已有会话的沙箱不受影响（在沙箱中验证包是否存在） | 如上 | P2 | G/X |
| ENV-14 | GET、list、`include_archived` | 如上 | P1 | S |

### 5.4 Sessions（SES）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| SES-01 | 创建 `{agent:"<id>", environment_id}` | **200**；status=idle；`agent.version` 为最新版本；usage 全为 0；`budget=null` | P0 | S/G |
| SES-02 | agent 为对象 `{type:"agent", id, version:1}`，在 Agent 已有 v2 时创建 | 会话中 agent.version=1 | P0 | G |
| SES-03 | 固定到不存在的 version | 400，message 中包含最新版本号 | P1 | G |
| SES-04 | `agent_with_overrides` 覆盖 system 和 tools | 会话快照使用覆盖后的值（整体替换）；Agent 本身不产生新版本 | P1 | G |
| SES-05 | 缺少 `agent` 或 `environment_id` | 400 | P0 | S |
| SES-06 | `initial_events`：1 条 user.message | 创建后进入 running，之后 idle(end_turn) | P0 | G/L |
| SES-07 | `initial_events` 51 条；包含非 user.message；包含 document 块 | 400 | P1 | G |
| SES-08 | title 257 字符 | 400 | P2 | G |
| SES-09 | `vault_ids` 21 个；有重复；不存在 | 400/404（P） | P1 | G/P |
| SES-10 | resources：501 个 file；9 个 memory_store | 400 | P2 | G |
| SES-11 | 创建 header `x-checkpoint: true`、`x-checkpoint-ttl: 7` | 200 | P1 | G |
| SES-12 | `x-checkpoint: True` / `1` / `yes` | 400 | P1 | G |
| SES-13 | 只传 `x-checkpoint-ttl` 不传 `x-checkpoint`；ttl 取 0 或 31 | 400 | P2 | G |
| SES-14 | `x-events-encrypted: true`，但账号未登记密钥 | 400，且不创建会话（随后 list 中看不到） | P2 | G |
| SES-15 | list 过滤：agent_id、`agent_version`（单独传时返回 400，需配合 agent_id）、`statuses[]` 多值、`created_at[gte]`、`include_archived` | 如上 | P1 | G |
| SES-16 | 更新 title（任意状态都可以）；title 传 null 清空 | 如上 | P1 | G |
| SES-17 | idle 时更新 `agent.tools`：整体替换，下一轮生效 | 如上 | P1 | G |
| SES-18 | running 时更新 `agent.tools` | 409 `session_not_idle` | P0 | G/L |
| SES-19 | 更新 model / system / vault_ids / environment_id | 400 | P1 | G |
| SES-20 | 空 body 更新 | 400 | P2 | G |
| SES-21 | 归档 idle 会话 | 200，`archived_at` 有值 | P0 | G |
| SES-22 | **重复归档** | **409 `session_archived`** | P0 | G |
| SES-23 | 归档 running 会话 | 409 | P0 | G/L |
| SES-24 | 归档后更新，或归档后发事件 | 409 `session_archived` / 4xx（P） | P1 | G/P |
| SES-25 | 删除 running 会话 | 409 | P0 | G/L |
| SES-26 | 删除 idle 会话 | `{id, type:"session_deleted"}`；之后 GET 返回 404 | P0 | G |
| SES-27 | 删除已归档会话 | 成功 | P1 | G |
| SES-28 | 删除会话后，挂载的 File 仍然存在 | 如上 | P1 | G/X |
| SES-29 | 状态枚举只能是 idle/running/rescheduling/terminated | 如上 | P0 | S |

### 5.5 Events — 发送（EVT-S）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| EVT-S01 | idle 时发送 1 条 user.message（text） | 200；返回已持久化的事件（带 sevt_ id）；会话进入 running | P0 | S/G |
| EVT-S02 | 一批 0 条；一批 11 条 | 400 | P0 | G |
| EVT-S03 | **原子性**：一批中 1 条合法 + 1 条非法 | 400，且历史中**两条都没有**写入 | P0 | G |
| EVT-S04 | content 21 块 | 400 | P1 | G |
| EVT-S05 | image：base64 png，使用 flash 模型 | 200；使用 glm-5.3（非视觉模型）时返回 400 | P1 | G |
| EVT-S06 | 4 张图片；单张解码后大于 5 MB；使用 `image_url` 写法；不带 source | 400 | P1 | G |
| EVT-S07 | document 块（text source / file source） | 200 | P2 | G |
| EVT-S08 | 未知事件类型 | 400 | P1 | S |
| EVT-S09 | idle(end_turn) 时发送 user.interrupt | 200；状态不变；interrupt 写入历史 | P1 | G/L |
| EVT-S10 | `user.custom_tool_result` 缺少 `custom_tool_use_id` | 400 | P1 | S |
| EVT-S11 | `user.tool_confirmation` 的 `result=deny` 并带 `deny_message`；`result=allow` 但带了 `deny_message` | 200 / 400（P） | P2 | G/P |

### 5.6 Events — 历史（EVT-L）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| EVT-L01 | 一轮对话后 list events | 默认按 asc 排序；包含 user.message、session.status_running、agent.message、session.status_idle；id 唯一 | P0 | G |
| EVT-L02 | `limit` 默认 100；翻页时 `next_page` 作为 `page` 传入 | 如上 | P1 | G |
| EVT-L03 | `types=agent.message`，以及 `types=a,b`、重复参数写法 | 只返回指定类型 | P1 | G |
| EVT-L04 | `types` 取未知类型 | 400 | P1 | G |
| EVT-L05 | `created_at[gte]=<某事件的 processed_at>` | 返回 processed_at 大于等于该值的事件（**验证实际比较的是 processed_at**） | P1 | G |
| EVT-L06 | 没有 `id` 的预览帧（event_start/event_delta）**不出现**在历史中 | 如上 | P1 | G |
| EVT-L07 | 每条事件都能通过手写事件 schema（`schemas/events.ts`）校验 | 如上 | P0 | G |

### 5.7 Events — 实时流（EVT-R）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| EVT-R01 | 先开流再发消息 | 依次收到 user.message（带 processed_at）→ session.status_running → … → agent.message → session.status_idle(end_turn) | P0 | G/E |
| EVT-R02 | **只推实时**：在一轮对话结束后开流 | 收不到旧事件 | P0 | G |
| EVT-R03 | 心跳：保持空闲 40 秒 | 至少收到 2 个 `: ping` 注释帧，间隔约 15 秒 | P1 | G |
| EVT-R04 | 带非白名单参数（`?types=x`、`?limit=1`） | 400 | P1 | G |
| EVT-R05 | `event_deltas[]=agent.message` | 出现 `event: event_start` → 若干 `event_delta` → 完整 agent.message；把 delta 拼接后与最终 text 一致 | P1 | G/E |
| EVT-R06 | `event_deltas` 取非法值；合计超过 100 项 | 400 | P2 | S |
| EVT-R07 | `beta=false` | 400 | P2 | S |
| EVT-R08 | **断线恢复**：轮次进行中断开流，重新开流，并用 `created_at[gte]=最后一个非空 processed_at` 补拉历史，按 id 去重后合并 | 合并后的序列与轮次结束后 list 得到的序列一致（集合相等） | P0 | G/E |
| EVT-R09 | 删除会话时，流先收到 `session.deleted`，然后服务端关闭连接 | 如上 | P1 | G |
| EVT-R10 | 同一会话同时开 2 条流 | 两条流收到相同事件 | P2 | P |

### 5.8 工具、权限与中断（TOOL）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| TOOL-01 | always_allow 下执行 bash（`echo acc-<nonce>`） | 出现 agent.tool_use(name=bash, evaluated_permission=allow) → agent.tool_result（含 nonce，`is_error=false`） | P0 | G/E |
| TOOL-02 | 省略 tools 时（等于空数组）没有内置工具：要求执行 bash | 不出现 agent.tool_use | P1 | G |
| TOOL-03 | `configs:[{name:"bash", enabled:false}]` | 不出现 bash 的 tool_use | P1 | G |
| TOOL-04 | **always_ask**：tool_use 之后出现 `idle{stop_reason:requires_action, event_ids:[tool_use.id]}` | 如上 | P0 | G/L |
| TOOL-05 | 对 TOOL-04 回送 `user.tool_confirmation(allow)` | 进入 running，出现 tool_result，最终 idle(end_turn) | P0 | G/L |
| TOOL-06 | 回送 deny + deny_message | 工具不执行；agent 能感知被拒绝；最终 idle | P0 | G |
| TOOL-07 | requires_action 期间发送 user.message | **400**，整批被拒，消息不排队 | P0 | G |
| TOOL-08 | requires_action 期间发送 interrupt + message 同一批 | 400 | P1 | G |
| TOOL-09 | requires_action 期间单独发送 interrupt | 整组作废，出现 idle(end_turn)；之后对原 event_ids 提交 confirmation 返回 **409** | P0 | G |
| TOOL-10 | 对已解决的 tool_use 再次提交 confirmation | 409 | P1 | G |
| TOOL-11 | confirmation 指向未知 ID、其他会话的 ID，或类型不匹配（拿 custom_tool_use 的 ID 去 confirm） | 404 | P1 | G |
| TOOL-12 | 同一批中两条 resolution 指向同一个事件 | 400 | P2 | G |
| TOOL-13 | **custom 工具**：出现 agent.custom_tool_use → idle(requires_action) → 回送 `user.custom_tool_result` → 继续执行 | 如上 | P0 | G/L |
| TOOL-14 | custom_tool_result 带 `is_error=true` | agent 继续执行（P：只记录行为） | P2 | G/P |
| TOOL-15 | **running 时中断**：长任务（`sleep 60`）期间发送 user.interrupt | 流顺序为 user.interrupt →（若模型请求在途）span.model_request_end(is_error=true) → idle(end_turn)；**不出现 session.error**；约 3 秒宽限后进程被杀（验证 60 秒内结束） | P0 | G/E |
| TOOL-16 | MCP：连接公共测试 MCP server（或团队自建的 https MCP mock），always_allow | 出现 agent.mcp_tool_use / mcp_tool_result（含 `mcp_server_name`） | P1 | G |
| TOOL-17 | MCP server 不可达 | 创建会话成功（不做预检）；运行时出现 session.error（含 mcp_server_name） | P1 | G |
| TOOL-18 | MCP toolset 默认权限策略（P：观察是 always_allow 还是 always_ask） | 记录 | P2 | P |
| TOOL-19 | 内置工具集包含 read/write/edit/grep/find/ls：逐个触发，tool_use 的 name 与工具集一致 | 如上 | P2 | G |

### 5.9 沙箱与持久化（SBX）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| SBX-01 | 环境信息：`cat /etc/os-release`、`uname -m`、`whoami`、`pwd` | Ubuntu 24.04、x86_64、root、/workspace | P1 | G |
| SBX-02 | 预装软件：python3.11 / node 22 / go 1.24 / java 21 的版本 | 如上 | P2 | G |
| SBX-03 | `/mnt/session/outputs` 写文件后，轮次结束时登记为 Session File；`GET /v1/files?scope_id=<sess>` 能列出并下载，内容一致 | 如上 | P0 | G/X |
| SBX-04 | 未开 checkpoint：第 1 轮写 `/workspace/a.txt`，第 2 轮读取 | P：文档说"默认不跨轮保留"，记录实际行为（同一沙箱存活期间可能仍在） | P1 | G/P |
| SBX-05 | 开启 `x-checkpoint`：跨轮（以及沙箱回收后）`/workspace` 中的文件保留 | 如上 | P1 | G |
| SBX-06 | limited 网络：访问 allowed_hosts 中的主机成功；访问其他主机失败 | 如上 | P0 | G |
| SBX-07 | unrestricted：访问 80/443 端口成功；访问非标准端口（如 :8443）失败 | 如上 | P1 | G |
| SBX-08 | 声明 packages（pip 小包）后在会话中可以 import | 如上 | P1 | G |
| SBX-09 | 上传的文件挂载到 `/mnt/session/uploads/...`，只读（写入失败） | 如上 | P1 | G |

### 5.10 Files / Session Resources（FILE / RES）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| FILE-01 | multipart 上传小文件 | **200**；返回 id、filename、size；不带 MIME 时为 application/octet-stream | P0 | S/G |
| FILE-02 | 非法文件名：`.`、`..`、含 `<>:"\|?*/\`、控制字符、长度超过 255 | 400 | P1 | G |
| FILE-03 | 下载 content，sha256 与上传内容一致 | 如上 | P0 | S |
| FILE-04 | list 使用 before_id/after_id 翻页；两者同时传时返回 400；limit 最大 1000 | 如上 | P1 | G |
| FILE-05 | 删除后 GET 返回 404 | 如上 | P0 | S |
| FILE-06 | 大文件（100 MB）上传与下载（P2，只在夜间运行） | 成功 | P2 | G |
| RES-01 | 创建会话时挂载 file（mount_path） | 沙箱内能读到 | P0 | G/X |
| RES-02 | 运行中 POST resources 追加挂载 | 下一轮能读到 | P1 | G |
| RES-03 | mount_path 含 `..` 越界；两个路径重叠；规范化后长度超过 1024 | 400 | P1 | G |
| RES-04 | POST 更新 resource | 400（不支持） | P2 | G |
| RES-05 | 已归档会话增删资源 | 4xx | P2 | G |
| RES-06 | 列出资源 limit 取 1 和 1000（边界）；DELETE 卸载后下一轮读不到 | 如上 | P2 | G |

### 5.11 Vaults / Credentials（VLT）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| VLT-01 | 创建 Vault（display_name 1–255） | **200** | P1 | S/G |
| VLT-02 | 依次创建 static_bearer、bearer、environment_variable 三种 Credential | 200；**任何响应都不回显** token / secret_value | P0 | G |
| VLT-03 | environment_variable 不带 networking | 400；allowed_hosts 17 项时返回 400 | P1 | G |
| VLT-04 | 轮换：auth.type 相同，只传 token | 成功；身份键（mcp_server_url / host / secret_name）一起传入时返回 400；改变 type 时返回 400 | P1 | G |
| VLT-05 | mcp_oauth：创建（含 refresh）后执行 `mcp_oauth_validate` | 返回 status、mcp_probe、refresh、has_refresh_token 等字段 | P2 | G |
| VLT-06 | **凭据隔离**：会话挂载 environment_variable 凭据，在沙箱中 `echo $EXAMPLE_API_KEY` | 输出为 `omasec_` 开头的代理值，**不等于** secret_value | P0 | G |
| VLT-07 | 用该代理值请求 allowed_hosts 中的测试回显服务 | 服务端收到真实值。需要一个自建的 echo 服务，并加入 allowed_hosts；拿不到这样的服务时降级为 P 级 | P1 | G |
| VLT-08 | static_bearer 与 MCP URL 匹配时自动注入；不匹配时以未认证方式连接 | 如上 | P1 | G |
| VLT-09 | 归档 / 删除 Vault 和 Credential；list 的 include_archived | 如上 | P2 | S |

### 5.12 Memory Stores（MEM）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| MEM-01 | 创建 Store | **201**；name 为 1–255 字符；description 超过 1024 时返回 400 | P1 | S/G |
| MEM-02 | 创建 Memory：合法 path；以下非法 path 返回 400：裸 `/`、空段、`.`、`..`、控制字符、超过 1024 字节 | 如上 | P1 | G |
| MEM-03 | content 超过 100 KiB | 400/413（P） | P2 | G/P |
| MEM-04 | 带 `precondition{type:content_sha256}` 更新：sha 匹配时成功，不匹配时失败（P：记录状态码） | 如上 | P1 | G |
| MEM-05 | 带 `expected_content_sha256` 删除，sha 不匹配时被拒绝 | 如上 | P2 | G |
| MEM-06 | list：path_prefix、depth；`view=full` 时 limit 不超过 20；同时返回 memory 与 memory_prefix 两类元素 | 如上 | P2 | G |
| MEM-07 | memory_versions：每次写入产生一个版本；对**当前 head 版本** redact 返回 **409**；对历史版本 redact 后 path/content/sha 变为 null，并有 `redacted_at` | 如上 | P2 | G |
| MEM-08 | 挂载到会话（read_only）后，agent 尝试写入失败；read_write 时写入后在 API 中能看到新版本 | 如上 | P1 | G/X |

### 5.13 Skills（SKL）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| SKL-01 | multipart 上传合法 Skill（根目录有 SKILL.md） | **201** | P2 | S/G |
| SKL-02 | 同一账号重复的目录名 | 409 `skill_directory_conflict` | P2 | G |
| SKL-03 | 文件数 201 个 | **多出的文件被静默丢弃，不报错**；下载 ZIP 后核对文件数为 200 | P2 | G |
| SKL-04 | 新建版本；下载版本内容（ZIP） | 如上 | P2 | S |
| SKL-05 | 仍被 Agent 引用时删除 Skill | 409 | P2 | G |
| SKL-06 | 会话中 Skill 挂载在 `/workspace/skills/<dir>/` | 如上 | P2 | G/X |
| SKL-07 | `GET /v1/skills?source=zai` 列出内置 Skill，含 latest_version | 如上 | P2 | G |

### 5.14 Deployments（DEP）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| DEP-01 | 创建 manual-only Deployment（无 schedule） | **201**；`schedule=null`；`agent.version` 被固定 | P2 | S/G |
| DEP-02 | cron 间隔小于 5 分钟；表达式没有未来触发点；timezone 不是 Asia/Shanghai | 400 | P2 | G |
| DEP-03 | 带 schedule 创建 | `upcoming_runs_at` 不超过 5 项 | P2 | G |
| DEP-04 | 手动 run | **202**；`trigger_context.type=manual`；`session_id` 在数秒后不再为 null；对应会话结束后 run 的 status 为成功 | P2 | G/X |
| DEP-05 | pause 后手动 run 仍然允许；unpause 后 upcoming 以当前时间为锚重新计算 | 如上 | P2 | G |
| DEP-06 | 归档后再次归档幂等；归档后手动 run 返回 409 | 如上 | P2 | G |
| DEP-07 | deployment_runs 的过滤参数：deployment_id、has_error、trigger_type、created_at；limit 默认 50 | 如上 | P2 | G |
| DEP-08 | 环境归档后，下一次 run 失败（`error` 字段非空） | 如上 | P2 | G |
| DEP-09 | 归档 Agent 时，同时归档其运行中的 Deployment | 如上 | P2 | G/X |

### 5.15 限流（RATE）

| ID | 用例 | 预期 | 优先级 | 来源 |
| --- | --- | --- | --- | --- |
| RATE-01 | 写接口 1 秒内并发 40 次（超过 burst 20） | 出现 429，响应带 `ratelimit-limit`、`ratelimit-remaining`、`ratelimit-reset`、`retry-after` | P1 | G |
| RATE-02 | 等待 retry-after 后恢复 | 如上 | P1 | G |
| RATE-03 | POST events 使用独立的高频桶（约 100），并发 60 次不触发 429 | P：记录 | P2 | G/P |
| RATE-04 | 读接口 burst 100 | 记录 | P2 | G |

> 限流用例单独运行（`--project rate`），使用专用测试账号，避免影响其他用例。

### 5.16 探测与兼容性（PRB），只记录不判定

| ID | 探测内容 |
| --- | --- |
| PRB-01 | 发送 `user.define_outcome` / `system.message` / `user.tool_result` 的结果（拒绝或接受，以及状态码） |
| PRB-02 | 是否会出现 `session.status_terminated`（构造方法：环境被删除后再发消息） |
| PRB-03 | `Idempotency-Key` header 是否生效（同一 key 发两次，观察是否产生两个资源） |
| PRB-04 | 单账号并发会话上限（逐个创建并运行，直到被拒） |
| PRB-05 | 会话 idle 多久后沙箱被回收（每 10 分钟探测一次进程是否仍在，例如后台 `sleep` 进程） |
| PRB-06 | 单轮最长运行时间与超时行为 |
| PRB-07 | 使用 Anthropic 方言（`anthropic-version`/`anthropic-beta`、`x-api-key`）请求时的行为 |
| PRB-08 | SSE 是否支持 `Last-Event-ID` |
| PRB-09 | 错误响应中 `error.details` 的结构 |
| PRB-10 | 成功码与文档的一致性汇总（201/200/202 的完整核对表） |

---

### 5.17 凭据出站一致性矩阵（SEC），只对 T-B 运行

对应 spec §10.4，借鉴 OpenMA ADR 0007 的 10 项矩阵。前置条件：
- 一个**由测试控制的回显服务**（`ACC_ECHO_HOST`，记录收到的请求头），配置两个 host：`echo-a`、`echo-b`。
- 两个租户 W1/W2，各一个 Vault，各自为 `echo-a` 配置不同的 bearer。

| ID | 用例 | 预期 | 优先级 |
| --- | --- | --- | --- |
| SEC-01 | W1 会话（绑定 W1 的 vault）请求 `echo-a` | 回显服务收到 W1 的 bearer；沙箱内 `env` 和文件中都找不到明文 | P0 |
| SEC-02 | W2 会话请求同一个 host `echo-a`；W1 中未绑定该 vault 的会话请求 `echo-a` | 前者收到 W2 的 bearer；后者**不注入任何凭据**；任何情况下都不会拿到 W1 的凭据 | P0 |
| SEC-03 | 请求未授权的任意 host（limited 网络）；请求没有对应凭据的 host（unrestricted 网络） | 前者返回 403 并产生 `egress_denied`；后者匿名放行，不注入凭据 | P0 |
| SEC-04 | 沙箱内 `unset HTTP_PROXY HTTPS_PROXY` 后直连 `echo-a` 的 IP 或域名，以及 `curl --noproxy '*'` | 连接失败（internal 网络没有路由） | P0 |
| SEC-05 | 旧 generation：强制让 worker 失去租约（暂停 worker 进程，超过 30 秒后由新 worker 接管），旧沙箱在被杀之前用旧 token 请求 `echo-a` | 代理拒绝（401/403），回显服务**没有收到**凭据 | P0 |
| SEC-06 | 停止 egress-proxy 或 PG（凭据查询失败）时请求 `echo-a` | 请求失败，**不会**无凭据放行，也不会直连 | P0 |
| SEC-07 | 轮换凭据后，同一会话继续请求 | 下一次请求就使用新值，无需重启会话 | P1 |
| SEC-08 | 扫描 `egress_bindings`、checkpoint 归档、output、日志、`runtime_instances`、进程参数 | 不出现凭据明文和出站 token 值 | P0 |
| SEC-09 | IPv6 地址、DNS 直连外部解析器、UDP/QUIC（443/udp）、非标准端口、HTTP 3xx 跨域重定向、`CONNECT` 到非白名单 host | 全部被拒绝，或者明确不注入凭据（重定向到其他域时不携带凭据） | P1 |
| SEC-10 | 会话被归档或删除后，用残留的出站 token 请求 | 拒绝 | P1 |

另外：沙箱自带 `Authorization: Bearer fake` 请求 `echo-a` 时，回显服务只收到 vault 注入的值，fake 被**剥离**，不会同时出现两个值（归入 SEC-01）。

### 5.18 事件排序（ORD）

对应 spec §7.3，借鉴 OpenMA `ORDERING_DESIGN.md`。对 T-B 判定通过或失败；**对 T-A 只做 P 级探测**，记录 BigModel 的行为作为参考。

| ID | 用例 | 预期（T-B） | 优先级 |
| --- | --- | --- | --- |
| ORD-01 | **运行中插话**：第 1 轮让 agent 输出较长内容（`sleep 5` 后回答）。在 `agent.message` 之前发送第 2 条 user.message | POST 立即返回事件 ID，此时 `processed_at=null`；`GET events` 默认**不包含**它；轮次结束后它以**大于第 1 轮所有事件的 seq** 出现，后面才是第 2 轮输出；`include_pending=true` 时可以在末尾看到它 | P0 |
| ORD-02 | ORD-01 场景下检查 SSE | 先收到 `input_queued` 帧（没有 id），提升后收到带 seq 的正式 user.message 帧，位置在第 1 轮 idle 之后 | P1 |
| ORD-03 | 运行中连续排队 2 条消息后发送 interrupt | 被取消的排队消息**不进入**历史；在 `include_pending=true` 中状态为 cancelled；当前轮以 `idle(end_turn)` 结束 | P0 |
| ORD-04 | 语义恢复后核对上下文：ORD-01 结束后强制走 Level 0（删除沙箱和 checkpoint），再提问"我第二条消息说了什么" | agent 能正确回答；恢复上下文中消息顺序与 seq 顺序一致 | P2 |
| ORD-05 | 全量历史的 seq 严格递增、没有空洞；同一 lane 内每个 user 输入之后、下一个 user 输入之前，恰好有一个 `session.status_idle` | 如上 | P1 |

### 5.19 恢复与幂等（REC），只对 T-B 运行，需要故障注入钩子

需要测试专用的管理接口 `POST /internal/test/faults`（只在 `MAS_TEST_FAULTS=1` 时启用），可以在指定时点 kill codex、worker 或沙箱，或者暂停续约。

| ID | 用例 | 预期 | 优先级 |
| --- | --- | --- | --- |
| REC-01 | turn 中 kill -9 worker | 30 秒内由新 worker 接管（generation+1）；旧 generation 的事件写入被拒绝；该 turn 以 `session.error{retry_status:"terminal"}` + idle 结束，不重放用户消息；下一条消息正常执行 | P0 |
| REC-02 | turn 中发送 interrupt 后**立即** kill worker | 新 worker 遵守持久化的中断，不再启动该 turn；最终状态为 `idle(end_turn)` | P0 |
| REC-03 | **水位线不一致**：在"`status_idle` 已发布、checkpoint 尚未发布"的时点 kill worker 并删除沙箱 | 恢复时**不执行** `thread/resume`；内部事件为 `runtime.recovered{mode:"semantic", reason:"watermark_mismatch"}`；agent 仍然记得最后一轮的内容 | P0 |
| REC-04 | 水位线一致：轮次结束、checkpoint 发布后删除沙箱，再发送消息 | 走 Level 1（`mode:"native"`）；`/workspace` 中的文件保留 | P0 |
| REC-05 | 损坏 active checkpoint 的归档（改写字节） | 回退到上一个有效 checkpoint，并写 `session.error{type:"checkpoint_corrupt"}` | P1 |
| REC-06 | 毒任务：注入"每次 claim 后都崩溃" | 达到 `max_attempts` 后 execution 置为 failed；会话进入 `idle(retries_exhausted)`，不会无限回收 | P1 |
| REC-07 | 同一 `Idempotency-Key` 和相同 body 重复 POST events；同一 key 但 body 不同 | 前者返回首次结果，只执行一次；后者返回 409 `idempotency_conflict` | P0 |
| REC-08 | output 重复收集：轮次结束时注入"上传完成、CAS 之前崩溃" | 恢复后同一个 `(path, sha256)` 只登记一个 File | P1 |
| REC-09 | 能力不满足：把 Environment 的内部配置改为要求 gvisor，但 provider 实际是 runc | 会话 fail closed：`terminated` + `capability_unsatisfied`，**不会**降级运行 | P1 |
| REC-10 | 原 Codex digest 被下线后恢复会话 | 走 Level 0 并写 `runtime_upgraded`；会话可以继续 | P2 |

### 5.20 确定性混沌车道（CHAOS），只对 T-B 运行，不走 HTTP 验收框架

借鉴 OpenMA 的 `test:chaos:runtime`。这一车道直接驱动 worker、execution store、checkpoint、output、egress 的**真实实现**加 PG（Testcontainers）；Codex 和沙箱使用脚本化的假实现。

- **模型**：多个 owner（2–3 个模拟 worker）并发执行 claim、renew、提升、写事件、checkpoint（候选/manifest/CAS）、output 发布、revoke、settle 等动作。时钟为虚拟时钟，租约过期、网络延迟、强杀失败都由种子驱动。
- **不变量**（每步检查）：
  1. 任一时刻至多一个 generation 能成功提交 canonical 写入。
  2. 旧 generation 不能追加事件、推进 checkpoint 指针、发布 output 或获得出站授权。
  3. active checkpoint 一定指向一个完整、已校验的候选。
  4. seq 严格递增且没有空洞。
  5. 重试 acquire、checkpoint、collect、finalize、release 是幂等的。
  6. 释放计算资源不会删除 canonical 的 checkpoint 和 output。
- **种子**：固定种子集合（≥ 200 个）随用例提交，失败可以精确复现；nightly 额外运行 1000 个随机种子，失败的种子自动加入固定集合。
- **门禁**：spec §17.2 要求固定种子集合全绿。

## 6. 事件序列断言规范（E 类用例）

使用"**有序子序列 + 不变量**"的方式断言，不要求逐帧完全相等：

```ts
expectSubsequence(events.map(e => e.type), [
  "user.message", "session.status_running",
  /* 0..n 个 agent.thinking / span.* / agent.tool_use / agent.tool_result */
  "agent.message", "session.status_idle",
]);
```

不变量：

1. 每轮恰好一个终止事件 `session.status_idle`，其 `stop_reason` 属于 {end_turn, requires_action, retries_exhausted}。
2. 每个 `agent.tool_use` 要么有对应的 `agent.tool_result`（通过 `tool_use_id` 关联），要么被 requires_action 的 `event_ids` 引用。
3. 每个 `span.model_request_start` 都有配对的 `span.model_request_end`。
4. 事件 id 唯一；SSE 中收到的持久化事件全部能在历史中找到（集合包含关系）。
5. 中断场景下不出现 `session.error`。

---

## 7. 执行计划

| 阶段 | 时间 | 内容 | 产出 |
| --- | --- | --- | --- |
| T0 框架 | 第 1 周 | 方言层、HTTP/SSE 客户端、从 OpenAPI 生成 Zod、手写事件 schema、清理器、报告 | 框架 + 20 个冒烟用例 |
| T1 P0 | 第 2 周 | AUTH / AGT / ENV / SES / EVT / TOOL 的 P0 用例（约 55 个） | 首轮基线报告与文档问题清单 |
| T2 P1 | 第 3 周 | 其余 P1 用例（约 80 个）：FILE / RES / VLT / MEM / SBX / RATE | |
| T3 P2 + 探测 | 第 4 周 | SKL / DEP / P2 用例 / PRB 全部 | 完整报告；**文档缺口反馈单**（提交给智谱） |
| T4 双目标 | 与 `plan.md` M2 起同步 | 对 T-B 运行，并维护方言差异白名单 | CI 每日对 T-B 运行，每周对 T-A 运行 |
| T5 T-C 官方 SDK 车道 | 与 `plan.md` M2 起同步 | 约 45 个 P0 用例的 SDK 改写版 | CI 每日对 T-C 运行 |
| T6 ORD / REC / SEC / CHAOS | 与 `plan.md` M3（ORD、REC、CHAOS）和 M4（SEC）同步 | 故障注入钩子、回显服务、混沌 harness | 合入对应里程碑的出口标准 |

用例规模估算：约 **190 个**基础用例（P0 约 55 个、P1 约 85 个、P2 约 40 个、PRB 10 个；需要模型推理的约 60 个），v0.2 新增 SEC 10 个、ORD 5 个、REC 10 个、T-C 约 45 个，合计约 **260 个**；另加混沌车道（≥ 200 个种子，不消耗模型 token）。

单轮全量执行的成本估算：推理用例约 60 个 × 平均 2 轮 × 约 5k token ≈ 0.6M token（使用 glm-5.3-flash）。沙箱目前限时免费。

---

## 8. 运行配置

```text
tests/acceptance/
├─ vitest.config.ts            # projects: core / stream / sandbox / rate / probe
├─ dialects/{bigmodel,mas,anthropic-sdk}.ts
├─ lib/{http,sse,wait,cleanup,schema}.ts
├─ schemas/{openapi.gen.ts, events.ts}
├─ fixtures/{agents,environments,files}/...
├─ specs/{auth,agents,environments,sessions,events-send,events-list,events-stream,tools,sandbox,files,resources,vaults,memory,skills,deployments,rate,probe}.spec.ts
├─ specs/self-only/{sec,ord,rec}.spec.ts      # 只对 T-B 运行
├─ specs/sdk/*.spec.ts                       # T-C：官方 Anthropic SDK 黑盒
└─ ../chaos/                                  # 确定性混沌车道（独立 vitest project）
```

环境变量：

| 变量 | 说明 |
| --- | --- |
| `ACC_TARGET` | `bigmodel`、`mas` 或 `mas-anthropic-sdk` |
| `ZHIPUAI_API_KEY` | 主账号 key |
| `ZHIPUAI_API_KEY_B` | 第二个账号的 key，用于 AUTH-07 跨账号隔离 |
| `ACC_ECHO_HOST` | VLT-07 / SBX-06 使用的外部回显服务 |
| `ACC_MCP_URL` | 测试 MCP server 地址 |
| `ACC_BUDGET_TOKENS` | 本轮 token 预算，超出后停止运行推理用例 |
| `ACC_FAULTS_TOKEN` | 故障注入管理接口的 token，只对 T-B 使用（REC） |
| `ACC_TENANT_B_KEY` | T-B 第二个租户的 key（SEC-02 跨租户） |

---

## 9. 通过标准

| 对象 | 标准 |
| --- | --- |
| T-A（BigModel） | 用于**评估平台与文档质量**，不设通过门槛。输出：S/G 级用例通过率；"文档与实现不一致"清单；PRB 基线 |
| T-B（自建平台） | P0 100%；P1 ≥95%（白名单中已声明的方言差异除外）；G 级用例的行为必须与 T-A 的实测基线一致，否则需要在方言差异中说明；SEC P0 和 REC P0 100%；混沌固定种子全绿 |
| T-C（官方 SDK） | P0 100%（白名单中已声明的 Anthropic 方言差异除外） |

---

## 10. 风险

| 风险 | 应对 |
| --- | --- |
| Beta 接口行为变化 | 每周对 T-A 运行一次，PRB 基线出现漂移时告警；用例与 `zai-version` 绑定 |
| 模型输出不确定导致工具类用例不稳定 | 使用确定性提示加 nonce；单次失败自动重试 1 次；连续 3 天波动时标记 flaky 并隔离 |
| 限流相互干扰 | 客户端节流；限流用例使用专用账号并单独运行 |
| 资源残留与配额耗尽 | 按 run_id 打标签；afterAll 清理；夜间清扫 |
| 测试中泄露凭据 | 报告中的 trace 自动脱敏（Authorization、secret_value、token） |
| 故障注入钩子被误开到生产 | 只在 `MAS_TEST_FAULTS=1` 时注册路由，生产镜像构建时剔除；接口要求专用 token |
| 混沌车道与实现耦合过紧 | 只断言不变量和外部可见轨迹，不断言内部调用顺序 |
