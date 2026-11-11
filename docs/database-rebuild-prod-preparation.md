# Prod 数据库重建与迁移准备

准备日期：2026-11-11（Asia/Shanghai）。总体状态：`PREPARED_FOR_REVIEW`，仅准备；prod 连接为 `DEFERRED_USER_CREDENTIAL`，prod 重建、release promotion 和 Production 部署均为 `NOT_STARTED`。用户已授权按既定方案准备 prod，并明确要求“先准备到需要密码之前吧，明天再看看”；本轮做到可审阅准备，不再索取密码、重置凭据或连接 prod，不清理 prod、不推进 release、不部署 Production。本文件不是已完成的切换实录；现场结果必须逐项追加证据后才能改为 PASS。

可复用流程见 [重建与发布手册](database-rebuild-runbook.md)，既有经验见 [test 重建执行记录](database-rebuild-test-execution.md) 和 [test 补充验收](test-environment-acceptance.md)。旧 test 检查点、证据包和 seal 保持原样。

## 当前已知状态与候选边界

下表来自本次任务交接及既有记录，尚不代替新的 prod 现场盘点。

| 项目 | 当前已知事实 | 准备状态 |
| --- | --- | --- |
| Prod 目标 | Supabase `cspdbjusfbaobvyqxvag`；应用 `https://cvmaker.dyue.org`；监听 `release` | 目标已明确；连接、项目身份、实际配置待核验 |
| Test 参照 | Supabase `uvitgcfqnciahvakqhnv`；应用 `https://cvmaker-preview.dyue.org`；监听 `main`；实例 `842d36df-6969-4c86-abcc-6dc956dd6318` | 已重建，不再次 rebuild/resume |
| PR #44 | 已 squash MERGED；实际 main `47b36cf287ec6add10614761acb1883750240031`，合并于 2026-11-10 16:26:55 UTC（北京时间 11 日 00:26:55） | 首次 `--merge` 因 linear-history 规则被拒、未合并；随后 squash 成功，不把失败记成功或沿用旧 head |
| Main / release | `47b36cf287ec6add10614761acb1883750240031` / `4d4dfa5fe70d0af0fece00d5a916cb2f658bbe70` | 当前交接快照；release 未推进，最终 prod 候选尚未冻结 |
| Main 构建 | Web CI `42854625755` SUCCESS；Vercel Preview `7JtRef1bq178CZeq3jEq257vRFbN` SUCCESS、source 为 `47b36cf…` | 不等于同 SHA DB CI/G3或新的应用接受材料通过；工具准备尚未进入最终候选，故未为该过渡 SHA重复运行 DB CI/G3 |
| 准备工作分支 | `codex/prod-cutover-preparation`，基于 main `47b36cf…` | 新工具与文档仍须独立提交、审查并进入最终候选 |
| 已封存 test 接受状态 | 原 accepted checkpoint 绑定 `bc9d9ce…`、原实例及 15 条迁移；补充 hosted 修复验收固定源为 `bfd461e` | 不能把原 checkpoint 改绑为 PR 新源码 |
| Test 当前 AI | 用户另行授权后为 ON、ALLOWLIST、runtime revision 36 | 当前 live 状态；历史 OFF/revision 35 封存快照不改写，prod 准备不擅自切换 test AI |
| Vercel 函数区域 | 项目默认已设 Tokyo `hnd1`；无代码区域覆盖的新 Preview 实际 hnd1 已确认 | 只证明该 Preview；prod Supabase 区域及未来 Production 部署适配性仍须现场核对 |
| 资源映射 | Vercel Storage 已确认 `typst-cv-template` → Production、test 后缀资源 → Preview | 只证明资源作用域；未证明数据库连接、所有变量或 live contract正确 |
| Prod 凭据与连接 | Supabase MCP `get_project` 返回 `-32600` 无权限；用户在 Vercel 看到 prod `POSTGRES_URL_NON_POOLING` 为 `<sensitive>`，官方 Secret 机制不支持取回原值 | `DEFERRED_USER_CREDENTIAL`；`output/prod-preparation-20261111/prod-connection.txt` 为空、0600，仅预留路径；不是连接成功或执行失败 |
| Prod 访问与变更 | 旧切换记录仅包含三次只读 keepalive RPC；本轮没有建立 prod PostgreSQL 连接、重建或发布 | 真实管理员、平台、迁移历史与任务仍未盘点；不以 MCP 拒绝或资源映射冒充通过 |

