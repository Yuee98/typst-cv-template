# AI provider attempt settlement contract

> 状态：revision 1；语义来源 CTRL-009 revision 5（独立 review CLOSED）；等待本 tracked relocation 的 exact-head material-equivalence review  
> 日期：2026-08-24  
> 适用基线：DB-008A 及后续 attempt lifecycle；DB-010/DB-011/RT-009 必须遵循本文  
> Governance：本文是内部技术契约，不属于 legal bundle `2026-08-23-multi-provider-v1` 的 evidence graph

## 0. 与 frozen provider contract 的关系

`docs/ai-provider-contract.md` 是当前 legal bundle 的 repo-path evidence，冻结字节为 85,222 bytes、SHA-256 `f2cf21f68a93451ea157a954ec57a8872cf1220d28bc013fa2dbc1b6b3ebcccd`。在不轮换 manifest、bundle、terms 与 runtime pair 的情况下，内部实现细节不得再次写入该 evidence 文件。

本文是其 §4、§5.5、§5.6 的 attempt/request settlement 技术补充。若两者在 attempt source selection、聚合、成本 reconciliation、daily ledger、checked arithmetic 或锁序细节上存在差异，后续 DB-010、DB-011 与 RT-009 以本文为准；provider、recipient、submitted data、subject、region/transfer、cache/retention/training、terms acceptance、route disclosure 与用户显示等 legal/user-facing facts 仍只由 frozen provider contract、legal descriptors 与 terms authority 管理。

本文不得加入当前 legal evidence graph。只有 material legal/user-facing fact 变化才允许在独立 governance gate 中创建新 manifest IDs、bundle version/root、terms acceptance version 与 runtime pair；不能通过改写旧 hash 或旧 immutable ID 更新历史 bundle。

## 1. 目的与边界

本文只冻结 `attempt_v2` 的 request-level usage/cost 聚合与 finalize 事实源。它解决四个已由 RT-008 事实模型暴露、但现有 request ledger CHECK 尚不能表达的边界：

1. 一个 attempt 报告 cache-write，另一个 attempt 的 cache-write unavailable；
2. provider 传输前终止、`provider_billable=false`、usage/cost 均不可得，但这不是“未知成本”；
3. 两个 attempts 的 provider-reported cost 全有、全无或部分缺失时如何形成 request-level reconciliation；
4. 零 attempt 与已有 attempt 时，legacy payload 和 `attempt_v2` 哪个是唯一事实源。

它不改变 per-attempt `NormalizedUsageV2` 守恒、不放宽逐 attempt cost truth table、不改 V1 reserve/mark RPC、不新增 HTTP/public error code、不选择 provider、不激活 route，也不允许 CNY/USD 相加。DB-010 实现前，本 tracked 文件必须通过独立 exact-head material-equivalence review；若 reviewer 要求更改 normative semantics，先修订本文并重新 review。不得把纯内部 settlement 语义同步回 frozen legal evidence 文件。

## 2. 唯一事实源与零-attempt 规则

`finalize_ai_polish_request(...)` 保持现有六参数签名，不创建 overload。`p_metadata.usage_schema_version` 是 caller source selector，不直接写入同名 request 列，只接受：

- 缺失或 `legacy_v1`：只保留给真正的 V1 request（`route_schema_version IS NULL`）以及下述 V2 pre-start release；
- `attempt_v2`：`p_usage` 必须为 SQL/JSON null，DB 在同一事务内只从该 reservation 的 terminal attempt rows 聚合；
- 其他值：fail closed，不尝试猜测。

执行顺序先冻结 idempotent readback，再解析 unfinished request：

```text
request FOR UPDATE
-> NOT_FOUND
-> state='finalized' 时立即返回现有 exact alreadyFinalized readback
-> 只有 unfinished request 才解析/拒绝 status、usage、metadata/source、billability assertion
-> attempts ORDER BY attempt_no FOR UPDATE
-> aggregate/daily mutation
```

