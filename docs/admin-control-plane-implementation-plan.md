# Admin Control Plane Implementation Plan

本计划把已经收敛的 [总体方案](admin-control-plane-plan.md) 拆成可独立审查、验证和部署的工作包。代码基线为 `main` / `2783057292cef4ba3889d6bded31ce7863b2270f`，总体方案 SHA-256 为 `149d6ed6d826a0c3cb90e055907900a4632286b3d22edbf9a05e486cd3068167`。本次产物是实施计划，不执行实现、数据库迁移、真实 Provider 调用或线上发布。

## 1. 交付范围与完成定义

在现有 `web` 内交付 `/zh/admin`、`/en/admin` 与 `/api/admin/...`，沿用 Next.js、Vercel、Supabase Auth 和当前数据库。管理员通过独立 AdminShell 管理 Users、Providers、Profiles、Pricing、Routing Policies、Runtime Controls，并查看 Overview、Analytics 和统一 Audit。

第一版保留中英和主题切换；单一 `admin` 权限；首位管理员由 DB operator 手工绑定已有 Auth 用户；后续授权由 Users 页面完成。Endpoint、密钥环境变量名、model ID 使用文本输入；adapter 使用 migration 维护的目录和当前部署支持集合的交集。真实 key 只存在部署 secret store，API key 不能进入数据库、审计或浏览器。

实现完成要求同时满足：旧 v1 请求及重试继续可执行；新的兼容 model 能通过受控配置和证据接入；Admin 写入口不能被旧 operator RPC 或直接 DML 绕过；配置、价格、路由各自不可变版本；发布使用 gate-off → pointer/readback → 独立 reopen；静态站点没有 Admin 产物；分析只暴露批准的元数据。

不包括独立 Admin 部署、通用 SQL/表 CRUD、通用兼容网关、自定义域名任意外呼、多角色系统、账号删除/冒用/批量导出、AI 用户白名单编辑、逐用户配额管理、行为漏斗数据仓库、百分比灰度，也不增加 `execution_sha256`、`destination_policy_id`、`credential_generation` 或可变工作区草稿表。Web synthetic probe 是独立可后置的工作包，不阻塞合格 operator evidence 支持的发布。

## 2. 实施顺序与依赖

工作包编号仅用于本计划，不冒用现有 CFG/RT/DB issue 身份。每个工作包是审查边界，实施时可按 DB、runtime、UI 的依赖拆成少量聚焦提交；不强制一个工作包等于一个巨大 PR。

| 工作包 | 主要交付 | 依赖 | 可见结果 |
| --- | --- | --- | --- |
| ADM-I01 | 契约、权限/锁矩阵、测试 fixtures | 当前 main | 后续实现有确定接口和迁移顺序 |
| ADM-I02 | 身份 DB、只读 RPC、Admin 构建入口和 Shell | I01 | 只读后台、手工首位管理员 |
| ADM-I03 | Provider/adapter 目录与连接 v2 schema | I01 | additive DB，旧路由不变 |
| ADM-I04 | v1/v2 runtime、动态模型与受限外呼 | I03 | 同一部署可执行两种配置 |
| ADM-I05 | 数据绑定 runtime/legal evidence 与前端披露/consent | I03、I04 | 新配置不被前端常量卡住 |
| ADM-I06 | Admin JWT 写内核、TOTP、幂等、报告 producer | I02、I05 | 写能力仍关闭，权限链可验证 |
| ADM-I07 | 控制操作 RPC、gate/readback/reopen、权限切换 | I06 | 新控制面取代旧 service_role operator 路径 |
| ADM-I08 | Users 授权与配置创建/验证页面 | I07 | 用户管理与 Provider/Profile/Price/Policy 分别管理 |
| ADM-I09 | Analytics 与通用审计查询/展示 | I02；关联新事件需 I06 | 有界的元数据分析和审计 |
| ADM-I10 | 发布、回退和运行控制 UI | I07、I08 | 完整可操作控制面 |
| ADM-I11 | 可选 synthetic probe 全链路 | I04、I05、I06、I08、I09 的 probe 投影 | 受配额和结算约束的付费测试 |
| ADM-I12 | Preview 验收、部署切换与运维交接 | I08、I09、I10 | 可上线且能恢复的第一版 |

建议主线：I01 → I02 → I03 → I04 → I05 → I06 → I07 → I08 → I10 → I12。I09 可以从 I02 后独立推进，先交付现有数据分析；I11 可在 I12 后交付。实施者可在不交叉修改共享契约的情况下并行独立工作，但本计划不要求多代理执行。

**三个可验收里程碑**：M1=I02，只读后台；M2=I03–I08，DB 配置及受控创建；M3=I09、I10、I12，分析与运营上线。I11 单独验收，不让支付/未知发送恢复扩大首个 Admin UI 的阻塞面。

权限切换是关键顺序修正：可以先部署 dark RPC 和 UI，但在 I07 原子撤销旧入口并核实替代操作链之前，不开放任何 Admin 业务写操作。I07 提前实现控制 RPC 和可用 operator 入口；I10 后补完整 UI，避免先撤销现有运维能力、随后等待发布页开发。此顺序实现总体方案“首个写功能开放前收口权限”的要求。

## 3. I01：冻结可执行契约

新建 `docs/ai-provider-contract-v2.md`、`docs/ai-runtime-execution-contract-v2.md` 和 `docs/admin-api-contract.md`，为新语义赋予独立schema/revision和固定向量。`docs/ai-provider-contract.md` 是冻结的service/legal evidence blob，保持原字节；原 `docs/ai-runtime-execution-contract.md` 的revision 1也保持内容和语义不变。不得重签旧source hash、descriptor、target或fixture来使新实现通过。先列每项字段的 producer、DB 表/RPC、读取者、信任来源和失败行为，再实施 schema。继续保留总体方案中的用户决策。

I01另起 `docs/admin-operations-draft.md`，显式标明未来流程、尚未生效；当前 `docs/ai-provider-operations.md` 仍描述有效DB013流程。I07在实际cutover就绪时才更新运维入口和适用mode说明，不能在尚未部署时把新流程写成当前事实。

必须交付以下确定契约：

