# AI 润色多 Provider 共享契约

> 契约版本：`ai_provider_contract_v1`
>
> 冻结日期：2026-08-23
>
> 最近修订：2026-08-24（recurring price lanes、legal fingerprint、DB disclosure projection、V2 reserve 与历史 CNY cost-only binding）
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
  runtimeContractId: string;
  runtimeContractSha256: string;
  gatewayKind: "direct_deepseek" | "direct_mimo" | "openrouter";
  modelId: string;
  wireApiKind: "chat_completions_v1" | "responses_v1";
  displayDisclosureKey: string;
}
```

不变量：

- snapshot 的所有 ID 必须来自同一事务内验证通过的组合。
- retry/attempt 继承 reservation snapshot，不能重新读取 active routing、profile、price、legal bundle 或 runtime contract。
- active policy 热切换只影响之后的 reservation。
- `start_ai_polish_provider_attempt` 仍重读 kill switch、用户 allowlist、global capacity 和已冻结 profile 的 availability；若任一不可用，拒绝 transmission，但绝不改路到另一 provider。
- adapter、credential、endpoint、capability、cache policy、calculator 和 legal manifest 都只能解析代码 registry 中的固定 alias；未知 alias fail closed。
- runtime contract pair来自 selected immutable policy，不能来自 env、client或 latest lookup；handler必须在 start attempt/network前解析 code-owned exact ID/hash registry，未知/mismatch fail closed且不 fallback。

`displayDisclosureKey` 的 DB 权威来源是 immutable `ai_provider_profile_versions.display_disclosure_key`，不是 client `expectedRoute`、policy JSON、法律正文或 arbitrary profile `config`。DB-007 additive 增加 nullable、无 default 的该列，non-null 值必须匹配 `^[a-z0-9][a-z0-9._-]{0,199}$`；DB-014 之前不对基础历史行做表级 `NOT NULL`。所有 routing target 在 validator 的任意 phase 都要求该值 non-null；reserve 只从已锁定 selected profile row 复制。

CFG profile seed 的 shared fixture 必须冻结并逐项比较 joined DB projection：`(profile_key, gateway_kind, model_vendor, version, adapter_kind, wire_api_kind, credential_alias, endpoint_alias, model_id, model_snapshot, upstream_route, capability_contract_id, cache_policy_id, legal_manifest_id, display_disclosure_key, config, config_sha256)`。同一 fixture 必须证明其中可执行字段与 code-owned `resolveProfile(profile_key)` 完全相等，`endpoint_alias` 解析到 route descriptor 的 canonical HTTPS URL，DB `model_vendor` 等于 descriptor `model_vendor_id`，`legal_manifest_id/display_disclosure_key` literal-equal descriptor 与中英 `AiProviderLegalManifest` IDs/keys，并以 reviewed mapping 证明 descriptor vendor/operator names 与两种 locale display strings 语义一致；selected price 的 `calculator_kind` 另行与 `resolveProfile(profile_key).calculatorKind` 完全相等。`config_sha256` 必须等于 strict `validateAdapterConfig()` 结果按 RFC 8785 JSON Canonicalization Scheme 产生的 exact UTF-8 bytes 的 SHA-256 lowercase hex，不能是无关 fixture 常量；LEGAL-002A/CFG shared fixture 提交独立 JCS byte/hash vector。`model_snapshot/upstream_route` 等其余 DB-only seed facts 必须来自同一 code-owned fixture，不能由 SQL、policy JSON 或 UI 猜测。

CFG policy seed fixture 还必须冻结 `(policy_key, version, timezone, rules, default_profile_version_id, legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256)`；runtime pair literal-equal RT-009A/RT-011A code constants，catalog root bundle pair literal-equal legal root，global target row与membership逐项等于 rules中 profile的 code-owned profile-key/manifest/route-descriptor mapping。policy `config_sha256` 的 JCS input包含 runtime pair，code-only runtime切换因此必然创建不同 policy version/hash/config generation，不能复用旧 policy row。

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
config_generation/routing_policy_version_id/legal_bundle_version/runtime_contract_id/runtime_contract_sha256 = NULL
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
  "legal_bundle_version": "<legal-bundle-version>",
  "runtime_contract_id": "<runtime-contract-id>",
  "runtime_contract_sha256": "<lowerhex64>"
}
```

RPC 使用一个 configuration linearization sequence：

```text
ai_feature_config FOR SHARE
-> exact routing policy FOR SHARE
-> v_route_at := clock_timestamp() exactly once
-> strict default/window target
-> exact sealed runtime contract FOR SHARE
-> exact runtime memberships + global target projection under the sealed root
-> all policy target profiles FOR SHARE by UUID
-> all policy target sealed prices FOR SHARE by UUID
-> sealed exact legal membership
-> selected target exact runtime/profile/price coverage
-> compare expected generation/profile/legal/runtime
-> quota/rate rows
-> request ledger insert with reserved_at = v_route_at
```

selector、price eligibility、UTC quota day、minute rate bucket、`resetAt` 与 retry-window calculation 都从同一个 `v_route_at` 派生；之后不得用另一处 `now()` 改变 routing/accounting identity。expectedRoute 缺失、malformed 或 generation/profile/legal/runtime 任一不等时，在任何 quota、rate、provider-admission mutation 和 request-ledger insert 之前返回 `AI_ROUTE_CHANGED`。Reserve 不修改 selected price/runtime contract；锁序固定为 config→policy→runtime→profiles-by-UUID→prices-by-UUID→quota/ledger。sealed runtime membership 与 global target catalog 在 parent root 的 `FOR SHARE` 锁后只读；因为 seal 后 root/membership/target catalog 均不可变，无需再对 child 反向取锁。该顺序允许同一 snapshot 并发 reservation，并与 pointer switch、profile lifecycle、price closure/seal/component parent 的对应 `FOR UPDATE` 串行而不形成 runtime↔profile 锁序反转。DB-007 concurrency tests 必须双向覆盖 reserve 对 activation/pointer switch、profile retirement 与 price closure。

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
    "runtimeContractId": "<runtime-contract-id>",
    "runtimeContractSha256": "<lowerhex64>",
    "gatewayKind": "direct_deepseek",
    "modelId": "deepseek-v4-flash",
    "wireApiKind": "chat_completions_v1",
    "displayDisclosureKey": "deepseek-official-v1"
  }
}
```

V2 成功 insert 必须把 exact runtime ID/hash与其余 route fields一起写入 request ledger；route snapshot/result由刚插入行返回，不能从 mutable config重组。DB-007 必须替换 DB-003A 的 route discriminator 与 immutable guard：`route_schema_version='route_snapshot_v1'` 时 runtime ID/hash均为 non-NULL；`route_schema_version IS NULL` 或 `route_schema_version='legacy_pricing_v1'` 时两者均为 NULL；runtime pair加入 frozen route update tuple，不能在 snapshot 写入后新增、清空或更换。V1 RPC/body/grants保持 byte-compatible且不写 runtime pair。handler只接受 code-owned runtime-contract registry中同 ID/hash的实现，并在任何 start-attempt/network前比较；mismatch走 no-transmission settlement。所有现有 denial code 保持。新增配置失败统一返回 `allowed:false`、`reason:"SERVICE_UNAVAILABLE"`，server 记录不含内容的内部原因；未知 alias/profile/price/legal/runtime 组合不得降级到默认 provider。V1/V2 可复用 private quota helper，但 public name、参数与语义保持分离。

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
    "runtimeContractId": "<runtime-contract-id>",
    "runtimeContractSha256": "<lowerhex64>",
    "displayDisclosure": {
      "key": "deepseek-official-v1",
      "providerName": "DeepSeek",
      "modelName": "DeepSeek V4 Flash"
    },
    "termsAccepted": true
  }
}
```