因此 finalized 后以 legacy/unknown selector、非空 usage、scalar metadata 或冲突 billability 重放，仍返回同一 `alreadyFinalized:true`，不触碰 attempts/daily，也不因新 V2 校验改变历史幂等语义。

对 unfinished V2/source 路径，输入 shape 机械 canonicalize：

- `p_usage` absent 当且仅当 `p_usage IS NULL OR p_usage = 'null'::jsonb`；`{}`、`[]`、string、number、boolean 都不是 absent 并在不匹配 source 时拒绝；
- `p_metadata` 可为 SQL/JSON null 或 JSON object；array/scalar拒绝。selector 缺失或 JSON null 等于 legacy selector；存在时必须是 exact string `legacy_v1|attempt_v2`；
- 真正 unfinished V1 request（route schema NULL、legacy selector）保留现有参数解析/coercion与返回行为；上述 strict shape只施加于 unfinished V2、存在 child attempt 或显式 `attempt_v2` selector，不以 DB-010 顺便改变 malformed legacy caller；
- 所有 shape/source/lifecycle rejection 发生在 request/daily mutation 前。内部→public category必须穷尽：caller/input contract faults（`NOT_FOUND`、invalid status、malformed/unknown/ambiguous/wrong source、no attempts、clean V2 zero-child tuple 的 caller字段不匹配、caller billability mismatch）映射 `INTERNAL_ERROR`；locked-ledger/lifecycle/invariant faults（`ATTEMPT_IN_PROGRESS`、attempt-count/row-set/frozen snapshot/price/currency漂移、V1-mark contamination、impossible explicit-false nonzero/异币种 report、mixed currency、任一 checked arithmetic/counter overflow）映射 `SERVICE_UNAVAILABLE`；finalized永远走成功 idempotent readback。内部细分 reason只用于安全日志/测试，不进入 HTTP vocabulary。

精确约束：

1. `attempt_v2` + 非空 `p_usage` 返回既有契约原因 `AMBIGUOUS_USAGE_SOURCE`，且不写 request/daily aggregate；
2. `attempt_v2` + 零 child attempts 返回内部 lifecycle failure `NO_PROVIDER_ATTEMPTS`，且不结算、不退款、不制造零 usage；
3. 任一 child attempt 存在时，缺失/`legacy_v1` source 返回 `ATTEMPT_USAGE_SOURCE_REQUIRED`，阻止绕过 immutable attempt facts；
4. 任一 attempt 仍为 `started` 时返回 `ATTEMPT_IN_PROGRESS`；
5. DB-009 成功 start 后 request 的 `attempt_count` 必须等于 child row 数且 attempt_no 集合为无重复的 `{1}` 或 `{1,2}`；finalize 在 request lock 与 attempts lock 内重验，不一致返回 `SERVICE_UNAVAILABLE`；
6. `route_schema_version='route_snapshot_v1'` 且零 child row 时，只允许 exact pre-start release tuple：request `state='reserved'`、`attempt_count=0`、`provider_started_at IS NULL`，caller selector缺失/`legacy_v1`，`p_status='released'`、`p_quota_charged=false`、`p_provider_billable=false`、`p_usage` absent；其他 status/usage/billable/quota/state 一律 fail closed；
7. 上述规则同时阻止误用现有 V1 mark 污染 V2 row：`state='provider_started'`、非零 attempt_count 或 non-NULL provider_started_at 的 V2 zero-child request 不能 legacy finalize；
8. 真正 V1 request（`route_schema_version IS NULL`）继续保持 legacy behavior；`legacy_pricing_v1` 只用于 DB-012 已 finalized 历史读回，不能成为新的首次 settlement source；
9. 一旦第一个 attempt row 存在，所有成功、失败、取消与 reconciler settlement 都必须走 `attempt_v2`；
10. fresh `attempt_v2` finalize 固定持久化 `usage_schema_version='request_usage_aggregate_v2'`、`cost_basis='frozen_price_version_v1'` 和 locked attempts 的唯一 native `billing_currency`；selector literal `attempt_v2` 不得写入 request schema column；
11. `p_provider_billable` 在 `attempt_v2` 只作为 assertion：必须 `IS NOT DISTINCT FROM` §3 从 locked attempts 推导的 request billability，mismatch 在任何 mutation 前拒绝；request 只能持久化 derived value。V1沿用现有行为，zero-child release继续强制 caller false；
12. 已 finalized request 继续沿用现有 idempotent readback，不能因 caller 随后换 source selector而二次结算；首次 finalize 的持久化 tuple永久证明实际 source。

