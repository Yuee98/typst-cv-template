# AI 润色多 Provider 共享契约

> 契约版本：`ai_provider_contract_v1`
>
> 冻结日期：2026-08-23
>
> 最近修订：2026-08-24（recurring price lanes、V2 reserve、legal-bundle seal 与历史 CNY cost-only binding）
>
> 状态：初版实现契约；字段删除、改名或语义重解释必须重新经过设计 gate
>
> 适用范围：DeepSeek Chat 兼容路径、MiMo Responses 初版，以及后续 Responses provider

本文冻结数据库、server runtime、HTTP API、UI 与法律披露之间的共享边界。它不保存 provider 的任意 URL、header、secret 名称或法律正文；这些值只能由代码中的受审 registry 解析。

## 1. 命名、版本与兼容规则

- PostgreSQL 列、RPC JSON 参数使用 `snake_case`；RPC 返回、TypeScript 和 HTTP JSON 使用 `camelCase`。
- UUID 在所有 JSON/TypeScript 边界上使用字符串。
- PostgreSQL `bigint` 中可能持续增长或参与金额计算的 generation、aggregate token 和 nanos 跨 JSON 时使用十进制字符串，避免 JavaScript 精度损失。单次 attempt 的 provider token usage 使用 JSON number/TypeScript `number`，但进入 DB 前必须是 `Number.isSafeInteger` 的非负值；任何 aggregate readback 再使用十进制字符串。
- 现有 RPC 只 additive 扩展。旧参数、旧返回字段和旧 DeepSeek Chat 路径在至少一个稳定发布周期内保留。
- 共享对象均包含显式 `schemaVersion`。未知版本 fail closed，不能按“OpenAI compatible”猜测。
- DB 中激活后的 profile、price、routing policy 和 legal bundle 不可原地修改；变更创建新 version。

## 2. 冻结的 route snapshot

一次 reservation 原子选择并冻结一份 `PolishRouteSnapshotV1`：

```ts
interface PolishRouteSnapshotV1 {
  schemaVersion: "route_snapshot_v1";
  configGeneration: string;
  routingPolicyVersionId: string;
  profileVersionId: string;
  priceVersionId: string;
  legalBundleVersion: string;
  gatewayKind: "direct_deepseek" | "direct_mimo" | "openrouter";
  modelId: string;
  wireApiKind: "chat_completions_v1" | "responses_v1";
  displayDisclosureKey: string;
}
```

不变量：

- snapshot 的所有 ID 必须来自同一事务内验证通过的组合。
- retry/attempt 继承 reservation snapshot，不能重新读取 active routing、profile、price 或 legal bundle。
- active policy 热切换只影响之后的 reservation。
- `start_ai_polish_provider_attempt` 仍重读 kill switch、用户 allowlist、global capacity 和已冻结 profile 的 availability；若任一不可用，拒绝 transmission，但绝不改路到另一 provider。
- adapter、credential、endpoint、capability、cache policy、calculator 和 legal manifest 都只能解析代码 registry 中的固定 alias；未知 alias fail closed。

### 2.1 `routing_rules_v1`

每个 target 必须同时显式引用 immutable profile 与 price，DB 不按 latest、model、lane 名或 calculator 猜价格：

```json
{
  "schemaVersion": "routing_rules_v1",
  "defaultRoute": {
    "profileVersionId": "uuid",
    "priceVersionId": "uuid"
  },
  "windows": [
    {
      "weekdays": [1, 2, 3, 4, 5],
      "startMinute": 540,
      "endMinute": 720,
      "route": {
        "profileVersionId": "uuid",
        "priceVersionId": "uuid"
      }
    }
  ]
}
```

DB 与 TypeScript 使用共享 fixtures 严格验证：顶层、route 与 window 拒绝未知/缺失 key；恰有一个 `defaultRoute`；`windows` 最多 32 项；`weekdays` 非空、唯一且仅含 ISO 周一=1 至周日=7；minute 为整数且 `0 <= start < end <= 1440`；窗口采用 policy `Asia/Shanghai` 的半开区间，v1 拒绝跨午夜与任意重叠。UUID 必须 canonical。selector 是接收显式时间的纯函数。

`default_profile_version_id` 必须等于 `defaultRoute.profileVersionId`。每个 price 必须通过 composite relation 归属对应 profile；缺失、malformed、retired、expired、wrong-profile、unsealed 或 legal-unbound target 均 fail closed。保留 lane `legacy` 只作历史回填，任何当前 routing policy 都不得引用。

## 3. Canonical inference V2

### 3.1 Request

```ts
interface PolishInferenceRequestV2 {
  schemaVersion: "polish_inference_request_v2";
  prompt: {
    blocks: Array<{
      id: string;
      role: "developer" | "user";
      stability: "stable" | "variable";
      content: string;
    }>;
    explicitCacheBoundaryAfter?: string;
  };
  outputContract: {
    kind: "json_schema" | "json_object";
    schemaName: string;
    schema: unknown;
  };
  maxOutputTokens: number;
  providerSubjectId: string;
  promptVersion: string;
  validatorVersion: string;
  language: "zh" | "en";
  targets: ReadonlyArray<{ id: string; text: string }>;
}
```