PR #44 已进入 main，但新的 revalidation 工具还在准备分支，最终 prod 发布候选尚未冻结。工具及文档经审查进入 main 后，再为最终完整 SHA取得干净 checkout、两类迁移摘要、实际 Web/DB CI/G3及同源码应用接受材料；迁移摘要相同也不能沿用旧 source SHA 的 proof。发布候选锁定后，后续实录文档提交不自动替换该候选。

## 范围、保留与操作分工

沿用本地 `application_allowlist` 重建应用对象，不使用原生 hosted reset、不 DROP 平台 schema。旧业务数据可废弃；本次选择**保留既有 Auth 用户、密码与会话平台数据、Storage 及平台配置**。既有 GitHub SSO/OAuth、Site URL、回调/重定向、API 与原生集成配置、Git 分支及 keepalive Action/RPC 都在保留范围。允许废弃业务数据不代表允许删除平台用户或凭据；如范围改变，先更新实际方案与验证材料。

执行从操作员电脑进行，不额外申请 GitHub 状态 token，不建立一次性重建 Environment，不把清库放进日常 Promote Release。普通 CI 继续只在隔离环境验证。准备中的平台读取或配置操作按已有授权和实际证据单列，不能从本文推定为已经执行。

用户处理必须本人完成的账户验证、安全输入和实际 prod 登录；操作员负责工具、目标核对、记录、维护措施、受控执行及验收。必要时用户确认 prod 的实际管理员选择及条款；test 的管理员 grant 或测试 terms 接受授权不自动适用于 prod。真实账号 UUID 仅放私有身份引用，不写进本文、Git 或公开证据。

## 必须补齐的材料

| 编号 | 材料与通过条件 | 当前状态 |
| --- | --- | --- |
| G01 | 最终候选已进入 main；实际 SHA 的测试、构建、DB CI/G3 与完整摘要可核对，原 artifact 已下载并校验长期保存 | `RUNNING`：PR #44 已合并、47b Web/Preview成功；准备工具尚待提交审查，最终候选未冻结，未取得最终 G3 |
| G02 | Prod 专属连接、CA、私有记录目录和显式项目映射可用；只读 plan 确认项目、PG17、历史及清理范围无意外 | `DEFERRED_USER_CREDENTIAL`：用户要求本轮停在密码之前；空白0600文件仅为预留，不继续索取或连接 |
| G03 | 在现有 test 实例上重新验收最终新候选，生成工具可校验的新发布接受材料；绑定新 SHA、同实例和迁移链，保留原 accepted 操作 | `RUNNING`：接口实现及本地67项、类型/lint、独立审查通过；hosted revalidation和最终材料为 `NOT_STARTED` |
| G04 | 用户以准备实际使用的 prod 账号登录，核对有效 Auth 身份、旧权限和拟初始化管理员；任何额外授权有明确范围及 SYSTEM 审计方案 | `NOT_STARTED` |
| G05 | Prod 平台、Auth/OAuth/SSO、Storage、权限、集成、cron、写入口及备份基线齐全；保存恢复原值的方法 | `NOT_STARTED` |
| G06 | Production 环境变量、原生资源映射、区域和部署源核对；AI 初始三层关闭，fake flags 关闭 | `RUNNING`：资源Production/Preview映射已观察；其余未通过，未修改Production变量 |
| G07 | 维护执行人与窗口、可验证的暂停/排空方式、受控新应用入口、失败处理及停止条件均具体可执行 | `NOT_STARTED` |
| G08 | 具体重建、promotion、Production 部署及验收范围与会话授权一致，实际写入前完成最终目标/材料核对 | `NOT_STARTED`：当前仅准备 |