`enabled:false` 时 `configGeneration/routingPolicyVersionId/profileVersionId/legalBundleVersion/runtimeContractId/runtimeContractSha256/displayDisclosure` 统一为 `null`，而不是省略，便于 strict schema 保持稳定；runtime ID/hash不得出现单边 non-null。接口返回的是候选事实，不构成 reservation；跨时间窗或热切换后可能变化。

### 6.2 POST expectation

POST body additive 增加：

```json
{
  "expectedRoute": {
    "configGeneration": "7",
    "profileVersionId": "uuid",
    "legalBundleVersion": "<legal-bundle-version>",
    "runtimeContractId": "<runtime-contract-id>",
    "runtimeContractSha256": "<lowerhex64>"
  }
}
```

- 客户端只能回传 availability 的五个值：generation/profile/legal/runtime ID/runtime hash，不能指定 provider/model/profile；runtime pair必须同时存在且严格匹配 ID/hash grammar。
- server 将其转换为 strict `expected_route_v1` 并传给 `reserve_ai_polish_request_v2`；DB 在锁内按唯一 `v_route_at` 重算 route 后做 generation/profile/legal/runtime ID/hash 精确相等比较，禁止按客户端值选路。
- expectation 整体缺失、任一字段缺失/malformed、runtime ID-only/hash-only、任一值 mismatch、旧页面提交或 runtime-policy switch 时，在 quota/rate mutation 与 request-ledger insert 之前返回 `409 AI_ROUTE_CHANGED`。客户端重新读取 availability、刷新披露和同意状态后，由用户再次确认；由于没有创建 reservation，该失败本身不制造永久 dedup row。
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

ai_legal_manifest_versions:
  legal_manifest_id text primary key
  manifest_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  unique (legal_manifest_id, manifest_sha256)

ai_legal_bundle_manifests:
  legal_bundle_version text references ai_legal_bundle_versions
  legal_manifest_id text
  manifest_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  primary key (legal_bundle_version, legal_manifest_id)
  foreign key (legal_manifest_id, manifest_sha256)
    references ai_legal_manifest_versions(legal_manifest_id, manifest_sha256)
```

`ai_legal_manifest_versions` 是全局 immutable catalog：一旦任意 bundle 发布过 `legal_manifest_id -> manifest_sha256`，任何事务（包括并发事务）都不能用同一 ID 注册不同 hash；catalog row 不可 update/delete。DB-003B 在 CFG-000 前创建 catalog、immutable guard 与 child composite FK，并对 catalog/child manifest IDs 与 bundle header version 增加 ASCII code-ID CHECK `^[a-z0-9][a-z0-9._-]{0,199}$`；它不 seed manifest/bundle。bundle 只能在 `sealed_at IS NULL` 时 author；同一 authoring transaction 可插入/纠正 child rows。seal 拒绝 empty set，按 manifest ID 排序重算 canonical set hash，以 null-safe equality 对比 `manifest_set_sha256`，再执行唯一一次且不早于 `created_at` 的 `sealed_at` 转换。seal 后 header 与完整 child set 的 insert/update/delete 全拒绝；增删改 manifest 必须创建新 bundle version 并重新接受。anon/authenticated 无访问权；CFG-000 独占初版 DeepSeek/MiMo catalog registration、bundle authoring 与 legal-bundle seal。

#### 8.1.1 Canonical legal fingerprint v1

`manifest_sha256` 与 `bundle_contract_sha256` 只能来自 code-owned、locale-neutral、immutable semantic descriptors；不得只 hash 不透明 ID/alias/revision、当前 locale renderer、翻译文本、JS object insertion order 或 Markdown rendered bytes，也不得用 placeholder/repeated-character hash。任何被 root descriptor 引用的 ID/alias/contract 必须把完整 canonical definition 直接放进 root stream，或同时引用一个按本节规则计算的 immutable subdescriptor SHA-256；保留 ID 而改变 referent 必须 fail review。LEGAL-002A 负责提交 descriptors、expected lowercase-hex-64 constants、exact byte vectors 与 cross-locale/source/registry mapping；CFG-000 只复制这些 reviewed constants，不在 SQL 中重建单项 descriptor。

所有 v1 descriptor 都使用下列 exact schemas；`schema_version` 必须等于所在 schema 的 literal。每个字段 required exactly once，unknown/missing field 拒绝。未标 boolean 的 scalar 都只接受 string；`[]` 只接受 primitive string array，不接受 sparse array、object、number、`null` 或隐式 coercion；boolean 只接受 boolean。除 schema 明确要求 unavailable/none 时为空的 `operator_legal_name`、subject `wire_field/algorithm/secret_class/derivation_message_schema/output_encoding/source_identity_class`、source `source_revision/upstream_snapshot_artifact_path/upstream_snapshot_sha256`，以及非 service-operational fact 的 `operational_scope` 外，所有 string scalar/array element 在 NFC 后必须非空。`schema_version`、`manifest_id`、`route_descriptor_id`、`subject_descriptor_id`、`fact_id`、`supported_fact_id`、`evidence_id`、`runtime_evidence_id`、`runtime_target_id`、`contract_id`、`runtime_contract_id`、`legal_bundle_version`、`ai_terms_version`、`display_disclosure_key` 及对应 ID arrays 必须匹配 ASCII code-ID `^[a-z0-9][a-z0-9._-]{0,199}$`，因此 DB/raw/NFC 不存在等价 Unicode ID 分叉。所有非空、字段名以 `_sha256` 结尾的 scalar，以及所有 `*_sha256s[]` element，必须是 lowercase-hex-64。所有 `*_ids[] + *_sha256s[]` 都是同长度 pair arrays：先按 ID 的 ASCII/UTF-8 bytes 排序整对记录，ID 不得重复；root route/fact/evidence/manifest arrays、每个 evidence 的 supported-fact arrays、五类 semantic-contract fact/evidence arrays以及 runtime-contract target/fact/evidence arrays 均不得为空，只有 `qualifiers[]`、MiMo `documented_purposes[]` 可为空。`reviewed_at/checked_at` 的 v1 date-only evidence format 固定为 `YYYY-MM-DD@Asia/Shanghai`，不得伪造未记录的时分秒。

```text
ai_legal_route_identity_v1:
  schema_version
  route_descriptor_id
  profile_key
  gateway_kind
  operator_identity_status       # known | unverified
  operator_legal_name            # known 时 exact；unverified 时必须为空串
  model_vendor_id
  model_vendor_name
  model_id
  wire_api_kind
  endpoint_alias
  canonical_endpoint_url         # exact HTTPS URL，不是仅 alias
  display_disclosure_key