- `targets` 只供本地 fake/验证，不能作为独立字段发送上游。
- `providerSubjectId` 是服务端 HMAC 伪名；adapter 只有在目标 provider 文档明确支持相应字段时才发送。MiMo 初版不发送该值。
- provider 不支持 `developer` role 时，adapter 按 capability contract 映射到受支持的系统指令字段；不能把 variable CV 内容移到 stable cache boundary 之前。
- provider 未明确支持 JSON schema/JSON object 参数时，仍由 prompt + 本地 validator 保证输出，adapter 不发送未证实字段。

### 3.2 Usage

```ts
type CacheUsageReporting = "reported" | "unavailable" | "not_applicable";

interface NormalizedUsageV2 {
  schemaVersion: "normalized_usage_v2";
  inputTotalTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number | null;
  inputStandardTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheUsageReporting: CacheUsageReporting;
  usageComplete: boolean;
}
```

规范化必须满足：

1. 所有已知 token 字段都是非负安全整数。
2. `inputCacheWriteTokens !== null` 时：

   ```text
   inputTotalTokens = inputCacheReadTokens + inputCacheWriteTokens + inputStandardTokens
   ```

3. `inputCacheWriteTokens === null` 且 `cacheUsageReporting === "unavailable"` 时：

   ```text
   inputTotalTokens = inputCacheReadTokens + inputStandardTokens
   ```

   这里的 `inputStandardTokens` 是 provider 的 cache-miss/剩余计价桶，不代表内部没有发生 cache write。
4. `cacheUsageReporting === "not_applicable"` 只用于该 profile 明确关闭或不支持缓存的情况；read/write 均为已知的 `0`。
5. 缺失 cache-write 报告必须是 `null + unavailable`，不能写成 `0`。
6. `reasoningTokens` 是 `outputTokens` 的明细，已知时必须 `<= outputTokens`，成本不能重复相加；provider 未报告该明细时可为 `null`，只要 output 总量完整，不因此单独把 `usageComplete` 降为 false。
7. 缺失 input/output 权威总量、负数、非整数或违反守恒时，adapter 不能返回“完整零 usage”。没有可靠 usage 的 transmission 以 `usage=null`、`usageComplete=false` 完成 attempt。
8. request aggregate 必须等于其所有 completed attempts 的逐桶和；`null` 明细保持 unknown，不能通过求和变成零。

`PolishInferenceResultV2` 只表示 adapter 已得到可解析 response 且能构造 `NormalizedUsageV2` 的情况，因此其 `usage` 非空。adapter 抛错、取消或无法构造 usage 时，由 orchestrator 形成独立的 attempt observation；禁止用一个带伪造零 usage 的 result 表示：

```ts
type AttemptUsageObservationV1 =
  | { kind: "observed"; usage: NormalizedUsageV2 }
  | { kind: "unavailable"; usage: null; usageComplete: false };
```

`usageComplete` 的唯一来源是上面的 discriminant：`unavailable` 永远为 false；`observed` 读取 `usage.usageComplete`。RPC wrapper 不得再从 failure stage 或最后一次 attempt 推导该值。

DeepSeek/MiMo 自动缓存映射：

- DeepSeek：hit → cache read；miss → standard；write → `null`；reporting → `unavailable`。
- MiMo：cached tokens → cache read；`input - cached` → standard；write → `null`；reporting → `unavailable`。
- GPT/OpenRouter 后续只有在权威 usage 明确给出 write 时才进入四桶完整守恒。

### 3.3 Result 与安全错误

```ts
interface PolishInferenceResultV2 {
  schemaVersion: "polish_inference_result_v2";
  text: string;
  finishReason:
    | "stop"
    | "length"
    | "content_filter"
    | "insufficient_system_resource"
    | "unknown";
  usage: NormalizedUsageV2;
  route: {
    gatewayRequestId?: string;
    providerRequestId?: string;
    actualUpstreamEndpoint?: string;
    actualModelId?: string;
    routerAttemptCount?: number;
  };
  providerReportedCost?: { currency: string; nanos: string };
}
```

Provider error 仅携带 normalized code、retryable、HTTP status、bounded Retry-After 和 request ID。不得读取或记录原始 provider error body，也不得把 prompt、CV、模型输出或 secret 放入 error/message/cause/log。

Provider 返回的 correlation ID 属于不受信输入。落 DB 前，`gatewayRequestId/providerRequestId` 必须统一转换为 `hmac-sha256:<64 lowercase hex>` 的 server-keyed opaque tag；复用现有 `AI_USER_ID_HMAC_SECRET`，但输入必须采用 `route-observation-v1` + field kind 的显式 domain separation，不能与 provider subject HMAC 共用裸输入。raw ID、API-key/JWT/prose-shaped value 均不得持久化或写日志。`actualModelId` 只有与 frozen profile `modelId` 完全相等时才可保存；否则省略。`actualUpstreamEndpoint` 只有与 code registry 解析的 frozen `endpointAlias` canonical URL 完全相等、且 DB rejection mirror 也认可该 alias/URL pair 时才可保存；否则省略。DB schema/trigger 对上述 canonical shape 再次 fail closed，不能依赖调用者自律。

## 4. 成本契约