锁序保持：`request FOR UPDATE -> attempts ORDER BY attempt_no FOR UPDATE -> daily/request aggregates -> global/config rows`。source/zero/in-progress 检查都发生在任何 request/daily aggregate mutation 前。

## 3. Request usage 聚合

只聚合同一 reservation、已 terminal 且按 `attempt_no` 锁定的 rows。

### 3.1 Core buckets

- `input_total_tokens`、`input_cache_read_tokens`、`input_standard_tokens`、`output_tokens`：对 `usage_observation_kind='observed'` attempts 的已知值求和；`unavailable` attempt 不贡献伪造的零。
- request `usage_complete=true` 当且仅当每个 admitted terminal attempt 都是 `usage_observation_kind='observed'` 且自身 `usage_complete=true`；任一 unavailable 或 observed-but-incomplete attempt 都令 request false并加入 `attempt_usage`，同时保留其他已知 core bucket lower bound。
- `input_cache_write_tokens` 仅当所有 attempts 都有 observed numeric value时求和；否则为 NULL并加入 `input_cache_write`。
- `reasoning_tokens` 同理；它只是 output 明细，不额外加入 output total。
- `provider_billable`：任一 attempt true -> true；所有 attempts false -> false；其余 -> NULL，并仅在 NULL 时加入 `provider_billable` marker。

所有 bigint 加法必须逐步防 overflow；overflow/invariant violation fail closed，不能 clamp、wrap 或提交 partial settlement。

### 3.2 Legacy token compatibility projection

`attempt_v2` 在写 V2 request aggregate 的同一次 settlement 中，还必须一次性投影既有 request/user/global token columns，维持旧报表总量守恒：

```text
legacy input_cached_tokens   = input_cache_read_tokens
legacy input_uncached_tokens = input_total_tokens - input_cache_read_tokens
legacy output_tokens         = output_tokens
```

`input_uncached_tokens` 明确包含已进入 `input_total` 的 cache-write；不能用 `input_standard_tokens`，也不能随后再次额外加 cache-write。request row、`ai_usage_daily`、`ai_global_usage_daily` 使用同一组 checked bigint值且各只结算一次。`input_total < input_cache_read` 或 subtraction/addition overflow是 invariant failure。

### 3.3 Cache conservation

Per-attempt CHECK 保持严格且不修改：

```text
reported:       input_total = cache_read + cache_write + standard
unavailable:    input_total = cache_read + standard, cache_write = NULL
not_applicable: input_total = standard, cache_read = 0, cache_write = 0
```

Request-level `cache_usage_reporting` 由 aggregate 决定：

- 所有 attempts 的 cache-write 都 numeric，且至少一个为 `reported`：`reported`；要求 `input_total = cache_read + cache_write + standard`；
- 所有 attempts 都为 `not_applicable`：`not_applicable`；要求 `cache_read=0`、`cache_write=0`、`input_total=standard`；
- 其他任一 missing/unavailable 混合：`unavailable`；要求 `cache_write IS NULL` 且 `input_total >= cache_read + standard`。

最后一条的差值正是其他 attempts 已进入 `input_total`、但 request 因任一未知 bucket 而不能发布的已知 cache-write lower bound。现有 request CHECK 的等号必须只在 request aggregate 分支改为 `>=`；per-attempt 等号不变。

## 4. Local estimated cost 与 incomplete marker

DB 聚合必须与 RT-008 `aggregatePolishAttemptFactsV2` 同义：