G03 的跨 SHA问题由独立 revalidation 材料处理，不建立第二个 accepted checkpoint。新增工具已冻结本地验证：67/67项（含12项新增）、scripts TypeScript、scoped lint及diff检查通过，独立审查 NO_BLOCKERS；真实短期本地 disposable 库证明 `default_transaction_read_only=on` 下 SELECT内写入函数被拒、夹具不变且最终清理。证据已归档至 `output/prod-preparation-20261111/local-tool-validation/`，`archive-index.json` 记录摘要，`summary.json` 保留提交前验证时点；10个源码文件摘要已再次核对，实际证据盘上的原子不覆盖写入探测也已通过并删除探测文件。这些是本地实现验证，不是 hosted revalidation、prod连接或最终候选 G3。

不得为了满足校验重建 test、重写原 checkpoint、手工制造 accepted，或关闭同 SHA/实例/清单校验。重新验收不得擅自改 test 当前 AI、任务或已有业务数据。今晚不为提前完成该表生成空壳或合成接受材料。

## 新候选的 test 只读重新验收

源码入口为 [`db-test-revalidate.ts`](../scripts/db-test-revalidate.ts)，材料形状与严格键校验由 [`db-test-revalidation.ts`](../scripts/db-test-revalidation.ts) 的 `CIInput`、`ApplicationEvidence`、`APPLICATION_GATES` 和 `TestRevalidation` 定义。下述步骤须在工具进入已冻结 main 候选后执行，本轮尚未执行。

1. 保存原 accepted checkpoint 的字节一致副本、SHA256及0600权限；原 operation及 seal不动。准备当前候选同 SHA的成功 Web run、DB run和 `database-rehearsal-evidence` 原始ZIP。其 `remote-rehearsal-proof.json` 必须逐字节匹配单独的 rehearsal输入，清理方法/迁移/清单均对应候选。
2. 在承载该完整候选的真实 test Preview 上完成六类应用门禁并保存实际证据，绑定部署ID、test项目及原实例。旧 `bfd461e` 的通过记录保持历史，不能仅改其 source字段冒充新候选已验收。`ai_runtime_scope` 核对本轮实际启用范围及授权，不要求把当前ON36改OFF，也不自动授权新的付费调用。
3. 将 CI输入、ZIP、G3、应用接受材料和各 gate证据置于同一个操作员所有的0700私有证据根目录内；这些文件须为0600普通文件、无软/硬链接。JSON最多2MiB，一般引用文件最多32MiB。refs均为该根目录下的相对路径及64位SHA256，禁止绝对路径、`..`和路径逃逸。原 accepted副本可位于另一安全路径；新proof输出必须为证据根目录中尚不存在的绝对文件。
4. 在干净、精确候选 checkout上先运行默认plan。它仅检查本地材料、Git身份和ZIP成员，不连接数据库、GitHub或hosted API，不创建proof、checkpoint或任务。实际参数如下；变量均须由操作员预先设置，示例不含真实凭据：

```bash
node scripts/db-test-revalidate.ts \
  --source-sha="$REBUILD_SOURCE_SHA" \
  --expected-project-ref=uvitgcfqnciahvakqhnv \
  --test-state="$TEST_ACCEPTED_CHECKPOINT" \
  --ci-evidence="$TEST_CI_EVIDENCE" \
  --rehearsal-evidence="$REBUILD_REHEARSAL_EVIDENCE" \
  --application-evidence="$TEST_APPLICATION_EVIDENCE" \
  --output="$TEST_REVALIDATION_OUTPUT"
```