```ts
interface MoneyNanosV1 {
  currency: string;
  nanos: string;
}

type CostReconciliationStatus =
  | "not_available"
  | "pending"
  | "matched"
  | "mismatch"
  | "incomplete_usage";
```

- 本地 estimated cost 只能使用 reservation 冻结的 `priceVersionId` 和代码 registry 中对应 calculator；calculator 不读取时钟或 lane 名。
- 原生币种逐 attempt 保存。CNY 与 USD 不允许在 DB/runtime 指标中直接求和；换汇只能是单独、带汇率版本的报表层。
- `providerReportedCost` 与 `estimatedCost` 分列；provider 没有报告时是 `null/not_available`。
- 任一必需 usage 桶未知、price component 缺失或 calculator 不认识时，estimated cost 为 `null/incomplete_usage`，不能给出低估值。
- 金额以 `1 currency unit = 1_000_000_000 nanos` 存储，跨 JSON 使用十进制字符串。
- DeepSeek 历史迁移只使用用户确认的旧 CNY 版本：hit ¥0.02/M、miss ¥1/M、output ¥2/M；不补造历史 attempt。

### 4.1 Immutable price lane

`ai_price_versions.pricing_lane` 是 `NOT NULL` 的 code-style key（`^[a-z0-9][a-z0-9._-]*$`），加入 immutable identity：

```sql
unique (profile_version_id, pricing_lane, version)

exclude using gist (
  profile_version_id with =,
  pricing_lane with =,
  tstzrange(valid_from, valid_to, '[)') with &&
)
```

同一 profile 可同时存在不同 lane 的 rate set；同一 lane 不允许有效期重叠。迁移只能以临时 `DEFAULT 'default'` 回填既有行，在同一事务内验证并设为 `NOT NULL`、替换约束后立即 drop default；之后每个 seed 都必须显式写 lane。lane 不选择费率或 calculator；唯一负向例外是 reserved `legacy` lane 永远不可路由，只能由历史回填 primitive 使用。

当前 DeepSeek 使用 `offpeak` 与 `peak` 两条 version-1 lane；其他没有 recurring band 的 provider 显式使用 `default`。`PolishRouteSnapshotV1` 不重复保存 lane，exact `priceVersionId` 已唯一确定 immutable rate set。

初始 policy 只引用 seed-owned exact UUID pair：G2 default 是 `(DeepSeek profile, offpeak price)`，两个 peak windows 是 `(同一 DeepSeek profile, peak price)`；G4 default 保持 `(DeepSeek profile, offpeak price)`，两个 peak windows 改为 `(MiMo profile, default price)`。不得按 lane/latest 查询或替换 target，同一 request 不做跨 provider fallback。

### 4.2 Operational eligibility 与 provider provenance

`valid_from/valid_to` 只是本系统允许自动选择该价格的 operational interval，不声称是 provider 官方生效时间。immutable nullable `provider_effective_from/provider_effective_to` 保存上游 provenance；未知边界保持 `NULL`，两者都非空时必须满足 `provider_effective_to > provider_effective_from`。

上游未公布生效时间时，`valid_from` 使用 canonical `source_checked_at` 或更晚的本地激活边界，不能把更早历史绑定到当前价。激活前在 immutable row 外重新抓取证据，并把 `rechecked_at/rechecked_sha256` 写入 activation audit；相同 canonical facts 可继续激活，rate/currency/component/parameter/provider-effective fact 任一变化都必须创建新 price version 与新 policy target，不能原地刷新 source 字段。

DB 冻结 calculator parameter 与 required/allowed component 的结构契约，初版仅 `linear_token_v1`；未知结构在 validation/activation/reserve fail closed。TypeScript registry 仍拥有实际计算算法，共享 fixture 必须证明 DB 结构契约与 TS 算法输入一致。

### 4.3 Price component seal

只有 audited activation 与 legacy-seal primitive 能发起 `components_sealed_at` 的单向转换。它们按 UUID 顺序以 `FOR UPDATE` 锁定全部目标 price，校验 calculator parameters 与完整 component set，seal 后重新验证 policy。request-snapshot trigger 只能断言 price 已 seal；不得把首次 request 当成 seal 来源。

component authoring 必须先以 `FOR UPDATE` 锁其 draft price。它与 activation/legacy seal 串行：component 先提交则 seal 会审阅它，seal 先提交则后续 insert/update/delete 均拒绝。普通 reserve 只以 `FOR SHARE` 读取 sealed price，因此共享一个 price 的请求不会互相串行，同时仍与 `valid_to` closure、seal 和 component authoring 冲突。

### 4.4 Historical DeepSeek cost-only binding

历史行不伪造 routing policy、legal bundle、provider attempt 或当前 route facts。DB-012 只对用户确认的旧价 cohort 写以下 exact discriminated shape：

```text
route_schema_version = 'legacy_pricing_v1'
profile_version_id = exact CFG-001 DeepSeek profile version
price_version_id = sealed legacy price version
config_generation/routing_policy_version_id/legal_bundle_version = NULL
gateway_kind/model_id/wire_api_kind/display_disclosure_key = NULL
usage_schema_version = 'legacy_v1'
cost_basis = 'legacy_request_aggregate'
```