ai_legal_provider_subject_v1:
  schema_version
  subject_descriptor_id
  mode                           # pseudonymous_hmac | none
  wire_field                     # DeepSeek=user_id；none 时为空串
  algorithm                      # DeepSeek=hmac-sha256；none 时为空串
  secret_class                   # DeepSeek=utf8-trimmed-env:AI_USER_ID_HMAC_SECRET；none 时为空串
  derivation_message_schema      # exact domain/profile/user byte-format；none 时为空串
  output_encoding                # DeepSeek=lowercase-hex；none 时为空串
  source_identity_class          # DeepSeek=authenticated-user-id；none 时为空串
  raw_email_sent                 # boolean
  raw_username_sent              # boolean
  raw_account_id_sent            # boolean
  documented_purposes[]          # set-like；绑定 content-safety/cache/scheduling 等 exact purposes

ai_legal_fact_v1:
  schema_version
  fact_id
  category                       # submitted-data/gateway/operator/model/wire/endpoint/display/provider-subject/region/cache/retention/training/transfer/unknown/service-processing/ledger/quota/output-review/privacy-linkage/acceptance/route-disclosure/material-change
  authority_class                # provider-external | service-operational | service-display
  operational_scope              # service-operational only: global | profile:<profile_key>；其他必须为空串
  status                         # confirmed | unverified | not-found | not-applicable
  subject
  predicate
  object
  scope
  qualifiers[]                   # set-like

ai_legal_source_evidence_v1:
  schema_version
  evidence_id
  authority_kind                 # provider-official | service-contract | service-registry | service-implementation | service-test | service-legal
  source_locator_kind            # https-url | repo-path
  source_locator
  checked_at                     # initial evidence snapshot time
  source_revision_status         # known | unavailable
  source_revision                # unavailable 时必须为空串
  upstream_snapshot_status       # sha256 | unavailable
  upstream_snapshot_artifact_path # unavailable 时必须为空串
  upstream_snapshot_sha256       # unavailable 时必须为空串
  reviewed_excerpt               # exact locale-neutral checked-fact summary；无换行
  reviewed_excerpt_sha256        # SHA-256(exact NFC UTF-8 reviewed_excerpt bytes)
  supported_fact_ids[]
  supported_fact_sha256s[]

ai_legal_manifest_fingerprint_v1:
  schema_version
  manifest_id
  display_disclosure_key
  reviewed_at
  route_descriptor_ids[]
  route_descriptor_sha256s[]
  subject_descriptor_id
  subject_descriptor_sha256
  fact_ids[]
  fact_sha256s[]
  evidence_ids[]
  evidence_sha256s[]

ai_legal_bundle_semantic_contract_v1:
  schema_version
  contract_id
  contract_kind                  # neutral-body | privacy-ai | acceptance | route-disclosure | material-change
  fact_ids[]
  fact_sha256s[]
  evidence_ids[]
  evidence_sha256s[]

ai_legal_bundle_contract_fingerprint_v1:
  schema_version
  legal_bundle_version
  document_key                   # exact ai_terms
  ai_terms_version
  manifest_fingerprint_schema_version
  semantic_contract_schema_version
  neutral_body_contract_id
  neutral_body_contract_sha256
  privacy_ai_contract_id
  privacy_ai_contract_sha256
  acceptance_contract_id
  acceptance_contract_sha256
  route_disclosure_contract_id
  route_disclosure_contract_sha256
  material_change_contract_id
  material_change_contract_sha256
  manifest_ids[]
  manifest_sha256s[]

ai_service_runtime_evidence_v1:
  schema_version
  runtime_evidence_id
  authority_kind                 # service-implementation | service-test
  supported_fact_id
  supported_fact_sha256
  source_repo_path               # repo-relative tracked implementation/test path
  source_git_blob_sha256         # SHA-256(exact Git blob bytes)

ai_service_runtime_target_v1:
  schema_version
  runtime_target_id
  profile_key
  legal_manifest_id
  legal_manifest_sha256
  route_descriptor_id
  route_descriptor_sha256

ai_service_runtime_contract_v1:
  schema_version
  runtime_contract_id
  reviewed_source_commit_oid     # exact sha1:<40 lowercase hex> pre-attestation integration commit
  legal_bundle_version
  bundle_contract_sha256
  runtime_target_ids[]
  runtime_target_sha256s[]
  service_fact_ids[]
  service_fact_sha256s[]
  runtime_evidence_ids[]
  runtime_evidence_sha256s[]