1. `profile_execution_config_v1 | profile_execution_config_v2` 判别联合。v2 增加明确 schema version、canonical `endpoint_url`、`credential_env_name`；旧 aliases 只用于 v1，新版本不得混用或在错误 v2 时 fallback。现有 `config_sha256` 仍只表示 canonical adapter config；不偷换旧 hash 的范围。
2. DB 不可变 profile/price/policy 和 evidence ID 的关系；Provider 可变 defaults 仅供创建时复制；price version 仍属于精确 profile version。相同金额也不能把旧 price ID 重新绑定到新 profile。
3. Adapter catalog 仅登记实现标识、显示名、wire API 和弃用信息；能力/config schema、request builder、usage parser、calculator 由代码批准。新 model 的同协议支持验收必须覆盖请求、输出、usage、计费与披露，不能只验证字符串格式。
4. 管理 API 的 DTO、错误码、分页、expected revision/generation、reason、idempotency key；所有高风险动作的 step-up、证据、锁顺序和 readback 要求。禁止 raw actor UUID、审核 hash 或 `reauthenticated=true` 成为写权威。
5. 迁移清单分为 expand、dark implementation、authority cutover、环境激活和将来 contract，分别定义兼容窗口和回退点。不预先占用真实 migration 时间戳。
6. 保留单一current legal bundle：future候选可针对明确待切换bundle验证，但不能获得实时执行资格；current切换在DB gate关闭时受控进行，并准备同一新bundle下的前向及回退候选。I05给出完整状态机，不放宽为任意sealed bundle都可运行。

I01 同时提供 TS/SQL 共用的独立 fixtures：旧 DeepSeek/MiMo v1、新 v2 等价配置、一个现有 adapter 能支持的合成 model ID、错误 wire/schema/价格归属、字段不同但 config hash 相同的两份 profile、陈旧 generation、UTC 与上海周边界路由。合成模型只进入本地测试，不据此登记真实平台能力。

同步mutation的规范顺序为：验证当前project/environment与actor → 取得统一成员串行化锁并锁定/重新验证actor当前membership和账户状态 → 锁定/查询operation key → 已提交则比较DB canonical payload，相同返回原结果、不同拒绝 → **仅在未命中分支**锁定target/control/candidate、检查近期step-up及expected revision/state/报告 → 业务变更、audit与committed operation同事务提交。target membership、pointer、quota、retired状态、旧报告有效期不能在已提交结果查找之前造成业务拒绝；幂等重放本身不重新执行动作，不因原TOTP证据过期而失去已提交结果。当前actor已撤权、账户失效或环境不符仍拒绝读取结果。

全局成员锁在前是为了序列化last-admin/撤权，不等于先验证目标业务状态。未命中分支的AI锁序与现有config→policy→runtime→profiles-by-UUID→prices-by-UUID→quota/ledger兼容；成员操作锁定目标前不反向取得AI锁。用交错事务证明last-admin、pointer/reopen、quota与in-flight retirement的结果。网络请求在事务外，实际新发布前重新校验证据绑定。

I01 验收不是“文档写完”：每个新 RPC 能指出确切授权角色、输入来源、锁对象、原子写入和返回证据；每种旧路径有继续使用或撤销安排；没有将关键 authority 留给“稍后 UI 检查”的空项。

## 4. I02：只读 Admin 基础

### 4.1 数据与身份

新增 migration：`admin_principals`（user_id、enabled/revoked 信息、revision）、管理事件基础表及环境身份/控制迁移状态单例。开启 RLS，撤销 anon/authenticated/service_role 直接表 DML；只读通过窄 SECURITY DEFINER RPC，固定安全 `search_path` 并显式 grant。环境标识由 DB operator 初始化，Supabase project、deployment environment 不匹配时拒绝管理请求。

首位管理员：提供事务 SQL 模板，检查操作者为 DB owner、目标 Auth UUID 存在且可用、当前没有 active admin，写 membership 与 `db_operator` 来源审计。无 Web bootstrap、无 service_role bootstrap RPC、无“第一个登录者自动升级”。恢复也是显式 DB operator 程序，不开放远程后门。管理员引用不能因账户删除级联清空最后一名；在受保护成员行/删除边界定义一致检查，保留操作者历史，不把审计 actor 外键设为 cascade 删除。

有效管理员 = 当前 active membership + 当前 Auth 账户未删除/禁用且具备登录资格。DB helper 通过 owner 权限读取最小 Auth 状态；不信任 `user_metadata` 或旧页面缓存。撤权和业务变更在同一锁协议下序列化。后台只读登录使用现有 Supabase password/GitHub session。

新增 `web/src/server/admin/auth.ts`、`request-client.ts`、`environment.ts`、`read-models.ts`。API 每次 `auth.getUser(token)` 验证，并创建**同一 Bearer JWT**的 request-scoped RPC client；不能以为 `getUser(token)` 自动给另一个 client 设置了 session，也不能修改全局 service_role client 的 Authorization。查询 RPC 同样检查 `auth.uid()` 和有效 membership，直接调用 RPC 不能绕过授权。

Users 列表由批准的 DB 查询投影 Auth UUID、必要 email、加入时间与管理员状态；限定搜索/分页，不把 Auth 管理 API 的完整响应传给客户端。账号删除、密码修改、冒用和批量导出没有入口。

### 4.2 Web 与构建

新增 `web/src/features/admin/` 页面与 AdminShell；`web/src/lib/admin/` 仅存可进入浏览器的类型/校验；服务端模块在 `web/src/server/admin/`，显式 server-only 边界。第一批只读 Overview、Users、配置列表/详情、Audit；没有数据/尚未开放的功能不显示占位链接。

扩展 `web/scripts/run-next-mode.mjs` 的显式生成清单，创建 Admin layout/page/API 薄包装。每个包装具有 sentinel；静态模式逐个删除自己生成的文件，只移除空目录，拒绝覆盖/删除未知手写文件。路由实现与消息不放在静态 App Router 树中。生成文件纳入合适 ignore 和类型检查流程。

AdminShell 独立侧栏/面包屑/环境徽标，复用 root theme/font、QueryProvider 与共享 UI。Admin locale messages 独立动态入口；不塞进公共 `messages.ts` 的全量静态导入。验证 locale layout 的 `dynamicParams` 与动态实体详情路由，实际构建和访问 `/zh/admin/profiles/<uuid>`，不能只验证首页。

把根布局中的 Vercel Analytics/SpeedInsights 移至明确的公共页面边界，验证公共页面→Admin→公共页面的客户端导航不会发送 Admin 路径、查询、表单或数据。不是仅从 Admin HTML 隐藏组件；要证明已加载 tracker 的导航监听也排除了 Admin。若 SDK 无法可靠隔离，实施时用跨边界完整导航/独立公共入口卸载实现，禁止以隐藏路由名代替隔离。