request-ledger constraint 只允许这个完整组合，reserve V1/V2 均不能创建，也绝不作为 `PolishRouteSnapshotV1` 返回。composite price/profile FK 继续生效；一旦写入，profile/price binding immutable。request trigger 必须先断言 legacy price 已 seal。usage 不完整的历史行保持 cost `NULL`，不制造 token 或 attempt。

## 5. DB RPC JSON contract

### 5.1 Reserve V1 compatibility

现有三参数函数、响应字节与 DeepSeek V1 lifecycle 在 compatibility window 内保持不变：

```sql
reserve_ai_polish_request(p_user_id uuid, p_request_id uuid, p_client_request_id uuid) returns jsonb
```

它不接收或伪造 expected route，不创建 `route_snapshot_v1`；V2 handler cutover 后不得调用它。

### 5.2 Reserve V2

为避免 PostgREST overload 歧义，V2 使用独立函数名：

```sql
reserve_ai_polish_request_v2(
  p_user_id uuid,
  p_request_id uuid,
  p_client_request_id uuid,
  p_expected_route jsonb
) returns jsonb
```

HTTP camelCase `expectedRoute` 由 server 转成只允许 exact keys 的 equality assertion；它只能断言，不能选路：

```json
{
  "schema_version": "expected_route_v1",
  "config_generation": "7",
  "profile_version_id": "uuid",
  "legal_bundle_version": "<legal-bundle-version>"
}
```

RPC 使用一个 configuration linearization sequence：

```text
ai_feature_config FOR SHARE
-> exact routing policy FOR SHARE
-> v_route_at := clock_timestamp() exactly once
-> strict default/window target
-> selected profile FOR SHARE
-> selected sealed price FOR SHARE
-> sealed exact legal membership
-> compare expected generation/profile/legal
-> quota/rate rows
-> request ledger insert with reserved_at = v_route_at
```

selector、price eligibility、UTC quota day、minute rate bucket、`resetAt` 与 retry-window calculation 都从同一个 `v_route_at` 派生；之后不得用另一处 `now()` 改变 routing/accounting identity。expectedRoute 缺失、malformed 或不等时，在任何 quota、rate、provider-admission mutation 和 request-ledger insert 之前返回 `AI_ROUTE_CHANGED`。Reserve 不修改 selected price；`FOR SHARE` 允许并发 reservation，但与 price closure/seal/component parent `FOR UPDATE` 冲突。

成功返回保留现有可共享字段并新增完整 snapshot：

```json
{
  "allowed": true,
  "reservationId": "uuid",
  "limit": 20,
  "remaining": 19,
  "resetAt": "2026-08-24T00:00:00Z",
  "routeSnapshot": {
    "schemaVersion": "route_snapshot_v1",
    "configGeneration": "7",
    "routingPolicyVersionId": "uuid",
    "profileVersionId": "uuid",
    "priceVersionId": "uuid",
    "legalBundleVersion": "<legal-bundle-version>",
    "gatewayKind": "direct_deepseek",
    "modelId": "deepseek-v4-flash",
    "wireApiKind": "chat_completions_v1",
    "displayDisclosureKey": "deepseek-official-v1"
  }
}
```

所有现有 denial code 保持。新增配置失败统一返回 `allowed:false`、`reason:"SERVICE_UNAVAILABLE"`，server 记录不含内容的内部原因；未知 alias/profile/price/legal 组合不得降级到默认 provider。V1/V2 可复用 private quota helper，但 public name、参数与语义保持分离。

### 5.3 Start attempt（新增 RPC）

```sql
start_ai_polish_provider_attempt(
  p_reservation_id uuid,
  p_attempt_no integer
) returns jsonb
```

```json
{
  "ok": true,
  "attemptId": "uuid",
  "attemptNo": 1,
  "alreadyStarted": false,
  "status": "started",
  "routeSnapshot": { "schemaVersion": "route_snapshot_v1" }
}
```

示例省略的 snapshot 字段必须与 reserve 完全相同。`p_attempt_no` 是 orchestrator 的 caller-stable identity，只允许 `1..2`；DB 不自行猜测“下一次”。函数在同一事务中锁 reservation、执行全局 admission gate、验证 kill switch/allowlist/frozen profile availability、创建唯一 `(reservation_id, attempt_no)` 行。

- 首次成功插入 attempt 并递增 global admitted-attempt counter，返回 `alreadyStarted:false`。
- 相同 reservation/attempt number 因 RPC response 丢失而重放时，返回同一 `attemptId`、`alreadyStarted:true`，不新增行、不重复计数。
- 相同 identity 的并发 start 不能创建两行或重复消耗 admission slot；DB start 本身不证明只有一次 transmission，runtime 的单-owner request lifecycle 仍必须保证只有持有该 reservation 的 orchestrator 进入 adapter。
- 该 counter 是保守的 **admitted attempt counter**，不是 provider 已收到请求的证明。start 成功后仍可能因 abort/deadline 在 transmission 前结束。
- 失败时不创建 attempt、不调用 provider，返回现有 `AI_DISABLED`、`SERVICE_UNAVAILABLE`、`ALREADY_FINALIZED` 或内部 `NOT_FOUND` reason。

### 5.4 Complete attempt（新增 RPC）