```

root reference 必须解析为 exact schema/version/ID，而不只是 hash shape：manifest 的 route/fact/evidence pairs 分别只能解析 `ai_legal_route_identity_v1`/`ai_legal_fact_v1`/`ai_legal_source_evidence_v1` 且 subdescriptor ID literal-equal pair ID；subject slot 只能解析 ID 相等的 `ai_legal_provider_subject_v1`。bundle manifest pairs 只能解析 ID 相等的 `ai_legal_manifest_fingerprint_v1`；五个 named contract slots 只能解析 `ai_legal_bundle_semantic_contract_v1`，其 fact/evidence pairs 必须解析 exact `ai_legal_fact_v1`/`ai_legal_source_evidence_v1`，且 `contract_id` 相等、`contract_kind` 分别严格等于 slot 的 `neutral-body|privacy-ai|acceptance|route-disclosure|material-change`。每个 `ai_legal_source_evidence_v1.supported_fact_ids[]/supported_fact_sha256s[]` pair 还必须解析为 ID/hash 都相等的 exact `ai_legal_fact_v1`。runtime target 只能解析 `ai_service_runtime_target_v1`：其 manifest pair 必须是 bound bundle 的 exact child/catalog pair，其 route pair必须是该 manifest root引用的 exact route descriptor，且 route descriptor `profile_key` literal-equal target `profile_key`。runtime evidence 只能解析 `ai_service_runtime_evidence_v1`，其单一 supported fact 必须解析 `authority_class=service-operational` 的 exact fact；runtime contract 只能解析 ID/hash 相等的 target、runtime evidence 与 service-operational facts，并 literal-equal 绑定一个已 sealed bundle root 的 version/hash。任一 descriptor/subdescriptor ID 在 code artifact 内也是 immutable one-to-one ID→hash mapping；schema/version/kind/ID/hash mismatch 一律 fail closed。

route/subject 每个字段的 authority classification 冻结如下，不允许 worker 遗漏或改类。表中的“bundle authoring”是 LEGAL-002A/CFG-000 的 immutable semantic/evidence closure；“operational attestation”由后置 RT-009A、owner-only CFG registration 与 DB runtime validation gate 完成，不进入 legal bundle fingerprint：

| 字段 | 分类 | bundle authoring mandatory closure | operational attestation before validated/canary/active/reserve |
|---|---|---|---|
| 各 `schema_version`、`route_descriptor_id`、`subject_descriptor_id` | identity-only | exact schema/ID/hash resolution；不创建伪 semantic fact | none |
| `profile_key`、`endpoint_alias` | identity-only | immutable service-registry + shared seed mapping | selection 的 service fact 由 implementation + test 覆盖 |
| `display_disclosure_key` | identity-only key + service-owned displayed meaning | registry literal equality；service-legal cross-locale mapping覆盖 resolved meaning | implementation + test |
| `gateway_kind` | service-owned route fact | gateway fact + service-contract + service-registry | implementation + test |
| `operator_identity_status/operator_legal_name` | external/provider fact | operator fact + provider-official；unverified 也必须由 checked evidence 支持 | none |
| `model_vendor_id/model_vendor_name/model_id` | external capability/identity + service-owned selection | external model fact + provider-official；独立 selection fact + service-contract + service-registry | selection fact 由 implementation + test 覆盖 |
| `wire_api_kind` | external capability + service-owned selection | external wire fact + provider-official；独立 selection fact + service-contract + service-registry | selection fact 由 implementation + test 覆盖 |
| `canonical_endpoint_url` | external endpoint + service-owned selection | external endpoint fact + provider-official；独立 selection fact + service-contract + service-registry | selection fact 由 implementation + test 覆盖 |
| subject `mode` | service-owned behavior | provider-subject fact + service-contract | implementation + test |
| subject `wire_field`、`documented_purposes[]` | provider-documented capability + service-owned send behavior | external capability fact + provider-official；独立 actual-send fact + service-contract | actual-send fact 由 implementation + test 覆盖 |
| subject `algorithm/secret_class/derivation_message_schema/output_encoding/source_identity_class/raw_*_sent` | service-owned privacy behavior | provider-subject fact + service-contract；显示语义另有 service-legal | implementation + test；DeepSeek derivation 还必须在 LEGAL-002A 引用已先完成的 RT-002B blobs |

identity-only 字段不声称 provider 行为；它们靠 immutable ID/hash、registry 与 cross-locale mapping闭包。mixed classification 必须拆成独立 `provider-external` fact 与 `service-operational` selection/behavior fact，不能用一个 fact 把不同 authority 混成并集。`service-display` 只用于本服务的显示文字、链接、用户义务或法律定义，不得承载“系统实际如何发送/选择/授权/存储”的承诺。只有 `service-operational` 允许非空 `operational_scope`：跨所有 targets且不含 target-specific recipient/model/subject语义时用 exact `global`；其余必须用 `profile:<profile_key>`，其中 profile key匹配 ASCII code-ID；一个 fact不得声明多个 profile，需逐 profile拆分。`provider-external|service-display` 的 scope必须为空串。service-owned promise 不得借用 provider evidence，provider-documented claim 也不得只靠本服务代码自证。

`ai_legal_fact_v1.subject/predicate/object/scope/qualifiers` 是被 hash 的完整 normative meaning，不得只是另一个可变 lookup key。MiMo 中国大陆 operator 必须使用 `operator_identity_status=unverified` 且空 `operator_legal_name`，不能推断为 Xiaomi Singapore；outside-mainland named entity 只能作为带 scope 的 reviewed fact。DeepSeek subject descriptor 必须绑定 HMAC-SHA256、server-held secret class、wire `user_id`、lowercase-hex pseudonym、三项 documented purpose 以及 email/username/raw account ID 均不发送。V2 exact HMAC message bytes 是以下拼接，所有 literal 均为所示 ASCII，UUID placeholder 先替换再编码，尖括号/文字 `UUID` 不进入 bytes，末尾无 LF/NUL：

```text
ASCII("provider-subject-v2\nprofile_version_id:")
+ ASCII(canonical profile UUID)
+ ASCII("\nuser_id:")
+ ASCII(canonical authenticated-user UUID)
```

两个 UUID 均须成功解析 RFC 4122 8-4-4-4-12 form 后重新序列化为 36-byte lowercase ASCII；subject descriptor 的 `derivation_message_schema` exact scalar value 是 `ASCII(provider-subject-v2\\nprofile_version_id:)+UUID36LOWER(profile_version_id)+ASCII(\\nuser_id:)+UUID36LOWER(user_id)`，其中 `\\n` 描述上方实际单个 LF byte，不是反斜杠+n bytes；`secret_class` exact value 是 `utf8-trimmed-env:AI_USER_ID_HMAC_SECRET`。HMAC key 是 trim 后非空 secret 的 UTF-8 bytes，算法 HMAC-SHA256，输出 64 lowercase hex。该 derivation 只属于已经取得 immutable profile snapshot 的 V2 handler；V2 handler 不得调用或复用 legacy subject derivation。三参数 V1 RPC/body/legacy handler 保持 byte-compatible 与现有裸-user-ID HMAC，仅作为旧 deployment/policy rollback surface；V2 policy cutover 后的新 handler 不暴露/选择 V1 path，回滚必须整体切回兼容 deployment/policy，不能在一个 reservation 内混用。MiMo descriptor 必须显式绑定 `mode=none`，上述 algorithm/derivation fields 为空。

每个 endpoint 同时绑定 alias 与 registry canonical HTTPS URL；URL 是 reviewed exact string，不做 redirect 或运行时 normalization 后再 hash。route identity 中的 gateway/operator/model/wire/endpoint/display claims 与 subject descriptor 中的 provider claims 必须各自由对应 category 的 fact subdescriptor镜像。provider-documented claims 由 `provider-official` evidence 覆盖；本服务 HMAC/no-raw/service-routing facts按上表由 exact `service-*` evidence closure 覆盖，不能伪称 provider 官方事实。code registry mapping 是附加验证，不能代替相应 authority evidence。

每个 source evidence descriptor 必须把 authority、locator、checked-at、known revision/date（若来源提供）、snapshot 状态、reviewed excerpt 及其 digest、supported fact ID/hash pairs 一起绑定。`authority_kind` exact enum 是 `provider-official|service-contract|service-registry|service-implementation|service-test|service-legal`；各 authority 不可互相代替。`provider-official` 只接受 exact HTTPS locator；所有 `service-*` 只接受 repo-relative tracked path，且 `upstream_snapshot_status=sha256`。若 snapshot 可用，artifact path 必须是 repo-relative tracked file，digest 是该文件 exact Git blob bytes（`git cat-file blob <treeish>:<path>`，不做 EOL/BOM/Unicode normalization）的 SHA-256；若 provider snapshot unavailable，artifact path/hash 都为空，但 `reviewed_excerpt` 仍 mandatory。`reviewed_excerpt_sha256` 始终只对 descriptor 中 exact NFC UTF-8 excerpt bytes计算，无 prefix/BOM/line ending；excerpt 本身禁止 CR/LF。LEGAL-002A fixture 固定 artifact path/blob SHA/excerpt bytes，并由独立 reader复算；mutable URL 不能单独充当证据。未证实事项使用 `unverified/not-found`，不得推断为承诺。

evidence coverage 必须 root-scoped，而不是全局搜索：对每个 manifest，令 `F` 为该 manifest 自己的 fact pairs、`E` 为该 manifest 自己的 evidence pairs；`E` 中每个 supported-fact pair 必须属于 `F`，每项 evidence 至少支持一个 `F`，且每个 `F` 都必须由 `E` 内 evidence 满足上表的 bundle-authoring authority set。对每个 semantic contract 使用完全相同规则，以该 contract 自己的 fact/evidence pairs 为 `F/E`，并按 fact 中 exact `authority_class` 验证：`provider-external` 至少 `provider-official`，`service-operational` 至少 `service-contract`，`service-display` 至少 `service-contract + service-legal`；表中 registry-valued facts仍额外要求 `service-registry`。任何不在该 root `E` 中的 global evidence、其他 manifest 或其他 contract evidence 都不能补足 closure。mixed field 的 external/service facts分别闭包，不能跨 fact 借 authority。

legal bundle authoring 不等待尚未实现的 route/DB/handler blobs：provider material fact 在 authoring 时必须有同 root 的 `provider-official` evidence；service-owned material fact必须有同 root 的 `service-contract`，registry-valued fact另需 `service-registry`，`service-display` 另需 `service-legal`。已存在的 implementation/test evidence 可以附加但不能替代 contract；DeepSeek exact derivation 是唯一前置特例，LEGAL-002A 必须引用 RT-002B reviewed implementation/test blobs。后续实现不是伪装成预先存在的 immutable legal evidence，而是由 RT-009A 生成独立 `ai_service_runtime_contract_v1`。令 `P` 为 runtime targets 中 exact profile-key set；其 required service-fact set 必须精确等于 bound bundle所有五个 semantic roots及 covered target manifest roots传递可达、且 `authority_class=service-operational AND (operational_scope='global' OR operational_scope IN {'profile:' + p | p in P})` 的全部 fact pairs；同一 pair只出现一次。未 covered 的其他 manifest（初版 G2 的 MiMo）facts、scope不匹配 facts、`provider-external` 与 `service-display` facts不进入集合；missing/extra 都拒绝。每个 root-local runtime evidence必须恰好解析其中一个 required fact，且每个 required fact同时包含 `service-implementation` 与 `service-test`。实际 route 的只读接收方/annex披露、无 selector、expectedRoute 提交及 route/bundle change-before-transmission gate均属于该集合；因此 LEGAL-003 与 UX-002/003/004 的实现和测试必须在 RT-009A 的 pre-attestation commit 前完成并通过 exact-head review，不能引用计划或把这些行为降类为 `service-display`。DeepSeek-only contract只能列 DeepSeek runtime target；MiMo adapter完成后可在同一 legal bundle上发布覆盖 DeepSeek+MiMo targets的新 runtime contract而不 bump terms。

`reviewed_source_commit_oid` 必须是 exact `sha1:<40 lowercase hex>`，去掉 `sha1:` 后 `git cat-file -t` 必须返回 `commit`；它指向 RT-009A descriptor提交前、已完成所有被引用实现/测试 exact-head review的 integration commit。`source_repo_path` 只接受 ASCII `[A-Za-z0-9._/-]+` 与 `/` separator：不得以 `/` 开头、不得含 `\`、`:`、空 segment、`.`/`..` segment、drive/UNC form或 trailing slash。验证只能用 Git object database在该 commit按 case-sensitive exact path解析 regular blob，不能依赖 Windows filesystem normalization/symlink；`source_git_blob_sha256` 对 `git cat-file blob <commit>:<path>` 返回的 exact blob content bytes计算。runtime evidence 不得引用 RT-009A 自身 descriptor/test、其后 commit或未来 DB-013；任何 unresolved/tree/symlink/submodule/self/future path 都 fail closed。

DB-007 创建空的 immutable runtime-contract root catalog、global runtime-target catalog、contract-target memberships、policy binding与 reservation snapshot字段；RT-009A 随后生成 reviewed constants，CFG-001 才注册 DeepSeek-only root/target/membership并让新的 draft policy通过 exact composite FK绑定它。所有 runtime root/target/membership registration 仅允许由 repository-reviewed、owner-only CFG migration复制同一提交中的 exact code constants；不得提供 service-role/客户端可调用的 generic registration RPC，也不得在 DB-013 接受 caller-supplied descriptor/root/target registration material。后续 code-only contract使用新的显式 CFG migration（初版 MiMo为 CFG-002）注册。DB-013 创建新policy时必须由operator显式提供已存在的 exact `(runtime_contract_id,runtime_contract_sha256)` selector；wrapper只能在该pair sealed、bundle exact-equal且target coverage完整后接受，不能按 latest/any猜测，也不能创建runtime contract。validated/canary/active transition、pointer activation/rollback 与 reserve operational eligibility 只接受 policy immutable binding所指、与 policy legal bundle完全相等且覆盖每个 policy target profile-key+manifest pair/route pair的 runtime contract。runtime pair冻结进 reservation/request ledger；handler在 start-attempt/任何 network前与 code-owned runtime-contract registry比较，mismatch不发上游。code-only change必须先部署同时支持旧/新 exact pairs的兼容 registry，再由 reviewed CFG migration注册新 contract、创建新 policy、切 pointer并递增 generation；旧 pair只可在零 unfinished reservations后从后续 deployment移除。若 semantic fact变化，仍必须新 legal bundle并重新接受。

五类 bundle semantic contract 必须以 fact subdescriptor 绑定而非 opaque revision ID，并至少完整覆盖：neutral body 的 plaintext/E2EE、发送范围、ledger/retention、quota/retry 与 output review；Privacy 的 route-specific recipient linkage、transfer boundary 与 retention；acceptance 的 `document_key=ai_terms`、exact-version acceptance 与 DB-authoritative authorization；route disclosure 的 read-only、无 provider selector、无跨-provider fallback、route/bundle change-before-transmission；material-change 的 recipient/gateway/upstream/model coverage、data class、subject behavior、region/transfer、cache/retention、training。root 必须断言 `ai_terms_version == legal_bundle_version`、两个 schema version 与实际 subdescriptor schema 完全一致，且 manifest ID/hash pairs 与 DB child set 完全相等。

semantic facts 也必须用 hashed `authority_class/operational_scope` 逐项拆分：provider 的 recipient/region/retention/training 等外部陈述是 `provider-external`；本服务实际 plaintext boundary、发送范围、ledger/retention、quota/retry、recipient route linkage、DB acceptance authorization、read-only/no-selector/no-fallback 与 route/bundle-change transmission gate是 `service-operational`，其中只要语义涉及特定 recipient/model/profile/subject就必须用对应 `profile:<profile_key>`，真正与 target无关的共同控制才用 `global`；风险提示、用户 output-review 义务、链接/显示文字及 material-change 法律定义是 `service-display`。material-change 检测与重新接受 enforcement 若作为系统行为陈述则另建 `service-operational` fact并精确 scope。owner-only CFG registration 与 DB-013 的 operator audit、锁序和 lifecycle meta-gate 是内部 control-plane governance，不是 end-user semantic fact，禁止放入这三类 legal roots或 RT-009A required fact set；它们分别由 CFG shared-constant review及 DB-013 schema/security/concurrency review证明，因此不存在 RT-009A 对后续 migration 的 self-reference。

canonicalizer 在 NFC 前先验证每个 string 是合法 Unicode scalar sequence；lone UTF-16 surrogate 拒绝，不能让 `TextEncoder` 用 U+FFFD 代换。之后执行 NFC；set-like array 和所有 pair-ID arrays 在 NFC 后若重复则拒绝，不得静默去重。ordered arrays 保持 reviewed 顺序。所有 descriptor key 只能匹配 ASCII `[a-z0-9._-]+`；string 禁止 NUL/CR/LF。schema-declared integer（如有）、derived `.count` 与 key/value byte length 使用 ASCII canonical decimal `0|[1-9][0-9]*`；不得有符号、空格或前导零。boolean record value 只能是 `true|false`。

每个 array 展开为 `<field>.count` 与 `<field>.0 ... <field>.<n-1>`；record 数必须恰好等于 scalar/boolean field 数加每个 array 的 `1 + length`，不能漏字段或追加未知 record。完整 stream 以 exact ASCII bytes `ai_fingerprint_record_v1\n` 开头；随后按该 schema 上述 field 顺序输出，每条 `(key,value)` 为：

```text
<key UTF-8 byte length>:<key>:<value UTF-8 byte length>:<value>\n
```

hash 是完整 bytes 的 SHA-256 lowercase hex；长度只按 UTF-8 bytes，不按 JS UTF-16 code units。LEGAL-002A 必须发布至少一个 ASCII vector、一个 multibyte/NFC vector及 lone-surrogate/duplicate rejection vector；fixture 保存 exact input、exact stream UTF-8 hex 与 independently produced expected hash，生产 canonicalizer 不能用自己的输出生成 expected bytes/hash 后再验证自己。

`manifest_set_sha256` 继续由 DB 从 reviewed child pairs 计算，不是第三个手工常量：使用 DB 原样存储的 manifest ID UTF-8 bytes，按 C collation 排序；每项 exact bytes 为 `<manifest-id UTF8 byte length>:<manifest-id>:<lowerhex64 manifest hash>`，无 prefix，项间恰好一个 LF，末尾无 LF，然后 SHA-256。seal 前必须断言 bundle descriptor 的 manifest IDs 与 child IDs 完全同集、每个 child hash 等于 descriptor reviewed hash、catalog mapping 相等；empty/missing/extra/duplicate/mismatch 全部 fail closed。

descriptor、subdescriptor 及其 referent 一经发布绝不原地变化；任一 ID 永远不能重新绑定不同 hash。`reviewed_at` 是该 manifest version 的初始 evidence snapshot 时间，不是可更新的 last-reviewed；事实未变化的复核只写 audit，不改任何 descriptor/hash/ID/version。route/subject/provider fact/evidence graph 变化必须创建新 manifest ID/hash；bundle semantic graph 变化必须创建新 contract ID/hash；bundle root、semantic contract 或 manifest composition/hash 变化必须创建新 `legal_bundle_version`，且 `ai_terms_version` exact-equal，旧 acceptance 不授权。未变化 provider manifests继续复用全局 catalog，不得无谓 churn。任何 material change 都必须重新接受；初版不得增加现有中英 annex/evidence 未支持的承诺。

### 8.2 Authoritative validation 与 audited operator mutation

DB-007 的 `20260823233000_expand_ai_routing_runtime_contract.sql` 先创建空 root catalog、global target catalog、membership 与 binding columns；它不注册 contract/target、不 seed policy、不切 pointer：

```text
ai_service_runtime_contract_versions:
  runtime_contract_id text primary key CHECK ASCII code-ID
  runtime_contract_sha256 text NOT NULL CHECK lowercase-hex-64
  reviewed_source_commit_oid text NOT NULL CHECK ^sha1:[0-9a-f]{40}$
  legal_bundle_version text NOT NULL
  bundle_contract_sha256 text NOT NULL CHECK lowercase-hex-64
  runtime_target_set_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  sealed_at timestamptz NULL
  UNIQUE(runtime_contract_id, runtime_contract_sha256)
  FOREIGN KEY(legal_bundle_version, bundle_contract_sha256)
    REFERENCES ai_legal_bundle_versions(legal_bundle_version, bundle_contract_sha256)