语言切换保持子页面和允许的 query，离开未保存表单时提示；主题切换不重建表单。两级菜单：Overview / Users / AI 管理（Providers、Profiles、Pricing、Routing Policies、Runtime Controls）/ Analytics（Usage、Costs、Performance）/ Audit。

验收：匿名/普通用户/伪造 metadata/错误环境/撤权后旧 token 均不能读 Admin 数据；服务端响应 `no-store`，不共享用户缓存；中文/英文、主题、路由选中和动态详情可用；server → static → server 在**同一工作区**构建通过且静态产物无 Admin route、消息、客户端模块和服务器 secret。不运行 Provider 调用。

## 5. I03：Provider/adapter 目录和 v2 扩展

新增 `ai_adapter_catalog`，使用稳定 text ID，migration 登记当前 `deepseek_chat_v1`、`mimo_responses_v1`；将 profile `adapter_kind` 关联目录。FK 先以 NOT VALID 约束新写，盘点既有行后单独 VALIDATE；未知历史项不能被自动登记成受支持实现。增量部署遵守目录与运行时代码交集；数据库登记不是实现授权。弃用项不供新建选择，但历史合法版本继续执行，不能删除仍被引用的 ID。

新增独立 Provider 目录：稳定 identity（接收方/operator/gateway 归属）、可改 display/default connection 字段、revision。Provider defaults 是管理便利，不是真实执行记录或 legal 事实。无法原地改变既有 Provider 的法律接收方身份；该变化创建 successor identity。目录的 enabled/archived 状态只影响新建选择，不隐式停掉已冻结请求。

在 `ai_provider_profile_versions` 增加 schema version 与 nullable v2 字段，兼容旧行；CHECK 约束严格区分两类。旧 aliases 当前 NOT NULL，必须改为分支约束：v1 必填旧 aliases 且无 v2 连接字段；v2 必填新连接字段且不使用 aliases。扩展 immutable trigger，禁止后来补填/修改已创建版本的执行字段。新 v2 使用新版本 ID；禁止通过 UPDATE 旧 active 版本做“回填”。Provider identity FK 在旧 identity 上允许空，仅精确映射已知记录；v2 新建必须关联 Provider，未知旧行不能猜测接收方。

`ai_provider_attempt_ledger` 也显式增加执行 schema 分支与 v2 endpoint/env 字段，按现有冻结模式复制并与 profile version 精确比较。同步调整旧 alias NOT NULL/CHECK、insert/start、snapshot/immutability trigger、complete 的 alias 派生逻辑、usage/observation 校验和 approved projection。先扩展可表示的结构，再让 producer 输出 v2；不能出现 profile 是 v2、attempt 只能表达 v1 的中间启用状态。保留产品 request FK 和旧 v1 行值，不修改历史 attempt。

先创建目录和 identity 的初始事实；旧 v1 registry 保留。v2 successor seed/创建放在双读部署之后。seed 不变更 active pointer、DB gate、allowlist 或配额，不重写 request/attempt snapshot；旧 price/legal/source hash 保持原意。新 connection namespace 的 key 在部署配置中另行登记，不读出旧 key 做比较。

验收：完整旧 migrations → additive migrations、全新 reset 两条路径均可；升级路径装载已有用户、active v1 pointer、开启的DB gate、旧bundle consent、历史profile/已结算request、未完成request和合法待重试attempt，再升级、继续执行/结算。单纯expand不能切换current bundle或让原路由失效。现有 CFG001/002/003 frozen seed 测试保持真实历史含义；所有旧 v1 snapshot 可解析；未知 adapter 无法获得执行能力；同一 Provider defaults 修改后旧 profile 不变；错误 v2 无法插入或被明确拒绝，不转成 v1。

## 6. I04：从冻结 v2 配置执行

主要修改 `adapter-registry.ts`、`profile-registry.ts`、`lifecycle-v2.ts`、`lifecycle-v2-contract.ts`、`deepseek.ts`、`mimo.ts`、`handler-runtime-authority.ts` 和对应 usage/cost/model-observation 模块；添加独立的 v2 解析/endpoint/secret resolver 模块。旧 v1 分支与已审核描述保留，不放宽旧 guard。

新 resolver 输入 DB reservation 冻结的完整 v2 配置和当前代码支持的能力；根据 adapter ID 选择实现，将该配置真正传入 builder、transport、usage parser 和 calculator。修复 DeepSeek body 中固定 model 常量及构造函数闭包固定 profile 的限制，不能只在入口接受 model 字符串。重试只使用原 snapshot，不重新读 Provider defaults 或 active pointer；不跨 Provider fallback。

Secret resolver 只构造 `AI_PROVIDER_KEY_*` map，名称满足严格规则、存在且用途匹配。部署配置另有非敏感 binding manifest：env name → 精确 recipient/origin 与规则 revision。它不能由 Admin 表单写成任意目标；真实 key 不出现在日志、hash、DTO、审计或检测输出中。Preview/Production 同名 ref 可各用自己的 secret；缺失/用途不符时零外呼。Resolver 最终产生只在内存使用的 prepared transport config；adapter 消费已验证 endpoint/key/model/config，不自行选择 profile、读取 env 或寻找默认 URL。v1 wrapper 也可适配此接口，但其批准映射保持原义。

Endpoint 经统一 canonicalization：HTTPS、无 userinfo/query/fragment、无 IP literal、无非批准端口、无域名后缀混淆；精确 origin 与部署批准用途及 legal recipient 相符；path 符合 adapter/wire 语义；TLS 校验开启，`redirect: "error"`。DB 做基础约束，runtime 每次外呼前做全部安全检查。第一版仅批准现有官方目标；新增官方目标通过 operator 证据与部署 manifest 登记。任意自定义 DNS/兼容代理在连接级 DNS/egress 防护完成前拒绝，不用一次 DNS lookup 冒充防 rebinding。

修改 reservation SQL 构造 v1/v2 正确快照；start/complete/finalize/reconcile 对两种快照的合法性、价格和 frozen identity 保持一致。能力范围内不同 modelID 以模拟 transport 证明 raw model 字符串抵达请求，响应和 usage/价格仍按已支持 semantics 解析。

验收：v1 regression；v2 字段变动独立 fixtures；DB/代码 schema mismatch、支持集漂移和恶意 URL/credential 都在 fetch 前拒绝；无 key/CV 日志；旧在途请求跨部署继续；新 v2 有效但未激活时不改变真实路由。所有 transport 测试使用本地受控替身，不发送付费请求。