```sql
complete_ai_polish_provider_attempt(
  p_attempt_id uuid,
  p_status text,
  p_provider_billable boolean,
  p_usage jsonb,
  p_route jsonb,
  p_cost jsonb,
  p_metadata jsonb
) returns jsonb
```

`p_status` 允许 `succeeded | invalid_output | failed_upstream | timed_out | canceled`；`unknown` 仅 reconciler 使用。JSON 参数：

```json
{
  "p_usage": {
    "schema_version": "normalized_usage_v2",
    "input_total_tokens": 100,
    "input_cache_read_tokens": 60,
    "input_cache_write_tokens": null,
    "input_standard_tokens": 40,
    "output_tokens": 20,
    "reasoning_tokens": 0,
    "cache_usage_reporting": "unavailable",
    "usage_complete": true
  },
  "p_route": {
    "schema_version": "route_observation_v1",
    "gateway_request_id": null,
    "provider_request_id": "safe-correlation-id",
    "actual_upstream_endpoint": null,
    "actual_model_id": "deepseek-v4-flash",
    "router_attempt_count": null
  },
  "p_cost": {
    "schema_version": "cost_observation_v1",
    "estimated_currency": "CNY",
    "estimated_cost_nanos": "1234",
    "provider_reported_currency": null,
    "provider_reported_cost_nanos": null,
    "reconciliation_status": "not_available"
  },
  "p_metadata": {
    "schema_version": "attempt_metadata_v1",
    "finish_reason": "stop",
    "failure_stage": null,
    "latency_ms": 1234
  }
}
```

- `p_usage` 可为 `null`，此时 attempt 必须保存 `usage_complete=false`，成本为 `null/incomplete_usage`。
- `p_provider_billable` 可为 `null` 表示无法确认；不能把未知改成 false。
- complete 幂等；重复相同完成返回 `alreadyCompleted:true`。比较前将所有 optional keys canonicalize 为显式 `null`、验证各自 `schema_version`，并按字段值比较而非 raw JSON/key order；冲突返回 `ATTEMPT_COMPLETION_CONFLICT`，不能覆盖首次事实。
- `p_route` 和 metadata 只允许安全字段；request IDs 只能是 canonical HMAC tags，actual model/endpoint 必须匹配 parent frozen profile 的 code-owned identity。schema 不提供任何 raw body/prompt/output/content 列。
- complete 只写 attempt；request-level ledger 和 daily aggregate 只能由 finalize 写入。

成功响应：

```json
{
  "ok": true,
  "alreadyCompleted": false,
  "status": "succeeded",
  "usageComplete": true
}
```

### 5.5 Finalize request（保持现有签名）

现有 `finalize_ai_polish_request(...)` 签名和返回字段保持。迁移期间用 `p_metadata.usage_schema_version` 区分唯一事实源：

- 缺失或 `legacy_v1`：沿用现有 `p_usage` request aggregate 路径。
- `attempt_v2`：`p_usage` 必须为 `null`，RPC 在事务中从 completed attempts 聚合并结算一次。
- `attempt_v2` 同时提交非空 `p_usage` 必须拒绝为 `AMBIGUOUS_USAGE_SOURCE`，防止双计。

V2 DB 生命周期统一使用锁顺序：

```text
request row -> attempts by attempt_no -> daily/request aggregates -> global aggregate/config rows as required
```

- `complete` 先锁 request，再锁目标 attempt；request 已 finalized 时返回 `REQUEST_ALREADY_FINALIZED` 且不落账。
- `attempt_v2` finalize 先锁 request，再按 attempt number 锁全部 attempts；存在任何 `started` attempt 时返回 `ATTEMPT_IN_PROGRESS`，不得提前结算。
- reconciler 也先锁 request/attempt，把 stale `started` attempt 原子改为 terminal `unknown`，然后才能 finalize incomplete request。
- 因上述拒绝与锁序，complete 不允许在已 finalized request 后产生一笔未进入 aggregate 的 late fact；late provider outcome 只能形成不含正文的 reconciliation alert，不能静默改历史账本。

Finalize 不创建 attempt，不修改任何 frozen snapshot，也不覆盖已完成 attempt 的 usage/cost。重复 finalize 保持现有幂等语义。

### 5.6 Request aggregate

```ts
interface RequestUsageAggregateV2 {
  schemaVersion: "request_usage_aggregate_v2";
  knownUsage: {
    inputTotalTokens: string;
    inputCacheReadTokens: string;
    inputStandardTokens: string;
    outputTokens: string;
  };
  inputCacheWriteTokens: string | null;
  reasoningTokens: string | null;
  incompleteFields: Array<
    | "attempt_usage"
    | "input_cache_write"
    | "reasoning"
    | "provider_billable"
    | "estimated_cost"
  >;
  usageComplete: boolean;
  providerBillable: boolean | null;
  knownEstimatedCost: MoneyNanosV1 | null;
  estimatedCost: MoneyNanosV1 | null;
}
```

聚合规则：