ai_service_runtime_target_versions:
  runtime_target_id text PRIMARY KEY CHECK ASCII code-ID
  runtime_target_sha256 text NOT NULL CHECK lowercase-hex-64
  profile_key text NOT NULL CHECK ASCII code-ID
  legal_manifest_id text NOT NULL CHECK ASCII code-ID
  manifest_sha256 text NOT NULL CHECK lowercase-hex-64
  route_descriptor_id text NOT NULL CHECK ASCII code-ID
  route_descriptor_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  UNIQUE(runtime_target_id, runtime_target_sha256)
  UNIQUE(runtime_target_id, runtime_target_sha256, profile_key,
         legal_manifest_id, manifest_sha256,
         route_descriptor_id, route_descriptor_sha256)
  FOREIGN KEY(legal_manifest_id, manifest_sha256)
    REFERENCES ai_legal_manifest_versions(legal_manifest_id, manifest_sha256)

ai_service_runtime_contract_targets:
  runtime_contract_id text NOT NULL CHECK ASCII code-ID
  runtime_contract_sha256 text NOT NULL CHECK lowercase-hex-64
  runtime_target_id text NOT NULL CHECK ASCII code-ID
  runtime_target_sha256 text NOT NULL CHECK lowercase-hex-64
  profile_key text NOT NULL CHECK ASCII code-ID
  legal_manifest_id text NOT NULL CHECK ASCII code-ID
  manifest_sha256 text NOT NULL CHECK lowercase-hex-64
  route_descriptor_id text NOT NULL CHECK ASCII code-ID
  route_descriptor_sha256 text NOT NULL CHECK lowercase-hex-64
  created_at timestamptz NOT NULL
  PRIMARY KEY(runtime_contract_id, runtime_target_id)
  UNIQUE(runtime_contract_id, profile_key)
  FOREIGN KEY(runtime_contract_id, runtime_contract_sha256)
    REFERENCES ai_service_runtime_contract_versions(runtime_contract_id, runtime_contract_sha256)
  FOREIGN KEY(runtime_target_id, runtime_target_sha256, profile_key,
              legal_manifest_id, manifest_sha256,
              route_descriptor_id, route_descriptor_sha256)
    REFERENCES ai_service_runtime_target_versions(
      runtime_target_id, runtime_target_sha256, profile_key,
      legal_manifest_id, manifest_sha256,
      route_descriptor_id, route_descriptor_sha256)