## 7. I05：runtime/legal 证据与用户披露闭环

当前 `service-runtime-contract-v1.ts`、legal fingerprint descriptors、`lifecycle-availability.ts`、`terms-acceptance.ts`、`polish-provider-annex.ts` 和 `use-polish-flow.ts` 都包含精确 profile/model/bundle 映射。此包是配置化接入的必要部分，不应遗漏成后续“UI 优化”。

引入 successor runtime contract schema：**代码批准 adapter/capability/语义**，不可变 DB target 绑定具体 profile endpoint/model/recipient/price/legal。新 code evidence 可覆盖其明确支持的参数化能力；operator 登记的外部证据负责具体模型、价格与接收方事实。新 target 必须逐字段与 profile 精确一致；不接受仅凭 adapter 相同就沿用旧 target。旧 v1 descriptors/hash 和历史 target 不重写。

为 legal/display 增加严格 schema 的不可变、经 operator 批准的数据描述（可扩展现有 legal catalog，避免平行重复 authority）：版本 ID、common-terms template ID、已审核的 provider/recipient/model labels、zh/en 披露 blocks、对应 fact/evidence IDs、内容 digest 和 seal。只允许代码支持的文本/列表/批准链接结构，不接受 raw HTML、脚本、任意外部内容抓取；Admin UI 只读和选择，不提供法律声明或审核 hash 编辑器。

用户 AI availability 返回批准的公开 disclosure DTO 和精确 legal bundle identity；按版本取得同一份已封存披露，渲染 common template + approved annex，acceptance 绑定实际显示的版本及 digest/对应 sealed identity。新 bundle 只能由经审核的 evidence 导入产生，不将任意数据库字符串当成合法条款。支持模板内的新 model/target 不需要再写前端 switch；改变共同条款语义或未知 renderer schema 仍需代码发布和新 consent。

保留当前静态 `/ai-terms` 和 v1 已审核文本；新动态 bundle 通过 server-only 生成入口按 ID 提供批准内容，使用站内固定路由与编码 ID，不拼接 DB 给出的任意 URL。静态站点没有 AI 执行入口，也不假装展示它无法读取的新运行时 bundle。历史条款必须按历史内容读取，不能被 Provider 默认值覆盖。

更新 pending acceptance、availability→确认→reserve 链：保留 expectedUserId/RLS 防账号切换；由 DB 验证 bundle 已封存、displayable、目标精确绑定，实际 reservation 要求该冻结 bundle 的有效接受记录。Availability 后 route/bundle 改变时刷新并重新确认，不能把 A bundle 的同意用于 B。不能仅删除 `parseKnownAiLegalBundleVersion` 的验证。旧 consent 路径与旧请求保持兼容。

信任 producer 分工：受信 migration/DB operator 可导入已审核 build/source/runtime/legal/external evidence；运行 validation service 只能引用这些权威并记录真实检查结果，无权创作已审核来源。字段、producer grant、对应验证失败在 I01 契约落定，I05 实现数据结构和导入/读取工具。

**单current legal bundle的切换契约**：`current_ai_terms_version()` 继续代表该DB唯一current值。将其底层常量演进为受保护的current identity记录，初值严格保持旧bundle；普通Admin与service_role都不能直接写此记录或替换函数。current变更由经审核的DB-owner operator操作完成，UI只显示待处理步骤；不新增法律编辑后台。

先部署旧/新schema双读renderer、availability和acceptance，再导入并封存新bundle、runtime targets及前向/回退policy候选。未来bundle候选的创建/静态validation使用明确的candidate-purpose校验：完整校验其指定sealed bundle与target，却不要求它已经current；报告标记“候选就绪，尚不可运行”。实发reserve、active pointer、reopen仍要求policy bundle=current。现有validator的current检查不能无差别移除，create/validate与live admission必须具有不同、显式调用入口。

切换前准备**新bundle下可执行的rollback tuple**：若已有profile/price在新runtime contract与bundle中确有完整覆盖，可创建引用它们的新policy；否则创建等价v2 profile successor与归属它的新price/runtime target，再建rollback policy。默认采用后者以避免扩宽旧v1 exact-target resolver。不得只给旧policy改bundle，也不能假定“相同Provider”就具有新runtime/legal覆盖。新bundle要明确覆盖前向与回退的实际披露。

在gate-off窗口，DB-owner操作锁`ai_feature_config`及legal current记录，检查expected旧bundle/control revision和两组候选证据，先通过owner-only内部路径清空旧pointer（若存在），再切换current并递增control revision、写source明确的audit；同事务提交，避免新current与旧pointer形成可运行中间态。随后新current下重新取得发布所需report，激活前向/回退候选，设置目标pointer、生成绑定current bundle的readback，再由Admin独立reopen。任何失败保持gate off。DB事务只检查已登记事实，不能假称已替用户显示/同意条款。

切换后只有精确新bundle consent能用于新reservation；未同意的用户必须先看到并接受新内容。尚未刷新且不能渲染新schema的旧浏览器收到明确刷新/重新确认状态，不能默默接受。原旧bundle policy保留历史，不再列为实时rollback候选；将current退回旧bundle本身属于另一项需重新审查的operator迁移，不是常规rollback。

旧reservation/已发送attempt仍按其冻结bundle和历史接受事实处理，不因current切换改写或重新绑定；gate关闭时新发送受现有start gate约束，已有传输仍可结算。重开后允许的旧在途/重试继续依其已冻结authority，不能重新走“新reservation必须current”的谓词来追溯否定；各旧安全/时限/retirement约束照常成立。I05/I12测试覆盖current切换与在途snapshot/start/finalize/reconcile交错。

验收：独立本地 fixture 用已有 adapter、不同 modelID 和新 sealed bundle 完成 availability、双语显示、精确 consent、reserve、模拟 attempt/settlement，**无需增加模型/披露常量**；缺任一 evidence、仅有旧 bundle consent、伪造 digest、未知 renderer、账号切换都拒绝；历史 fingerprint 和 terms 测试不被删掉或改成 permissive 断言。

## 8. I06：Admin 写内核和可信报告

### 8.1 身份与 step-up

统一应用写链：Bearer → API `getUser` → 同用户 JWT RPC client → 外层 SECURITY DEFINER RPC → `auth.uid()`/JWT role/current membership/account 检查 → 状态/证据检查 → owner-only 内部函数 → 原子业务变更、audit、committed operation。外层 RPC granted to authenticated，但每次完整鉴权；service_role 的无用户 JWT 不具有 admin actor。所有实现 helpers 撤销 PUBLIC 默认 execute。