5. 材料齐备且允许读取test时，在同一调用增加 `--execute-read-only`。为进程显式提供 test的 `REBUILD_PROJECT_REF` / `REBUILD_SUPABASE_URL` / `REBUILD_DATABASE_URL` / `REBUILD_CA_CERT_FILE`，`REBUILD_OTHER_PROJECT_REF` 为prod；不得误用prod连接。工具使用既有 `gh`身份以三个只读查询核实实际同 SHA、成功且为push/workflow_dispatch的Web/DB run与artifact官方digest；随后以强制只读SQL核对test的PG17、完整contract/权限/identity/history及runtime，确认原checkpoint字节不变，才生成独立proof和verification报告。无 `--mode`、`--state-dir` 或 `--target` 参数，也不运行initialize/register_jobs或模型请求。
6. 将工具生成的proof与整个引用目录长期保管，不手写proof。未来prod跨SHA重建仍传原 `--test-state`，另外增加 `--test-revalidation="$TEST_REVALIDATION_OUTPUT"`，同时沿用同一份G3作为 `--rehearsal-evidence`。prod校验归档字节/摘要、原checkpoint和新候选绑定，无需GitHub在线或新增token；若test本来就接受同SHA，保留原路径无需detached材料。

最小输入形状示例直接对应源码类型；**这是字段说明，未生成实际 JSON或PASS凭证**。下方 `string`、`number`及`Record`为类型，不是可替换真实验收的值；严格解析拒绝额外/缺失字段：

```ts
type EvidenceRef = { path: string; sha256: string };
type CIInput = {
  format: "candidate_ci_evidence_1";
  repository: "Yuee98/typst-cv-template";
  source_sha: string;
  web_run_id: number;
  database_run_id: number;
  artifact_id: number;
  artifact_archive: EvidenceRef;
};
type Gate =
  | "anonymous_and_legal"
  | "authenticated_cloud_cv"
  | "account_isolation_and_encrypted_logout"
  | "latest_export_roundtrip"
  | "admin_authorization_and_save"
  | "ai_runtime_scope";
type ApplicationEvidence = {
  format: "test_application_acceptance_1";
  source_sha: string;
  project: string;
  database_instance_id: string;
  environment: "PREVIEW";
  deployment_id: string;
  deployed_source_sha: string;
  gates: Record<Gate, { passed: true; evidence: EvidenceRef }>;
};
```

`source_sha`和`deployed_source_sha`均须为最终40位SHA，项目/实例须准确；run/artifact为真实正整数ID，两个run必须不同。每个gate仅在真实通过后记 `passed:true`，缺证据/失败就不能生成接受材料。artifact创建proof时必须未过期且官方digest匹配原ZIP；一旦完整核验并归档，7天后线上artifact过期不使已保存证明失效。

该机制信任操作员控制的私有材料，不是数字签名或独立远程证明。应用证据的内容由操作员据实核验；catalog检查覆盖contract、权限、实例和完整记录的迁移历史，不是逐字节比较线上函数body。不能把摘要/只读catalog通过扩大为所有业务路径已由工具自动验证。

## 连接、环境变量与管理员

当前用户明确延期密码步骤。MCP无权限和Vercel Secret不可取回不通过其他隐藏接口绕过；保留空白输入文件，本轮不要求用户填入、不重置密码、不尝试prod连接。下述连接步骤为未来继续执行时的要求。

Prod 连接由授权的安全来源提供给当次本地进程；连接串、密码、CA 私有路径及身份关联分别受控保管，目录 0700、文件 0600。复用已可用凭据；密码未知时先盘点依赖和重置影响，不能把重置数据库密码当作默认步骤。目标必须显式为 prod，排除项目为 test，使用目标 CA 及完整 TLS 验证，不读取保存的 hosted link 或开发 `.env` 推断目标。

只读预检记录实际服务器版本、数据库、连接角色、历史/旧对象及 allowlist 依赖；PG 非 17、意外对象/权限/依赖或身份不符即停止。凭据不得出现在 shell history、命令参数、日志、截图、聊天或公共证据；只保存存在状态、来源引用和必要非敏感摘要。

Production 配置按精确名称、资源和作用域核对，不从部分列表推断缺失，不断开整个原生集成：