- `knownUsage` 对所有 `usage !== null` attempts 的 core buckets 求和。若 attempt 1 已知 100 tokens、attempt 2 usage unavailable，则保留已知下界 100，同时 `usageComplete=false` 且包含 `attempt_usage`；不能把已知值清零，也不能把它声称为完整总量。
- `inputCacheWriteTokens` 只有在所有相关 attempts 都报告数值时求和；任一 attempt 为 `null/unavailable` 则 aggregate 为 `null` 并包含 `input_cache_write`。`reasoningTokens` 同理，但它始终只是 output 明细。
- `usageComplete=true` 仅当所有 admitted attempts 都 terminal、均有 observation，且每个 `NormalizedUsageV2.usageComplete=true`。可选 cache-write/reasoning 明细是否影响本字段由 profile calculator capability 决定，并仍通过 `incompleteFields` 公开。
- `providerBillable`：任一 attempt 为 true 则 request 为 true；全部 terminal attempts 明确 false 才为 false；否则为 null。
- `knownEstimatedCost` 累加所有已知、同一 frozen currency 的 attempt estimated cost。若任何 `providerBillable !== false` 的 attempt 成本未知，则 `estimatedCost=null`、包含 `estimated_cost`；否则 `estimatedCost=knownEstimatedCost`。不同币种是 invariant violation，不求和。
- request row 保存上述 aggregate；attempt rows 始终保留逐次事实。daily aggregate 同时保存 known cost 与 incomplete count，不能用 SQL `sum(nullable)` 的结果冒充完整成本。

## 6. HTTP availability 与 route expectation

### 6.1 `GET /api/polish/availability`

该接口只返回当前 DB 时间下、允许向用户展示的候选 route；它不接受 provider/model selector。需要有效登录，以便计算 `termsAccepted`。

```json
{
  "requestId": "server-request-id",
  "availability": {
    "enabled": true,
    "configGeneration": "7",
    "routingPolicyVersionId": "uuid",
    "profileVersionId": "uuid",
    "legalBundleVersion": "<legal-bundle-version>",
    "displayDisclosure": {
      "key": "deepseek-official-v1",
      "providerName": "DeepSeek",
      "modelName": "DeepSeek V4 Flash"
    },
    "termsAccepted": true
  }
}
```

`enabled:false` 时 route/disclosure 字段统一为 `null`，而不是省略，便于 strict schema 保持稳定。接口返回的是候选事实，不构成 reservation；跨时间窗或热切换后可能变化。

### 6.2 POST expectation

POST body additive 增加：

```json
{
  "expectedRoute": {
    "configGeneration": "7",
    "profileVersionId": "uuid",
    "legalBundleVersion": "<legal-bundle-version>"
  }
}
```

- 客户端只能回传 availability 的三个值，不能指定 provider/model/profile。
- server 将其转换为 strict `expected_route_v1` 并传给 `reserve_ai_polish_request_v2`；DB 在锁内按唯一 `v_route_at` 重算 route 后做 generation/profile/legal 精确相等比较，禁止按客户端值选路。
- 不匹配、缺失 expectation 或旧页面提交时，在 quota/rate mutation 与 request-ledger insert 之前返回 `409 AI_ROUTE_CHANGED`。客户端重新读取 availability、刷新披露和同意状态后，由用户再次确认；由于没有创建 reservation，该失败本身不制造永久 dedup row。
- 即使 expectation 匹配，`start_ai_polish_provider_attempt` 仍重读 kill switch 和 frozen profile availability。

共享错误码新增：

```text
AI_ROUTE_CHANGED -> HTTP 409
```

错误响应沿用现有 `{requestId,error:{code,message}}`，不把内部 profile/config 内容放进错误对象。

## 7. Attempt handoff 与请求生命周期

每次真正的 upstream transmission 都遵循：

```text
availability (candidate expectedRoute)
  -> reserve V2 (lock + recompute + assert expectedRoute + freeze snapshot)
  -> start attempt (atomic gate + attempt id)
  -> exactly one adapter transmission
  -> local output validation
  -> complete attempt (usage/route/cost/outcome)
  -> retry with the same snapshot, or finalize request
```

- `start` 成功不是“provider 已收到请求”的证明；runtime 在调用 adapter 前再次检查 abort/deadline。
- 若 start 后因 abort/deadline 未进入 adapter，attempt 以 `canceled`/`timed_out` 完成，`providerBillable=false`、usage null。
- 一旦进入 adapter，transport error/cancel/timeout 未返回 usage 时，attempt `providerBillable=null`、usage null、`usageComplete=false`；不能伪造零。
- 返回有效 usage 但 content/envelope 无效时，先 complete 为 `invalid_output` 并保留成本，再决定同 profile retry。
- adapter 内禁止 retry；orchestrator 总 attempt 上限仍为 2，且同一请求禁止跨 provider fallback。
- request 成功/失败/cancel 的最终 aggregate 必须由 attempt ledger 得出；旧 `legacy_v1` 路径只用于部署兼容和历史行。
- `ai_provider_attempt_ledger.reservation_id` 固定使用 `ON DELETE CASCADE`；90 天 cleanup 可显式先删 child 或依赖该 cascade，但必须有无 orphan/无阻断 fixture。

## 8. Legal bundle 与激活权限