应用 UI 使用 API，但不以“必须来自某个 Web 页面/自定义 header”作为 DB 权威。直接 RPC 的有效 admin JWT 若满足全部同等条件，可执行相同操作；这与总体方案的直接 RPC 威胁模型一致。JWT 的 project issuer 结合该 DB 的唯一 environment identity 隔离 Preview/Production（两环境禁止共用 project）；它不证明调用来自哪台 Vercel instance。对 build/env 的断言只来自 DB 登记的 deployment manifest 和受信 producer report，普通用户不能自行声称新的 build。首版不增加 server-held deployment secret/header；若未来要求限制某个具体前端来源，属于额外能力边界，需要单独设计，不能把客户端 Origin 当凭据。

近期重认证采用 Supabase TOTP：Admin 安全设置支持现有用户 enroll/challenge/verify，兼容 password 和 GitHub 登录，不假设 GitHub OAuth redirect 会强制重新认证。高风险动作要求 Supabase 验证过的 JWT `aal2`、该 session 的近期 MFA `amr` timestamp（初值 10 分钟）、有效 verified factor/current session，并结合 action/候选/环境的确认请求。DB 验证签名后 claims 的内容和时间，不能只看 JWT `iat` 或 API Boolean；刷新旧 token 不刷新 MFA 时间。I06 用本地真实 Auth 验证重复 challenge 是否产生预期近期证据，未知 claims 一律阻塞高风险动作。