| 配置 | 要求 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 目标为 prod，同一资源；公开变量不得误填 service-role/secret key |
| `ADMIN_ENVIRONMENT` | `production`，与 Vercel Production 及数据库初始化环境一致 |
| `NEXT_PUBLIC_AI_POLISH_ENABLED` / `AI_POLISH_ENABLED` / 数据库 runtime | 初始均关闭；只有 UI 隐藏或只有服务端关闭都不代替三层核对 |
| `NEXT_PUBLIC_AI_POLISH_MOCK` / `POLISH_FAKE_LLM` / `POLISH_FAKE_BACKEND` | Hosted 不启用模拟依赖 |
| `SUPABASE_SERVICE_ROLE_KEY` | 后续 AI 服务使用的 prod 服务凭据，仅服务端；不能复制 test 项目的值 |
| `AI_PROVIDER_KEY_DEEPSEEK_*` / `AI_PROVIDER_KEY_MIMO_*` / `AI_PROVIDER_KEY_GEMINI_*` | 与实际配置引用逐项匹配，仅 Production 的授权 Secret；Preview 已有条目不证明 Production 存在或上游接受 |
| `AI_USER_ID_HMAC_SECRET` | 需要 AI 时准备稳定的 prod 值，在请求/idempotency 保留窗口内保持稳定，不从公开变量暴露 |
| Vercel Function Regions | 按 prod Supabase 实际位置核实项目默认值；当前 hnd1 不自动证明 prod 最佳位置，也不移动旧部署 |

变量保存不回填历史 deployment；必须核对新 Production 构建采用的环境快照。AI-off 首次切换不要求发起付费调用；真实服务配置、说明、价格和开启 AI 另按明确范围验收，未执行项不标 PASS。Google 凭据存在不证明 Paid tier 或数据处理条件；若以后向其发送真实用户数据，先核实相应计费与分享设置。

管理员核对在清理前完成，初始化使用该目标已有且有效的 Auth 用户。旧应用管理员清单属于需保管的权限基准；应用表重建后首管理员由受控初始化建立，其他 membership 按实际授权恢复或添加并审计，不复制 test membership。不能根据相同邮箱、唯一旧管理员或用户 metadata 自动授予权限，不改用户密码解决 Admin FORBIDDEN。

## 平台保留、备份与维护屏障

平台基线至少包含以下实际值与脱敏证据：

- Auth/Storage 平台对象、数据计数及权限指纹；有效用户/管理员的私有关联。SQL catalog 不覆盖控制台外部配置，需另保存 OAuth/SSO provider 启用状态、Site URL、回调、redirect、应用/API 集成和恢复方法。
- Supabase prod Git 的 release 监听与自动部署状态；Vercel Production 的 release 跟踪、域名、现有部署 ID/SHA、保护/访问规则、原生资源与环境变量作用域。既有登录/2FA方式保留，不保存 OTP、会话或验证码 URL。
- 全部旧应用 cron 的名称、schedule、active 状态、任务定义摘要及在途运行；无关平台任务单独列出，不批量删除。外部定时器、Edge Function、直连 SQL 和其他 writer 据实际盘点处理。
- GitHub keepalive 的 prod/test 变量映射、schedule 与同一 `public.keep_project_active()` RPC。保留整个 workflow；不为单环境窗口禁用包含两环境的共享任务。Data API 维护期间若与调度重叠，记录实际影响，恢复后另核验，不改造返回类型制造兼容迁移。

破坏性步骤前核对可用数据库备份/PITR、时间点、保留期与恢复范围，并核实平台配置/Storage 对象是否需要独立保管。备份或恢复会覆盖什么必须具体记录；不能把平台表指纹、本地 checkpoint 或 G3 演练当作备份。旧业务数据允许丢弃，不强制为恢复旧业务制作迁移；但 Auth/Storage 与平台配置的保留责任不因此消失。若没有可用恢复能力，明确记录限制和停止/修复方案，不写“可以随时回滚”。敏感备份不进入仓库或公开证据包。

维护措施在执行前形成入口矩阵：