- `known_estimated_cost_nanos` 累加所有 non-NULL attempt estimated cost；金额必须同 request frozen `billing_currency`；无已知值时为 NULL，而不是 0；
- 若任一 `provider_billable IS DISTINCT FROM false` attempt 的 estimated cost 为 NULL，则 `estimated_cost_nanos=NULL` 且加入 `estimated_cost` marker；
- 否则 `estimated_cost_nanos IS NOT DISTINCT FROM known_estimated_cost_nanos`。这包含全部 non-transmitted/non-billable attempts 导致两者都为 NULL 的合法“完整无成本”状态；它不得被标成 unknown estimate；
- marker present 强制 `estimated_cost_nanos IS NULL`，但允许 `known_estimated_cost_nanos` 保留其他 attempts 的已知 lower bound；
- marker absent 强制 `estimated_cost_nanos IS NOT DISTINCT FROM known_estimated_cost_nanos`，不能只比较 non-NULL 情形。

因此 request-level incomplete consistency CHECK 从

```text
(estimated_cost_nanos IS NULL) = has_marker('estimated_cost')
```

替换为

```text
(has_marker('estimated_cost') AND estimated_cost_nanos IS NULL)
OR
(NOT has_marker('estimated_cost')
 AND estimated_cost_nanos IS NOT DISTINCT FROM known_estimated_cost_nanos)
```

所有 `attempt_v2` request 的 `billing_currency` 都必须是 locked attempts 唯一、non-NULL 的 frozen price currency，并与 parent `price_version_id` 精确一致；即使 known/estimated/provider-reported 三种金额均 NULL 也不能丢失 native currency。该 currency 同时是 profile-daily `(day, profile_version_id, billing_currency)` 聚合键。

## 5. Provider-reported cost 聚合与 reconciliation

### 5.1 Applicability 与安全聚合

一个 terminal attempt 仅当 `provider_billable IS DISTINCT FROM false` 时属于 provider-cost-applicable。explicit-false attempt：

- provider-reported cost 只允许 NULL，或与 frozen currency 相同且 amount精确为 0；
- 非零 amount 或异币种是 invariant failure；
- 精确 0 保留在 immutable attempt row，但不进入 request provider-reported sum；
- 若 request 没有 applicable attempt，request provider-reported amount为 NULL、status为 `not_available`。

对 applicable attempts：

- 只有每一个 applicable attempt 都有 provider-reported amount 时才求和；
- 任一 applicable amount 缺失时，request `provider_reported_currency/cost_nanos` 两者都为 NULL；不得保存 partial sum；
- 所有 reported currencies 必须等于 request frozen billing currency；否则 invariant failure；
- 加法逐步检查 PostgreSQL bigint overflow。

### 5.2 Request-level precedence

先计算 local estimate completeness，再计算 provider-report coverage。request `cost_reconciliation_status` 唯一按以下优先级决定：

| Priority | 条件 | request provider-reported cost | status |
|---|---|---|---|
| 1 | `estimated_cost` marker present | all applicable reported 时保存完整 sum，否则 NULL | `incomplete_usage` |
| 2 | applicable attempts 数为 0 | NULL | `not_available` |
| 3 | all applicable reported | 完整 sum | 与完整 `estimated_cost_nanos` 相等为 `matched`，否则 `mismatch` |
| 4 | 部分 applicable attempts reported | NULL | `pending` |
| 5 | none reported | NULL | `not_available` |

`pending` 只表示“部分 applicable attempts 已有 amount，部分缺失”的机械 aggregate，不接受 caller/per-attempt string 选择。初版 complete RPC 必须从 canonical amount/estimate 推导每个 attempt 的 reconciliation：estimated NULL -> `incomplete_usage`；estimated non-NULL + reported NULL -> `not_available`；两者 non-NULL则按相等/不等推导 `matched|mismatch`。caller 提交的 status 如存在必须与推导值完全相等，否则拒绝；初版 complete 不产生 per-attempt `pending`。未来确需异步账单时新增版本化 `provider_report_observation_kind`，不能复用自由字符串。DB-011 不补造 provider amount。

Request CHECK truth table 必须允许：