TOTP 只要求管理员高风险操作，不强迫普通 CV 用户启用。QR/seed 是本人 enrollment 临时材料，禁止日志/截图/数据库留存；不属于 Provider 配置。Factor 丢失通过另一个管理员或显式 DB operator 恢复，不能有绕过 step-up 的普通“重新开启”按钮。来源：[Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa)、[TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp)、[JWT claims](https://supabase.com/docs/guides/auth/jwt-fields)。本地当前 Auth 版本的 claims/撤因子/注销语义是上线前实证门槛。

| 操作类型 | 当前 Admin | 近期 TOTP | AI deployment gate / DB AI gate |
| --- | --- | --- | --- |
| 管理读取、统计、审计、静态 validation | 必须 | 不要求 | 都可关闭 |
| 保存 Provider defaults、创建不可变版本 | 必须 | 不要求 | 都可关闭；要求 Admin writes 已切换 |
| grant/revoke admin、seal/activate/retire、pointer/rollback、quota 增改、reopen | 必须 | 必须 | pointer 必须 DB gate off；reopen 单独满足运行就绪 |
| 紧急 disable | 必须 | 不要求 | 可关闭或异常；只能 true→false/维持 false |
| paid synthetic probe | 必须 | 必须 | deployment AI gate 与 DB gate 必须开启；另有 probe admission |

Admin 身份检查独立于 AI feature flag，关闭 AI 不会失去观察或停用能力。普通 Auth 可用性异常时由明确 DB-owner emergency disable 处理，不伪造在线 admin 身份。

### 8.2 幂等与管理事件

新增 committed-operation 表，唯一 `(actor, operation_kind, idempotency_key)`，记录 canonical payload hash、committed result、domain audit ID。Hash 由 DB 外层 RPC 按 typed 参数构造，不接受客户端提交的 hash 作为比较权威。与业务变更在同一 DB transaction 写入。校验当前权限/环境在先；命中已有 committed result 在target/control状态、expected revision、报告或原step-up时效比较之前。已登记同 key+同 payload 返回原结果；不同 payload 拒绝；并发同 key 序列化。只有未命中新动作才要求完整近期step-up/业务就绪检查。回滚事务没有 durable pending/failed，允许未提交 key 再执行。

浏览器保留原 key/payload 直到确认结果；编辑字段产生新 key；超时显示结果未知并查询/重放原 key，不宣称“失败”。查询无记录不证明未执行。普通 mutation 不创建通用异步 command queue。Committed keys 随 audit 保留，不用短 TTL 重新执行历史动作。Audit 公共字段和领域变更允许列表由业务定义，不写 raw HTTP payload。

### 8.3 Producer 权限与环境更新

最小可部署 grant 方案：`record_admin_validation_report_v1` 等窄 RPC **仅 grant service_role**，revoke anon/authenticated；报告表无直接 DML。service_role 在这里是受信同部署运行时 producer，属于数据库可区分的角色，不是依靠 TypeScript import 约定。它不能调用用户 Admin mutation 冒充 actor，也不能通过这些 RPC登记 reviewed source/legal authority。无需新增服务、数据库登录 secret 或万能签名机制。

DB owner/migration 专有 evidence importer 登记已审查来源、允许的 deployment/build 和非敏感 secret/origin binding manifest revision；应用 service_role 无 execute。当前部署验证服务读取实际编译能力/环境用途后记录 immutable report，绑定 candidate IDs、environment、registered build、runtime/legal、pointer/control revision（仅相关项）、binding manifest revision、checks、时效及 evidence IDs。失败报告也是明确的检查结果；不得由 Admin 提供 `passed=true`、source hash 或自由证据 JSON。

实现 `web/src/server/admin/validation-service.ts`、report/evidence DTO 和批准导入 CLI。API 接受 candidate ID；producer 自己装载 DB 候选/部署状态并检查，paid 检查单独走 I11。DB record RPC验证 producer、registered evidence/状态/绑定和唯一报告，不假称 DB 直接读取了 env。发布 RPC只接受 report ID，从 DB 读取已有审核 hashes。

部署 manifest/revision 变更协议：先登记新 reviewed build/非敏感用途 revision，在 gate off 期间部署；旧报告因 DB current revision 改变不再可发布。运行实例必须将自身内置 build+配置 revision 与登记的允许集合精确比较，不匹配时拒绝新 v2 外呼和生产报告。仅仅在 Vercel 改 env 不自动成为受信变更；key 值轮换无需保存 hash，但用途/目标变更必须更新 revision 并重验证。v1/v2 混部切换前确认所有可接收新路由流量的 build 已批准双读。Report/readback保存实际验证的binding manifest revision；v2 attempt start的受信执行上下文也记录该非敏感revision与build作为诊断事实，不作为新profile字段或密钥代次。

验收：authenticated 不能制造报告；producer 不能制造 code/legal 审核权威、不能以无用户 JWT 管理用户；未知 build/revision、过期/错候选报告、伪造 actor/TOTP/readback 均拒绝；服务角色合法 reserve/start/complete/reconcile 仍可执行。I06 的管理写 RPC/UI 保持 dark，未绕过 I07 权限切换。

## 9. I07：控制操作和权限切换

在旧生命周期函数外实现有业务含义的 JWT RPC（命名在 I01 固定）：membership change、Provider defaults update、profile/price/policy create、静态 validation 请求/引用、seal/transition/retire、pointer set/clear、disable/reopen、global daily calls limit。既有 lifecycle 内部算法可复用；actor/hash 等从可信上下文/记录得出，不由客户端填写。函数部署后以 DB control-plane mode 保持 dark。

控制状态新增独立 revision/closing cycle，保留原 `config_generation` 表示 pointer 代际，不把旧 generation 解释成覆盖所有 controls。Pointer set/clear/rollback 必须锁 control row，在 DB AI gate off 时执行，比较 expected pointer/generation，验证新候选及精确报告，记录审计。canary 仅生命周期资格，没有隐式流量比例。

关闭 → 切换 → readback → 再开启跨多个明确动作：readback 在 AI off 时从 DB approved projection 读 audit/operation/generation/policy/effective route，受信 runtime producer核实当前 build/manifest后生成绑定 closing cycle、current legal bundle与当前 pointer 的不可变 readback report。Reopen 作为独立高风险 RPC，锁 control row并校验最新 closing cycle、pointer/control revision、current bundle、报告时效和运行就绪；旧页面和旧报告不能打开新关闭周期。需要legal current迁移时先完成I05的gate-off operator步骤，再取得新current的report/readback。陈旧数据或部分失败保持关闭，不承诺零停机切换。Disable 不声称能撤销已发请求。

**权限cutover分为三个门槛**，不声称DB事务能证明外部部署已完成：

1. 事务外就绪：对精确build完成server-mode Admin smoke、真实本地JWT/TOTP mutation/readback、operator CLI恢复演练和data-plane v1/v2回归。在目标环境以允许的无付费验证核对实际接流量build、Auth/DTO/证据读取及operator可用性；登记有来源的就绪报告。所有可能接流量的build和选定回退build均支持新Admin契约；dark模式本身不能用于宣称已在目标库执行业务写动作，本地等价环境的写证明与目标环境的连接/身份证明分别记录。
2. DB cutover单独migration/事务：只验证DB可证明的schema、函数签名、grants、registered build/report、current control mode及expected revision；revoke旧DB013 operator RPC的service_role EXECUTE和 **`public.ai_feature_config`** 三列`ai_polish_enabled`、`global_daily_limit`、`enabled_user_allowlist`的直接UPDATE；将mode切向新JWT内核。任一条件不符整体回滚。保留reserve/start/complete/finalize/reconcile必需权限及security-invoker行锁必需且由trigger保护的窄列权限。
3. cutover后立即核对实际服务build上的JWT操作/result/audit/readback与data-plane，并保持平台的回退下限：只有同时支持I04/I05的v1/v2执行/披露和I07的JWT/TOTP/report/readback契约的build可重新接流量。禁止普通平台回退到pre-cutover build；在Vercel可回退目标与运维权限中执行这项约束，不能仅写在DB允许列表。故障先保持AI gate关闭，使用新operator工具或DB-owner单向停用，再forward-fix；不重新grant旧旁路作为普通回退。

在cutover生效时更新 `docs/ai-provider-operations.md` 与CLI，并写明适用DB control-plane mode及最低build；I01未来draft此时才成为当前操作指南。常规operator使用同一用户JWT/TOTP/evidence-ID流程（CLI不落盘/打印token），或明确使用DB owner审计事务；旧service-role流程保留为历史说明而不作为当前可执行示例。DB owner应急停用是单向路径，能写DB时留下operator audit；DB故障等无法落库时记录真实外部操作证据，不伪造audit UUID。恢复必须回到就绪验证。

验收直接访问矩阵：旧每个 RPC、直接 control DML、内部 helper、报告 importer、外层 user JWT RPC分别测试 anon/authenticated/nonadmin/admin/service_role/db_owner。复用真实旧 control 和 data-plane 调用确认无旁路/无断流。并发 last-admin、revoked actor、pointer与reserve、disable与reopen、旧 readback 与新 closing cycle 测试通过后才开首个写入口。

## 10. I08：Users 与独立配置页面

Users 支持搜索、分页、详情、grant/revoke admin 和相同事件审计；高风险确认显示目标身份，使用近期 TOTP、reason、expected revision、稳定 idempotency key。最后管理员保护由 DB 锁保证，UI 提示只是体验。AI allowlist 可显示现有状态，但无编辑入口；不混同管理员身份。

Providers 是单独页面：显示 recipient/gateway 身份、连接 defaults、关联 Profiles 和 Audit；编辑可变默认值采用 expected revision。Profiles 列出 identity 与版本，详情有执行配置、readiness、使用它的价格/路由、操作历史。adapter select 获取 DB∩runtime 支持项；endpoint/env/model 用文本输入，错误具体显示到字段，secret 仅显示 configured/missing/blocked。

表单在点击“创建版本”之前自由编辑；提交只创建一个不可变 draft。编辑已存版本执行 clone successor；普通“保存”不会改变 active 版本。Provider defaults 在创建时复制并在确认区展示最终值。Profile、Price、Routing 页面独立导航，使用依赖链接帮助补齐阻塞项，不做强制大向导。

Price 页管理币种、components、有效期、证据引用和 seal readiness；Routing 页管理 default/time-window rules、policy versions、引用的 profile/price 和 simulator。Simulator 使用生产同一纯 selector 和 TS/SQL fixtures，显式时间/时区，返回匹配与可执行资格两层结果，不外呼、不改 pointer、不预测未来 secret/价格永远有效。

Validation 按候选 ID 调用可信 server 检查，显示阻塞项和报告引用；创建 draft 的正确性不依赖 paid probe。该 UI 不编辑 source/legal hash，不把一次静态通过显示为“已通过真实模型测试”。创建失败保留表单；结果未知保留 key并恢复，不重复创建。

验收：端到端创建 Provider default → profile successor → 对应 price → policy，各自版本/审计可读；任何编辑不影响旧 active/in-flight；缺依赖给出精确阻塞；并发 defaults/version编辑、重复提交、响应丢失恢复不产生重复版本；导航/locale切换保护草稿。

## 11. I09：Analytics 与 Audit

新增 `server/admin/analytics/` 查询层及 SQL 聚合/批准投影，复用 `ai-metrics.mjs`、`observability.ts` 的口径与纯逻辑，不将 observability DTO 当成已建事件仓库。默认近7天、单次最多31天，DB聚合、keyset分页/有界诊断、查询超时和索引基于实际访问路径；不用全表拉回浏览器算图。

Usage：request/attempt 数与终态、重试、Provider份额、token/cache。Costs：按币种展示已知费用、estimated/provider reported口径与完整度，不把 request与attempt费用相加。Performance：可观测延迟P50/P95、失败类别、settlement异常；不宣称评估正文质量。Quota卡片将 `global_daily_limit` 标为次/日。未有完整数据源的拒绝漏斗、留存/转化暂不加页面。

为每指标定义数据源、时间字段、过滤/分母、null处理、时区及迟到settlement。请求与attempt成功率独立；unknown usage/transmission不算零或已发送；跨币种不相加。保留现有retention：finalized_at超过90日的request及cascade attempts、UTC日汇总90日、minute buckets2日；未结算走reconcile；Audit无自动TTL。查询返回范围与数据完整性说明，不能把清理缺口填零。

统一 Audit API 合并现有 lifecycle audit 和新增管理事件的**批准投影**，携带 schema/event type/source ID/operation ID；同一操作不重复计数。全局页和对象页共用过滤器、分页和详情抽屉。公共字段固定，少量字段diff/角色diff/price表/routingdiff渲染；未知事件只显示安全公共字段，不raw JSON dump。不为读取恢复 service_role 全表权限。

诊断只提供 request ID元数据时间线；没有CV/prompt/output/email/rawProviderID/body/secret。Endpoint及credential名称只在配置及对应配置审计中展示。日志同样采用content-free DTO。

验收用固定DB数据集，覆盖跨日/上海窗口、双币种、未知usage、retry成功、迟到settlement、retention缺口、同operation审计归并和翻页稳定性；每个图与独立期望计算一致；SQL返回行数/时间有界。无需建立一套永久分析仓库。

## 12. I10：发布与运行 UI

在I07已验证的RPC上添加canary/active/retire、price seal、policy activation、pointer选择/清空/rollback和Runtime Controls页面。发布前展示确切profile/price/policy/runtime/legal/report与环境，输入目标key确认、reason和TOTP。对象页面与Overview紧急停用复用同一API。

Pointer操作强制明确的分步流程：关闭DB AI → 选择合格policy并提交 → 读取审计/有效路由 → 单独确认开启。界面不会将HTTP200当完成；以committed operation、audit和最新状态核实。所有中途失败保持停用，清楚显示当前状态和恢复步骤；未知结果查询原operation。回退列表只包含匹配current bundle及当前runtime/价格/evidence的policy。发生bundle迁移时展示I05准备的新bundle rollback successor；旧bundle policy只标为历史，不因曾经active就显示“可回退”。Legal current迁移由operator执行，Admin页面清楚显示此阻塞步骤及完成后的readback状态。

“canary”旁解释当前流量由policy和allowlist决定；如果覆盖全部合格请求就如实显示。DB gate关闭时Overview/Audit/simulator仍可读取，关闭不清理或改写in-flight账本。Quota使用次/日；白名单编辑后置。

验收通过Admin真实用户JWT的完整UI流程、DB直接RPC绕过测试、双页面陈旧状态与跨请求失败恢复；各操作显示可核对的audit/operation ID。不以Web probe是否上线代替实际候选所需兼容/集成证据。

## 13. I11：可选付费 synthetic probe

这是独立父记录/attempt状态机，不向产品request FK塞假数据。表冻结actor、candidate profile/price/runtime/legal、environment/build/binding revision、固定fixture版本、idempotency与额度。只接受代码固定合成内容，无自由prompt或用户简历。

先由JWT Admin RPC进行durable reservation与候选准入；候选可尚未active，但必须有probe用途兼容/价格/接收方证据。然后受信worker通过窄start RPC争取单次send permit，只有赢家外呼。过程不跨事务持锁；permit消费后崩溃/丢响应可能unknown，不自动重发、不Provider fallback、不声称外部exactly-once。

与产品共用全局调用额度计数及锁，将实际额度 claim/refund 逻辑提取为 owner-only 内部函数，产品/probe 的对应路径都调用它，不能只是两个页面读取同一个 limit。增加独立admin/probe限额和token/time上限；不消耗用户个人配额。只有明确未发送路径可按已定义规则释放预留，发送未知保守保留并reconcile，不按本地超时直接refund。结算幂等，provider usage未知不补零；费用进入总成本但产品用户成功率和请求量排除probe。

新增probe查询/projection、stale reconciliation、终态finalized_at90天清理和运行工具；未结算不先清除。Web报告只能引用终态probe事实，记录结果及证据充分性，不用一个绿色测试覆盖法律/代码审核。

验收在本地可控transport注入start前/后crash、取消/超时、响应丢失、完成重试、同时产品与probe争抢最后quota、retention与reconcile交错；同probe不二次fetch，quota不超发，成本不遗漏也不双计。只有这些投影、恢复与quota证明一起完成才开启Probe按钮。任何真实付费运行按具体环境和用途另行授权。

## 14. 测试与CI交付

| 边界 | 实际位置/门槛 | 何时必需 |
| --- | --- | --- |
| Pure/schema/transport | `web/src/**/*.test.ts(x)`、`web/scripts/**/*.test.mjs`，Vitest | 对应工作包 |
| DB权限/并发/升级 | `web/test/db/**/*.test.ts`，本地Supabase，`DB_TESTS_REQUIRED=1` | I02起所有DB变更 |
| 冻结旧seed | CFG001/002/003 fresh-reset runners与原有fixtures | schema/runtime/evidence变更 |
| Server/static边界 | 原build/smoke加同工作区三次切换、manifest/bundle扫描 | I02、I05及路由变更 |
| Admin Auth UI | 新独立本地Supabase Admin Playwright配置/launcher | I06–I10 |
| 产品回归 | 当前Playwright local workflow与AI本地集成fixtures | Auth/terms/layout/runtime变更 |
| Hosted Preview | 精确部署/DB/project/secret用途身份、获授权smoke | I12，仅环境授权后 |

当前 `run-e2e-server.mjs` **构建 server mode**，使用fake后台/LLM并清空Supabase配置；它验证本地编辑流程，不能证明真实Admin JWT/TOTP/DB权限。新增Admin E2E launcher只接受loopback Supabase、合成测试账户与本地TOTP，通过实际Auth签发token，禁止生产auth bypass；不要把普通fake-composition接到真实计费后台。清空所有旧DS/MiMo和新增 `AI_PROVIDER_KEY_*`/用途配置，隔绝 `.env.local` 与继承环境的外呼secret。截图与日志不存JWT/TOTP seed。

新DB suites按领域组织：admin-access、admin-membership-concurrency、admin-producer-grants、admin-operation-idempotency、admin-control-cycle、profile-execution-v2-upgrade、legal-display-consent-v2、admin-analytics-projection、probe-lifecycle-quota。复用共享helpers；不并行重置同一个DB。幂等套件覆盖提交后HTTP丢失→target后来修改/删除/retire、报告/TOTP过期、pointer/current改变，原key仍返回原结果；actor撤权则拒绝。Legal套件覆盖future候选不能实发、gate-on不能切current、clear/current事务失败回滚、new-bundle rollback、旧consent无权新reserve及旧在途结算。MFA E2E对含seed/QR/JWT的trace/video也关闭或脱敏清理，不仅控制截图和日志。重点验证真实权限/交错事务/输入输出事实，不写只复述实现的快照测试。

更新 `.github/workflows/db-tests.yml` 的paths与job，包含admin/schema/runtime/evidence/legal相关路径，避免Admin SQL变更未运行DB套件；保留现有fresh gates。更新 `.github/workflows/ci.yml` 和server/static artifact checks；新增构建切换门槛测试同一checkout的过渡状态，不能只依赖两个隔离CI job。

基础命令沿用：`pnpm --dir web lint`、`pnpm --dir web typecheck`、`pnpm --dir web test`、`pnpm --dir web test:db`（环境设置 `DB_TESTS_REQUIRED=1`）、`pnpm --dir web build:server`、`pnpm --dir web build:static`、`pnpm --dir web test:e2e`。为新增门槛补充 `test:e2e:admin`、`test:admin-build-modes` 和必要fresh-v2脚本，实际名称在对应提交固定。集成脚本可能真实付费，不能当普通测试命令自动运行。

每个工作包只运行受影响的必要验证；涉及grant/不可变snapshot/静态导出的完整性变更执行相应整套gate。最终I12汇总精确head的CI与人工/环境验收，不重复无风险的全套测试来代替结论。

## 15. I12：Preview交付、切换与恢复

本计划编写时仅核实本地main定义；用户已说明双Provider在Preview运行，不把它等同于验证过线上cron、secret或当前部署身份。

1. 本地/CI完成所有第一版工作包。在read-only阶段即可部署M1；首位Admin由用户/DB operator按事务模板建立。记录代码head、migration集合及目标project/environment。
2. additive schema先行且保持旧current bundle、旧v1继续运行；双读runtime及新legal/consent前端后行。验证兼容部署集合；新namespace密钥由部署侧登记，工具仅报告状态。尚未双读的旧部署不能承接v2流量。
3. 按I07先完成事务外精确build/CLI就绪证明，登记目标环境的连接/身份事实，再执行只校验DB事实的独立authority-cutover事务及提交后验证。首次Web write只在cutover验证后开放；事务失败保留旧mode，提交后故障遵守新authority回退下限，不能声称任何失败都会恢复旧模式。
4. 创建DeepSeek/MiMo的v2 successor与新price/runtime/legal/policy记录；future bundle下同时准备前向和rollback successor，必要时为旧路由语义创建等价v2 profile/price。使用fixtures与报告逐字段比较预期目的地，不同时发送两份用户请求。记录reference IDs，不改旧版本。
5. 在本地等价环境先完成新bundle下terms、quota、reserve、模拟attempt、settlement与readback全链路；目标Preview在gate关闭或future bundle尚未current时只做许可范围内的读取/renderer/证据/binding检查，不声称执行过被gate禁止的reserve。必要的真实兼容性证据与后续端到端付费smoke各自明确来源；申请时提交可审阅配置、调用上限与环境身份。不能以旧Preview成功复用为新版本证据。
6. 用Admin关闭gate；若更换legal bundle，由DB operator按I05完成clear-pointer/current identity与control revision的原子切换，再为新current取得报告、激活前向/回退候选、set pointer/readback/reopen。首次reopen使用已有的受限Preview准入范围，随后执行获授权的真实端到端smoke、核对新bundle exact consent和metadata；成功才考虑后续扩大准入，失败立即关闭并按同bundle rollback恢复。不能在AI gate off时宣称已完成目标环境真实发送。观察成功/失败、费用完整度、quota和reconcile。Web probe未上线不阻塞已有合格operator evidence；证据缺失照样阻塞。
7. 回退先关闭gate，选择**当前bundle下**仍合格的rollback policy并读回后恢复；代码回退目标必须同时支持v1/v2执行/显示以及cutover后的Admin JWT/TOTP/report/readback，不得回到pre-cutover build。不能因v2在途请求回滚成v1-only或删新schema/字段，也不能因Admin失败恢复旧service_role旁路。UI故障用同JWT operator工具或明确DB-owner停用路径恢复。
8. Production单独做同样身份、secret用途、evidence与授权核对，不能复制Preview READY。当前计划不授权Production发布、GitHub发布或merge。

交付runbook记录：手工bootstrap/恢复；成员管理/TOTP；常规版本创建；required evidence来源；秘钥用途revision变更；disable/rollback/reopen；未知operation恢复；reconcile/retention健康检查；何时必须停用和交还DB operator。只记录非敏感ID和证据位置，不保存token或key。

后续contract cleanup不是第一版阻塞项。只有v1 in-flight/retry、保留期和历史审计/条款读取需求被证明满足，才单独提案弃用aliases或解析分支；不自动删除历史配置。

## 16. 审查与停止条件

本实施计划通过同一Relay session评审，记录位于 [implementation review](admin-control-plane-implementation-review.md)。实施时每个工作包需要代码、相关测试结果和迁移/回退说明；PR/部署审批依用户届时授权，不从本计划推断已经允许执行。

下列情况必须保持对应功能关闭并提供具体阻塞证据：真实Auth不提供可验证近期MFA、producer无法在DB权限区分、原operator撤权破坏data-plane、v2新model仍被未覆盖的精确常量阻塞、未知目标未获出站授权、动态条款无法精确显示/接受、陈旧报告能跨关闭周期reopen、probe不能证明单次发送和保守结算、静态产物含Admin入口。普通UI调整和命名不构成重新打开整个架构的理由。