| 入口 | 暂停与验证 | 恢复条件 |
| --- | --- | --- |
| Supabase release 自动 DDL | 暂停自动部署并 save/reload 核实；保留 release 和整个集成 | 实际历史与 release 文件一致后恢复 |
| Vercel Production 自动部署/域名访问 | 阻止 release 推进抢跑；记录平台可用的具体控制、原值及受控验收路径；旧已发布站另做维护隔离 | DB-ready、同 SHA 部署且验收通过后受控恢复，避免重复触发 |
| Data API 业务写入 | 关闭或采用已核实的写入屏障，实际请求证明不可写；记录关闭/恢复时间与响应 | 仅新应用验收路径可受控恢复，旧写客户端继续隔离 |
| Auth/外部 API/直连 writer | Data API off 不涵盖这些入口；明确是否能改应用数据、实际停用方法和验证 | 与新实例/格式相容且恢复有记录 |
| 旧应用 cron 与在途请求 | 按精确旧任务暂停；核实 running jobs、开放业务事务和请求/attempt 均排空 | 旧任务不盲目恢复；按新 contract 注册及验收新任务 |

暂停新构建不能作为旧站停写证据。`REBUILD_MAINTENANCE_VERIFIED=true` 只能在真实屏障成立后对当次进程设置，不能替代上述证据。实际业务停写时间由入口关闭/恢复记录计算，不把整个维护窗口当作宕机时长。

## 待执行步骤与完成条件

以下为未来执行顺序；P01仅完成了PR #44合并与过渡main的Web/Preview构建，最终候选冻结及材料仍待完成，P02–P12均为 `NOT_STARTED`。执行前先补齐 G01–G08，不在准备期间提前执行破坏或发布步骤。

| 步骤 | 操作与通过条件 |
| --- | --- |
| P01 冻结候选 | PR #44已squash合并47b；新工具PR仍须完成审查合并，再冻结最终main完整SHA；核对测试/构建、实际同SHA DB CI/G3及长期归档，完成受控test revalidation，旧accepted/seal不变 |
| P02 最终预检 | 干净、固定 SHA checkout；prod 私有独立记录目录；最终只读 plan及平台基准，确认目标/旧链/allowlist/权限/备份/管理员和所有材料一致 |
| P03 开窗与停写 | 记录实际维护起点、操作者和范围；暂停自动 DDL/自动 Production 发布、旧应用写入口、Data API及旧任务，保存新请求拒绝与排空证据 |
| P04 一次重建 | 本地显式 prod 目标、确认、演练及 test 接受材料，经工具现有/已审查接口执行 application allowlist；记录 operation/checkpoint/exit，不使用 migration repair 伪造完成 |
| P05 DB-ready | 15 条/最终清单历史逐项对应；contract、PRODUCTION、新独立 instance、RLS/GRANT与首管理员通过；AI OFF、新 jobs inactive；实际 Auth/Storage/平台保留前后比对通过 |
| P06 受控发布 | **DB-ready且核对候选后**才运行 Promote Release，显式将 `source_ref` 设为冻结的40位完整SHA，不省略或沿用默认 `main`。记录 `create_tag` / `tag_name`；workflow会原子推送release及可选tag，随后部署GitHub Pages，属于正式发布。按事先确认的控制方式部署同 SHA Vercel Production，记录真实 source/deployment/domain/env snapshot；不让恢复自动同步抢跑或重复部署 |
| P07 应用验收 | 仅向受控路径开放新应用；有效/普通/失效会话权限、实际管理员、条款链接和当前同意、CV v7/云端读写/加密/导出回导及旧实例拒绝均核验；不能自动重传旧云草稿或沿用旧同意 |
| P08 接受与 AI 边界 | 明确 AI-off 范围及条件性 NOT_RUN；需要 AI 时先核实接收方说明、真实配置/价格/规则/凭据再另行授权小额 smoke。以同 source/manifest/instance的接受证据完成最后一次 resume至 accepted，之后不再 rebuild/resume |
| P09 新任务 | accepted 后通过修正后的操作流程启用 `cv-ai-reconcile` / `cv-ai-retention`，实际观察成功 run及 active/schedule；若临时缩短计划，按真实次数记录并恢复，不锁/直接 UPDATE managed cron.job或增加 GRANT |
| P10 恢复入口 | 历史与 release 文件一致后恢复 Supabase Git及正常 Production自动部署；确认目标域名指向已验收版本，再恢复正式写入口，检查无旧实例写入；每个开关 save/reload单独留证 |
| P11 保活与最终复核 | 对目标同一只读 keepalive RPC核验 HTTP成功；test健康检查单列，不能凭一次 matrix状态代替两边结果。最终只读 verify、Auth/OAuth/Storage保留、cron、AI关闭、source/domain/release和集成状态均核对 |
| P12 关窗与封存 | 清理本地进程凭据/确认变量，关闭维护窗口；封存原始证明、脱敏索引/摘要、接受状态及例外；实录文档单独提交，记录提交不改绑发布候选 |