ai_routing_policy_versions additive columns:
  runtime_contract_id text NULL
  runtime_contract_sha256 text NULL
  CHECK both NULL or both non-NULL
  FOREIGN KEY(runtime_contract_id, runtime_contract_sha256)
    REFERENCES ai_service_runtime_contract_versions(runtime_contract_id, runtime_contract_sha256)

ai_polish_request_ledger additive snapshot columns:
  runtime_contract_id text NULL
  runtime_contract_sha256 text NULL
  replacement discriminator CHECK:
    route_snapshot_v1 => both non-NULL
    NULL or legacy_pricing_v1 => both NULL
  FOREIGN KEY(runtime_contract_id, runtime_contract_sha256)
    REFERENCES ai_service_runtime_contract_versions(runtime_contract_id, runtime_contract_sha256)
  guard: runtime pair joins the immutable frozen-route update tuple
```

DB-007 同时给 `ai_legal_bundle_versions` 增加 `(legal_bundle_version,bundle_contract_sha256)` unique key供 composite FK。global target catalog以 `runtime_target_id` PK冻结全局一对一 ID→hash，并把 target hash对应的 profile/manifest/route projection整组存储；每个 target row自插入起whole-row immutable且不可 delete。contract membership通过上述 full-projection composite FK引用 target catalog，因此不能把正确 target hash与错误 DB projection配对，也允许多个 runtime contracts安全复用同一 exact target；membership 的 contract ID/hash均non-null，不能用 `MATCH SIMPLE` NULL语义绕过root FK，且 UPDATE不得改变parent contract ID/hash（跨parent只能显式delete+insert）。每次 membership insert/update/delete 必须先 `SELECT`其唯一 exact parent root `FOR UPDATE`，再断言 `sealed_at IS NULL`。runtime root 的 ID/hash/bundle/source-commit/target-set/created-at字段不可更新，row不可 delete；seal使用同一parent `FOR UPDATE`锁，在锁内重新读取、C-sort、重算全部membership后，才允许一次 `sealed_at: NULL -> timestamp`且timestamp不得早于`created_at`，除此之外任何root update均拒绝。seal 后该 root及其membership全部 immutable，不能再 insert/update/delete。DB-007必须覆盖 mutation-first 和 seal-first 的 insert/update/delete双向竞态，证明后提交者不能改变sealed set，并覆盖membership UPDATE改parent pair拒绝。seal 拒绝 empty targets并从 membership中 DB 原样 `runtime_target_id/hash` pairs重算 `runtime_target_set_sha256`：按 C collation排序，每项 exact bytes为 `<target-id UTF8 byte length>:<target-id>:<lowerhex64 target hash>`，无 prefix、项间单 LF、末尾无 LF。anon/authenticated/service_role 对三个 catalog均无 DML；没有 generic registration definer function。CFG-001 初版 registration由 migration owner在一个事务插 exact reviewed target/root/membership、逐字段对照 shared code fixture、重算并 seal；后续每个 runtime registration也必须由新的 owner-only CFG migration复制该版本 reviewed code constants，DB-013无 registration authority。

policy 的 runtime pair是唯一 authoritative selection：不设 global “current runtime” pointer，不按时间/latest/任一 bundle contract猜测。既有历史 policy允许 NULL以保持 expand兼容，但 strict validator任意 phase均要求 pair non-NULL、catalog sealed、catalog bundle version/hash等于 policy的 exact current sealed legal bundle，并对 rules 中每个 target profile join `ai_provider_profiles.profile_key + ai_provider_profile_versions.legal_manifest_id + global manifest hash`，再以 code-owned route descriptor ID/hash要求同一 runtime contract存在 literal-equal membership与global target full projection。policy execution fields immutable，因此 code-only runtime切换创建新 policy version并通过现有 feature-config pointer原子切换；不能原地换 runtime pair。

DB-007 提供单一 `assert_ai_routing_policy_v1(policy_id, phase, at)`：严格解析 rules，验证所有 profile lifecycle、composite price/profile、operational eligibility、sealed price components、DB calculator structure、sealed exact legal membership、default profile 一致性、non-null display disclosure 与 legacy-lane exclusion。`phase` exact vocabulary 为 `validated|canary|active|reserve`；NULL/unknown phase 或 NULL `at` fail closed。

| phase | persisted policy status | target profile status | price/provider operational eligibility at `at` | caller |
|---|---|---|---|---|
| `validated` | `validated` | `validated|canary|active` | 跳过 lower bounds、允许 future；仍拒绝已过期、要求 exact ownership、非 legacy、sealed 且结构合法 | policy 进入/处于 validated 的 transition/revalidation |
| `canary` | `canary` | `canary|active` | required | policy 进入/处于 canary；pointer 指向 canary |
| `active` | `active` | `active` | required | policy 进入/处于 active；pointer 指向 active |
| `reserve` | `canary|active` | policy=canary 时 `canary|active`；policy=active 时只允许 `active` | required | reserve V2，且 policy 必须是当前 locked pointer |

所有 phase 都要求 strict `routing_rules_v1`、default pair 一致、profile/price composite ownership、price sealed/structure valid、profile `display_disclosure_key` non-null、current sealed legal header、target exact manifest membership、全局 manifest catalog exact mapping、policy exact runtime pair、sealed matching runtime catalog与每个 target exact profile-key/manifest child coverage、无 retired 对象和无 `legacy` lane。`validated` 对每项 price 精确要求 `(valid_to IS NULL OR at < valid_to)` 且 `(provider_effective_to IS NULL OR at < provider_effective_to)`；它不检查 `valid_from/provider_effective_from` lower bounds，因此允许 future，但绝不允许已过期 price。`canary/active/reserve` 精确要求 `valid_from <= at AND (valid_to IS NULL OR at < valid_to) AND (provider_effective_from IS NULL OR provider_effective_from <= at) AND (provider_effective_to IS NULL OR at < provider_effective_to)`；任一 provider bound 可独立为 NULL，两个均存在时仍受既有 ordering constraint。

feature-config pointer 只能指向 `canary|active` policy，不再接受仅 `validated` policy；pointer trigger 按 target status 调用同名 phase。policy transition 的 DB-owner defense-in-depth 必须验证 transition 后的 `NEW` facts；若 public assert 按 ID 读取 committed row，则使用 AFTER/constraint trigger 或等价 private row validator，不能在 BEFORE trigger 中误读 OLD row。所有 phase 只接受已经 sealed 的 price；validator/reserve 不 seal。private price validation/sealing helper 只能由 DB-013 audited activation wrapper 和 DB-012 owner-only historical primitive 调用；不得授予 seed、reserve、service-role direct caller。CFG-000 的 legal-bundle seal 是独立 authority，不属于 price helper。

audited operator RPC 落地后，`service_role` 失去 routing-policy/provider-profile/price/legal lifecycle 与 feature-config pointer 的直接 `UPDATE` 权；只获得 pinned `search_path` 的 `SECURITY DEFINER` operator function `EXECUTE`，每次必须带 actor、reason 与 evidence hashes。所有多对象 lifecycle 操作统一锁序：

```text
ai_feature_config
-> routing policies by UUID
-> runtime contracts by ASCII ID
-> profile versions by UUID
-> price versions by UUID
-> audit insert
```

validation、new-policy authoring、canary/active/retired transition、pointer activation/rollback、current policy retirement、profile retirement、price closure、activation/legacy seal 都遵守该顺序。runtime registration不属于 DB-013 lifecycle：它只能在新的 owner-only CFG migration中 author新 target/root/membership并同事务seal，不读取或反向锁 config。sealed runtime root/target/membership不可更新或删除。component-authoring transaction 只能锁自己的 draft price，必须先提交，之后不得反向取得 config lock。pointer activation 在改 pointer 前按序锁定 exact policy/runtime/所有 target、验证并 seal prices、再次校验 policy；legacy price 只由 owner-only primitive seal。current policy retirement、profile retirement、price closure 或其他 target eligibility mutation 必须在同一锁序事务中枚举并锁定 current pointer；若变化会使 current policy 在其 `canary|active` phase 立即失效，操作必须拒绝，或先原子切换/清除 pointer 并对 replacement 按 phase 完整复验，绝不能提交一个指向 retired/失效 policy、runtime contract 或 target 的 current pointer。DB-007/DB-013 tests必须双向调度 reserve与pointer activation、profile retirement、price closure，证明统一的 config→policy→runtime→profile→price 顺序无死锁且 snapshot不混合。

外部 price evidence refresh 不修改 immutable price row。operator 在激活审计写入 `rechecked_at/rechecked_sha256` 并与 immutable source facts 对比；facts 有实质变化时只能创建新 price 与 policy version。active-pointer audit 还记录 reviewed runtime-contract ID/hash，runtime 在 transmission 前再次对照 code-owned registry；mismatch 无 fallback，并走 no-transmission settlement。

实现 ownership 与 migration integration 顺序固定为：

```text
CTRL-008 reviewed fingerprint/display/phase contract
-> RT-002B pure V2 provider-subject derivation contract/helper/tests
-> LEGAL-002A reviewed semantic descriptors/constants/vectors
-> DB-003A price-lane/provenance/legal/ledger shape
-> DB-003B global immutable manifest catalog + child composite FK
-> CFG-000 initial sealed legal bundle
-> DB-007 runtime catalog foundation + strict validator/reserve + private price validation/sealing helper
-> DB-009/010 attempt lifecycle + RT-009/API-001/API-002 transmission/availability gate
-> LEGAL-003 exact-bundle acceptance wiring + UX-002 availability state
-> UX-003 actual-recipient/annex read-only disclosure
-> UX-004 expectedRoute submission + route/bundle reconfirmation
-> RT-009A reviewed service runtime contract/evidence
-> CFG-001 runtime-contract registration + DeepSeek profile/current prices/draft policy
-> DB-012 owner-only historical primitive + legacy price/backfill
-> DB-013 audited lifecycle/activation wrappers reusing DB-007 helper
```

RT-002B 只新增纯 `provider-subject-v2` message/HMAC helper、contract fixture 与 executable vectors，不接 handler/DB/network；LEGAL-002A 的 DeepSeek derivation implementation/test evidence 必须引用其 reviewed Git blobs，不能引用尚未实现的计划。其他 operational service facts 的 implementation/test closure 由实现完成后的 RT-009A runtime contract承担；其中 actual recipient disclosure/acceptance/reconfirmation 必须先由 LEGAL-003 与 UX-002/003/004 提供 reviewed implementation/test blobs，不写进预实现 legal fingerprint。migration filenames/order exact 为：DB-003A `20260823232000_add_ai_price_lanes_legal_seals.sql`；DB-003B `20260823232400_add_ai_legal_manifest_catalog.sql`；CFG-000 `20260823232500_seed_ai_legal_bundle.sql`；DB-007 `20260823233000_expand_ai_routing_runtime_contract.sql` + `20260823234000_reserve_ai_polish_v2.sql`；既有 DB-008 `20260823234500_add_ai_provider_attempt_ledger.sql`；DB-009 `20260823235000_start_ai_polish_provider_attempt.sql`；DB-010 `20260824000000_complete_ai_polish_provider_attempt.sql`；DB-011 `20260824001000_secure_reconcile_ai_provider_attempts.sql`；CFG-001 `20260824002000_seed_deepseek_v2_draft.sql`；DB-012 `20260824003000_backfill_deepseek_legacy_pricing.sql`；DB-013 `20260824004000_add_ai_provider_operator_lifecycle.sql`。DB-007只创建空 runtime catalogs/membership/binding与 helper，不注册 contract、不 seed、不切 pointer；CFG-001 migration owner注册并 seal initial RT-009A DeepSeek-only target/root/membership后 seed绑定它的 draft policy；后续 registration必须各自由新的 owner-only CFG migration复制 reviewed constants；DB-012独占 legacy row/backfill；DB-013无 registration authority，不拥有或重建 legacy primitive，也不重新选择 policy runtime pair。

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

### CFG-003 daily routing candidates

`polish.deepseek-mimo.daily.g4.v1` and its explicit
`polish.deepseek-only.daily.rollback.v1` successor are immutable draft
candidates. Their only official windows are Asia/Shanghai daily `[1,2,3,4,5,6,7]`
half-open `09:00-12:00` and `14:00-18:00`; the historical weekday-only G2
policy is not a safe rollback. The G4 windows select the MiMo V2 profile and
its draft, unsealed price, while the successor selects DeepSeek peak pricing.
Neither candidate supplies a fallback, current/latest lookup, activation, or
pointer write. Validation/canary/active still require the normal sealed prices
and promoted profiles, so this dark seed is not activation authorization.

DB、runtime 与 API tests 必须共同覆盖：

1. reserve 返回完整一致的 `route_snapshot_v1`，旧字段仍存在。
2. policy 切换只影响新 reservation；retry snapshot 不变。
3. cache-write `null + unavailable` 往返 DB/TS 后不变成 0。
4. reported 四桶与 unavailable 三桶两套 usage conservation。
5. reasoning 作为 output 明细不重复计价。
6. `attempt_v2` finalize 不能与 legacy `p_usage` 双写。
7. availability → POST 五字段 expectation匹配成功；generation/profile/legal/runtime ID/runtime hash任一变化均在 transmission 前返回 `AI_ROUTE_CHANGED`。
   enabled=false时两个runtime字段与其他route fields同为NULL；missing/malformed、runtime ID-only/hash-only、runtime-policy switch均走同一409且不做quota/rate/ledger mutation。仅 routing policy version 变化时也必须递增 `configGeneration`，并触发同一路径。
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
21. runtime membership 的 contract hash NULL不能绕过root composite FK；membership insert/update/delete与seal共用exact parent `FOR UPDATE`，mutation-first/seal-first两种调度均保持sealed target set不变。