- `not_available` + `provider_billable=false` + known/estimated/provider-reported amounts全 NULL + 无 `estimated_cost` marker；
- `not_available|pending` + 完整 non-NULL local estimate + provider-reported NULL；
- `matched|mismatch` + 完整 non-NULL local estimate + 完整 non-NULL provider-reported amount；
- `incomplete_usage` + local estimate NULL + `estimated_cost` marker；若 all applicable reports完整，可保留完整 provider-reported sum，否则为 NULL。

它必须拒绝：partial provider-reported sum、matched/mismatch 缺任一金额、matched 金额不等、mismatch 金额相等、`incomplete_usage` 无 marker、marker present却 local estimated non-NULL、跨币种或 overflow。

## 6. DB-010 实现边界

DB-010 可以在其新 migration 内 replace `finalize_ai_polish_request(...)` 并替换 request ledger 的相关 CHECK；不能回改已发布 migration。exact changes 仅限：

1. request aggregate cache `unavailable` conservation 从 `=` 改为 `>=`；
2. request incomplete/cost truth table按 §4/§5 修改；per-attempt bucket conservation保持，DB-010 complete/aggregate额外拒绝 explicit-false nonzero reported amount并推导 reconciliation；
3. 新 `attempt_v2` 聚合/结算路径与 §2 source guard；
4. `ai_profile_usage_daily` additive 增加 nonnegative `provider_report_incomplete_count`；daily nullable `provider_reported_cost_nanos` 在尚无任何完整 request amount时保持 NULL，首个完整 amount后以 `coalesce(existing,0)+amount` 保存所有完整 request-level amounts 的 known lower-bound sum（完整 amount=0 也持久化 0）；只有 request存在 applicable provider cost但没有完整 request amount时 counter +1；explicit-false/no-applicable request不增加，local estimate incomplete但完整 provider amount仍贡献 amount且不增加该 counter；request 与 daily只各结算一次；
5. profile-daily optional buckets使用 exact-or-NULL sticky aggregate：`input_cache_write_tokens`/`reasoning_tokens` 在 existing daily 值或本 request值任一为 NULL时结果保持 NULL，否则 checked sum；不能把缺失 coalesce为0；
6. profile-daily local cost completeness只由 request `estimated_cost` marker/counter决定，不能由 nullable request amount猜测：缺失 daily row 的完整 identity 为 `known_estimated_cost_nanos=0, estimated_cost_nanos=0, cost_incomplete_count=0`；每个 request 的 known contribution是 `coalesce(request.known_estimated_cost_nanos,0)`；仅 marker存在时 counter +1。计算 checked `new_known=old_known+contribution`、`new_count=old_count+marker` 后，`new_count=0`时 `estimated_cost_nanos=new_known`（所以 complete-null nonbillable request贡献 exact 0），否则 estimated为/保持NULL。CHECK使用 total NULL-safe predicate：`(cost_incomplete_count=0 AND estimated_cost_nanos IS NOT DISTINCT FROM known_estimated_cost_nanos) OR (cost_incomplete_count>0 AND estimated_cost_nanos IS NULL)`；
7. legacy V1 path output/behavior byte-compatible，除“已有 child attempt 必须改用 attempt_v2”的 fail-closed guard；replace后函数仍精确保持现有六参数类型/顺序/default、`returns jsonb`、`SECURITY INVOKER`、`set search_path=''`且没有 overload。真正 route-schema-NULL V1继续信任并持久化现有 `p_metadata.attempt_count`行为；
8. direct attempt DML grants仍由 DB-011 单独收紧，DB-010不抢占 `provider-attempt-schema.test.ts` 的 fixture conversion ownership；
9. request token/cost、quota refund、user/global/profile daily的每一次 bigint/integer addition/subtraction都checked；任一 overflow/invariant exception必须回滚整个 finalize statement/transaction，使 request、quota及所有 daily rows保持调用前状态，retry/duplicate不能留下 partial increment。

DB-010 不从 caller 接收 attempt aggregate；在 `attempt_v2` 与 V2 zero-child release路径不信任 `p_metadata.attempt_count` 覆盖 DB count；不读取 latest price/profile/policy，不重算 routing snapshot，不更新 attempt facts。真正 V1 metadata compatibility按 item 7保留。