Prod 自行生成 instance、配置、授权与同意；不复制 test 的用户/请求/接受/管理员/业务配置数据。实际启用的 GitHub OAuth/SSO路径须在保留核对及真实登录中验证；原本 disabled的provider保留原状态，不为勾选验收项擅自开启。条款由实际 prod 用户按适用要求接受，不伪造同意。

## 失败、停止与回退限制

| 现场情况 | 处理 |
| --- | --- |
| 材料/SHA/实例/目标/权限不符，或无法证明停写 | 停在破坏步骤前；修正准备并重新核验，不放宽 guard |
| 清理结果不明或网络断开 | 保持维护，核对 durable intent、真实 catalog/history、进程和锁；先 plan，再按同 operation受控 resume，不能换目录或盲目重清 |
| 基线部分执行 | 同候选/实例补缺失迁移；不得 repair为已执行，不改写已应用文件 |
| DB-ready但 promotion/构建/部署失败 | 保持维护，重试同 SHA发布；不再次清库，不把旧应用指向新 contract当作回滚 |
| 必须修改代码/DDL | 先在 test验证新候选、追加已发布后的迁移并生成对应材料；原证据保留，不给旧成功状态换绑 SHA |
| 平台保留项不一致 | 保持隔离，按实际备份/配置恢复范围处理并复核；未核实影响前不恢复正式写入口 |
| 配置/价格/条款或上游凭据失败 | AI继续OFF；通过当前 Admin事务修正，未知费用保留未知，不循环付费重试 |
| accepted 后任务/集成恢复失败 | 使用独立后置恢复流程，不再 resume/rebuild，不把 maintenance=false 当作全部恢复成功 |

回退 release或旧 Vercel deployment不恢复旧数据库。若考虑数据库备份恢复，必须独立核对恢复点、Auth/Storage/配置覆盖影响及恢复后的代码/数据匹配；不能承诺一键无损回退。业务数据废弃不代表可以忽略平台保留失败。

## 实录与交接

建立独立 prod 实录时据实保留P01已发生的准备事实，未执行的最终候选验收及P02–P12不复制旧test的PASS；本轮凭据延期单列 `DEFERRED_USER_CREDENTIAL`，不写成执行失败。每项保存带时区开始/结束时间、操作者、目标、source/mode、run/deployment/operation、预期与实际结果、退出码、证据路径和摘要。失败、被拒绝及不确定结果都保留，临时设置必须记录原值、恢复动作及 fresh readback。

原始 plan/verify、checkpoint/events、实际 G3 artifact/proof、平台保留比较、维护/排空、发布、验收、任务和保活证据分别留档。脱敏证据与私有材料分开；不保存密码、连接串、token、key、Cookie、用户正文、原始身份关联或完整终端历史。先确认已脱敏再封公开包；封存后仅新增 sidecar登记记录提交，旧档案不修改。当前 G3 artifact保留期7天，需及时下载，不以短期 URL代替长期证据。

真实手机、持久化取消、hosted同ID重放、自然keepalive调度及供应商发票等既有边界继续明确标注，不自动提升为prod门禁或PASS；本次具体 required范围应在执行前固定。prod实际管理员、保留项、停写/排空、同候选部署/接受、任务与入口恢复属于必须有现场证据的切换门禁。