- 初版继续复用 `user_terms_acceptances(document_key='ai_terms')`，不新增逐 profile consent，也不把 consent 变成 provider selector。
- `legalBundleVersion` 与 `current_ai_terms_version()`、代码中的 `AI_TERMS_VERSION` 必须完全相等；acceptance 只有 version 精确相等才有效。
- authorization 的权威判断属于 DB route/reservation：availability 与 reserve 都必须检查 sealed bundle 及 `accepted(document_key='ai_terms', version=routeSnapshot.legalBundleVersion)`。代码中的静态 `AI_TERMS_VERSION` 比较只能作为早期 UX 提示，不能单独授权 provider transmission。
- 一个 bundle 由中性 AI 正文、当期可激活 profile 的 code-owned annex/manifest 组成。初版 bundle 只包含 DeepSeek 与 MiMo；OpenRouter/GPT 后续必须创建新 version。
- 每个 profile version 固定一个 `legal_manifest_id`；routing policy 只能引用其 immutable bundle 已包含的 manifest。price/model snapshot 变化只有在既有 bundle 已明确覆盖同一 manifest/model disclosure、接收方和实质处理规则均未变化时才可不 bump；新 manifest/model 不能静默挂到旧 bundle。新增接收方、训练用途、留存/缓存、地区/跨境路径、数据类别或其他实质变化时必须 bump 并重新接受。
- 中性正文把 separate consent 描述为本服务 operator 选择的授权流程；不得笼统声称所有 provider 的条款都要求 consent。各 annex 只陈述有 provider-specific 证据支持的合同与数据处理事实。
- 本地开发已获授权，可在本地 DB 激活 synthetic/official-direct profile 验证。Preview/Production migration 必须把新 profile/policy seed 为 `draft`/canary-off，且只能通过 audited operator-only activation RPC 改变状态；禁止通过替换环境变量重放本地激活路径。Preview/Production 的 terms 发布、profile canary 和 active policy 仍须仓库 operator 的显式发布授权。
- 当前已发布正文是 DeepSeek-specific；在中性正文、DeepSeek/MiMo annex、exact-bundle acceptance gate 一起实现并通过测试前，禁止任何 MiMo transmission，包括 local live smoke。
- 法律正文是开发草案而非法律意见。未获文档支持的 retention、no-training、固定 region 或 cache TTL 承诺不得写入 annex。

### 8.1 Whole-bundle seal

DB 只存 identifier/hash，不存法律正文：

```text
ai_legal_bundle_versions:
  legal_bundle_version text primary key
  bundle_contract_sha256 text NOT NULL CHECK lowercase-hex-64
  manifest_set_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  sealed_at timestamptz NULL

ai_legal_bundle_manifests:
  legal_bundle_version text references ai_legal_bundle_versions
  legal_manifest_id text
  manifest_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  primary key (legal_bundle_version, legal_manifest_id)
```

bundle 只能在 `sealed_at IS NULL` 时 author；同一 authoring transaction 可插入/纠正 child rows。seal 拒绝 empty set，按 manifest ID 排序重算 canonical set hash，以 null-safe equality 对比 `manifest_set_sha256`，再执行唯一一次且不早于 `created_at` 的 `sealed_at` 转换。seal 后 header 与完整 child set 的 insert/update/delete 全拒绝；增删改 manifest 必须创建新 bundle version 并重新接受。anon/authenticated 无访问权；CFG-000 独占初版 DeepSeek/MiMo bundle authoring 与 seal。

### 8.2 Authoritative validation 与 audited operator mutation

DB-007 提供单一 `assert_ai_routing_policy_v1(policy_id, phase, at)`：严格解析 rules，验证所有 profile lifecycle、composite price/profile、operational eligibility、sealed price components、DB calculator structure、sealed exact legal membership、default profile 一致性与 legacy-lane exclusion。它在 policy 每次进入或处于 `validated/canary/active` 的 transition、每次 pointer change，以及 reserve V2 的任何 quota/rate mutation 前执行。DB-owner triggers 保留同样断言作为 defense in depth。

audited operator RPC 落地后，`service_role` 失去 routing-policy/provider-profile/price/legal lifecycle 与 feature-config pointer 的直接 `UPDATE` 权；只获得 pinned `search_path` 的 `SECURITY DEFINER` operator function `EXECUTE`，每次必须带 actor、reason 与 evidence hashes。所有多对象 lifecycle 操作统一锁序：

```text
ai_feature_config
-> routing policies by UUID
-> profile versions by UUID
-> price versions by UUID
-> audit insert
```

validation、canary/active/retired transition、pointer activation/rollback、profile retirement、price closure、activation/legacy seal 都遵守该顺序。component-authoring transaction 只能锁自己的 draft price，必须先提交，之后不得反向取得 config lock。pointer activation 在改 pointer 前按序锁定所有 target、验证并 seal prices、再次校验 policy；legacy price 只由 owner-only primitive seal。

外部 price evidence refresh 不修改 immutable price row。operator 在激活审计写入 `rechecked_at/rechecked_sha256` 并与 immutable source facts 对比；facts 有实质变化时只能创建新 price 与 policy version。active-pointer audit 还记录 reviewed runtime-contract ID/hash，runtime 在 transmission 前再次对照 code-owned registry；mismatch 无 fallback，并走 no-transmission settlement。

实现 ownership 与 migration integration 顺序固定为：