## 7. 必需测试矩阵

DB-010 exact-head 至少覆盖：

1. one reported-write attempt + one unavailable-write attempt：request total保留全部 total，write NULL，conservation `>=`；
2. all reported、all not-applicable、all unavailable 三个守恒分支；
3. one observed + one usage unavailable：known lower bounds保留，usage incomplete；
4. observed-but-`usage_complete=false`：core lower bounds保留、request complete=false、`attempt_usage` marker存在；
5. pre-transmission canceled/timed-out attempt：billable false、usage unavailable、known/estimated均NULL、无 estimated marker、status not_available；
6. derived billability true/false/NULL exact assertion；caller mismatch拒绝且不能覆盖 request；
7. known attempt cost + unknown billable attempt cost：known lower bound保留，estimated NULL + marker；
8. provider cost all reported matched、all reported mismatch、partial reported pending、none reported not_available；caller explicit pending/mismatched reconciliation拒绝；
9. local incomplete + all provider costs reported：保留完整 provider sum但 status incomplete_usage；
10. explicit-false reported NULL/zero允许且不参与 request sum，explicit-false nonzero拒绝；mixed currency、bigint boundary/overflow、partial currency/amount pairs；
11. zero-attempt attempt_v2、attempt存在但legacy source、attempt_v2+caller usage、started attempt、attempt_count/row-set drift；V2 zero-child只允许 exact released/refund tuple，V1-mark-contaminated/succeeded/arbitrary legacy usage均拒绝；
12. sequential/concurrent duplicate finalize只结算一次；complete-vs-finalize race不丢 late fact；
13. finalized后用 legacy/unknown selector、nonempty usage、scalar metadata、conflicting billability重放仍 exact idempotent readback且daily不变；
14. released/refund before first attempt仍走 legacy-null；first attempt后所有 terminal outcome走 attempt_v2；
15. SQL NULL/JSON null接受，V2 `{}`/array/scalar拒绝；canonical V1 payload regression；fresh attempt_v2 exact持久化 schema/cost-basis/native-currency tuple；
16. mixed reported/unavailable request对legacy columns投影为 cached=read、uncached=total-read，request/user/global totals相等且write不双计；
17. profile-daily cache-write/reasoning exact-or-NULL sticky；daily local cost transition覆盖 complete-null→known、known→complete-null、incomplete→known及duplicate；direct CHECK cases拒绝 count0+estimatedNULL、接受 count0+estimated=known、接受 count>0+estimatedNULL、拒绝 count>0+estimated non-NULL；provider-report lower-bound sum/counter覆盖 complete、partial、not-available-applicable、explicit-false/no-applicable；
18. exact穷尽的内部→public reason map；request/daily bigint与counter overflow整笔回滚；existing legacy request fixtures、六参/default/SECURITY INVOKER/search_path/no-overload、historical CNY migration与 V1 finalize metadata regression全绿。

## 8. Review gate

独立 reviewer 必须逐项确认：

- 本文 §2–§7 与 CTRL-009 revision 5 语义等价；
- CTRL-009 在 former tracked delta 中新增的 normative settlement 规则均被本文无损承接；
- RT-008 runtime output可无损映射；
- SQL 三值逻辑没有 NULL bypass；
- request 与 attempt 守恒边界没有互相放宽；
- provider cost precedence无 partial sum；
- zero-attempt不制造 usage；
- existing finalize idempotence/lock order不倒退；
- `docs/ai-provider-contract.md` 已恢复 frozen bytes，本文未进入 current legal evidence graph。

Exact-head material-equivalence CLOSED 后才允许：

1. 在 execution ledger 记录本文件 exact commit/hash 与 frozen evidence恢复证明，不再把内部 settlement 内容同步回旧 evidence 文件；
2. 更新 execution plan/ledger 的 DB-010 frozen input；
3. 从 DB-009 reviewed integration exact head派发独占 DB-010 worker。