```text
DB-003A price-lane/provenance/legal/ledger shape
-> CFG-000 initial sealed legal bundle
-> DB-007 strict validator/reserve + private price validation/sealing helper
-> CFG-001 DeepSeek profile/current prices/draft policy
-> DB-012 owner-only historical primitive + legacy price/backfill
-> DB-013 audited lifecycle/activation wrappers reusing DB-007 helper
```

DB-007 的 helper 不 seed、不切 pointer、不暴露普通 lifecycle mutation；DB-012 独占 legacy row/backfill，DB-013 不拥有或重建它。

## 9. 2026-08-23 外部事实约束

这些是实现 fixture 的 checked-at 输入；每次 canary/activation 需重新抓取并保存 canonical fact snapshot/hash。

### DeepSeek V4 Flash

- 当前 CNY 每 1M tokens：低谷 hit ¥0.05、miss ¥1.50、output ¥4.50；高峰 hit ¥0.10、miss ¥3.00、output ¥9.00。
- 高峰：周一至周五 09:00–12:00、14:00–18:00，`Asia/Shanghai`。
- 官方价格页未公布当前 price version 的精确生效日期；不得伪造日期。
- Chat 的 thinking disabled、JSON object、`user_id`、cache hit/miss 与 body `id` 已确认；Responses 详细 wire guide 未冻结，因此当前迁移仍以 Chat compatibility 为准。
- 来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>、<https://api-docs.deepseek.com/api/create-chat-completion/>、<https://api-docs.deepseek.com/guides/kv_cache/>。

### MiMo V2.5 Pro

- 当前 CNY 每 1M tokens：cache hit ¥0.025、cache miss ¥3.00、output ¥6.00；cache write 标为“限时免费”，但未公布截止日期。
- Responses：`POST https://api.xiaomimimo.com/v1/responses`，model=`mimo-v2.5-pro`，初版发送 `reasoning.effort="none"`；不发送未文档化的 `providerSubjectId`、JSON mode、`previous_response_id` 或 `background`。
- body `id` 是 correlation ID；解析整个 `output[]` 的 assistant `output_text`，不能假设第一个 item；usage 使用 input/cached/output/reasoning 字段。
- cache TTL/scope/opt-out、HTTP request-id 和 Responses JSON mode 未获官方确认，不得承诺或依赖。
- 来源：<https://mimo.mi.com/docs/en-US/api/chat/responses>、<https://mimo.mi.com/docs/en-US/price/pay-as-you-go>、<https://mimo.mi.com/docs/en-US/api/guidance/error-codes>。

## 10. 共享 fixture 最小集合

DB、runtime 与 API tests 必须共同覆盖：

1. reserve 返回完整一致的 `route_snapshot_v1`，旧字段仍存在。
2. policy 切换只影响新 reservation；retry snapshot 不变。
3. cache-write `null + unavailable` 往返 DB/TS 后不变成 0。
4. reported 四桶与 unavailable 三桶两套 usage conservation。
5. reasoning 作为 output 明细不重复计价。
6. `attempt_v2` finalize 不能与 legacy `p_usage` 双写。
7. availability → POST 匹配成功；generation/profile/legal 任一变化均在 transmission 前返回 `AI_ROUTE_CHANGED`。
   仅 routing policy version 变化时也必须递增 `configGeneration`，并触发同一 409 路径。
8. kill switch/profile disable 在 reserve 后、attempt 前拒绝且不 fallback。
9. 两次 attempt 的 usage/cost 逐项聚合；未知 usage 保持 incomplete/null。
10. CNY/USD 只分组展示，不直接合计。
11. raw prompt/CV/output/provider error body 不存在于 ledger/log/API error schema。
12. initial legal bundle 精确包含 DeepSeek/MiMo manifest；旧 acceptance 不满足新 version。
13. 静态 `AI_TERMS_VERSION` 匹配但 route snapshot bundle 不匹配时仍不得 transmission；接受新 bundle 后才允许。
14. `pricing_lane` 为 `NOT NULL`；同 profile 不同 lane 可重叠，同 lane overlap/NULL lane 拒绝；current policy 不得引用 `legacy`。
15. strict `routing_rules_v1` 拒绝 unknown key、非法/重叠 window、wrong-profile/unsealed/expired price；边界分钟使用同一 `v_route_at`。
16. reserve V2 mismatch 在 quota/rate/ledger mutation 前失败；`reserved_at`、UTC quota day、minute bucket 与 `resetAt` 都来自唯一 `v_route_at`；同 price 并发 reserve 不互相串行。
17. 首次 request 不能 seal price；activation 与 component insert 正确串行；direct lifecycle DML 无权绕过 audited lock order。
18. sealed legal bundle 不能追加/替换 manifest；hash NULL/malformed/empty set 与 `sealed_at < created_at` 均拒绝。
19. `legacy_pricing_v1` 只允许 exact cost-only shape；partial shape、二次不一致回填、修改 frozen profile/price binding 与 reserve 创建均拒绝。
20. persisted route request IDs 只接受 `hmac-sha256:<64 lowercase hex>`；actual model/endpoint 必须匹配 frozen profile，JWT/API key/prose/path-secret fixtures 全拒绝。
