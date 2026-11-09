# Test 数据库重建执行记录

总体状态：`NOT_STARTED`。2026-11-09 已完成只读现场盘点；尚未合并、执行 hosted SQL、修改云端配置或发布。按用户最新决定，从本机执行一次性重建，本地保存检查点与脱敏日志；不申请额外 GitHub 状态令牌，不创建重建 Environment。本记录持续追加实际操作，执行流程见 [重建与发布手册](database-rebuild-runbook.md)。

## 目标与范围

| 项目 | 已盘点值或待确认项 |
| --- | --- |
| 仓库与候选 PR | Yuee98/typst-cv-template，[PR 43](https://github.com/Yuee98/typst-cv-template/pull/43) |
| 盘点时 PR head | `7499e8d2dbad75693cd2c5f16585ad487a4afae8`，不是未来实际合并 SHA |
| 盘点时 main | `ccbeb1a4fc2baba9dbc2c15a4ba183a1be3558aa` |
| 盘点时 release | `4d4dfa5fe70d0af0fece00d5a916cb2f658bbe70`，本次不推进 |
| Test Supabase | typst-cv-template-test，`uvitgcfqnciahvakqhnv`，Tokyo / ap-northeast-1 |
| Test API | `https://uvitgcfqnciahvakqhnv.supabase.co` |
| Test 监听分支与初始化环境 | main / PREVIEW |
| Test 应用 | Vercel `yuee98s-projects/typst-cv-template-web`，`https://cvmaker-preview.dyue.org` |
| 执行位置 | 操作员电脑，显式 --target=test；绝对 --state-dir 待确定 |
| 本次不操作的 prod 项目 | `cspdbjusfbaobvyqxvag`；应用 `https://cvmaker.dyue.org`，监听 release |
| 清理方法 | application_allowlist；保留 Auth、Storage 与平台配置，待切换授权确认 |
| 管理员 | 使用已有有效 Auth 用户；账号标签与受控 UUID 对照待确认，不在仓库保存邮箱或用户 UUID |
| 维护窗口 | 待定；记录开始/结束 UTC 与 Asia/Shanghai 时间 |
| 授权范围与时间 | 待确认；合并、test 维护、清理、部署分别明确；prod 重建不在范围内 |
| 执行者与验收者 | 待填 |

以上为 2026-11-09 的现场快照，执行前重新核验。Supabase 控制台中的 `main Production` 是该 test 项目的主数据库分支标签，不能据此把操作目标改为 prod。

## 用户操作与代办范围

| 事项 | 分工与当前状态 |
| --- | --- |
| 已登录浏览器、个人验证、组织审批 | 用户在需要时完成；不要求重新提供已可用的登录 |
| Test 数据库密码 | 用户通过官方安全输入界面录入；未知时先评估其他连接，再由用户重置。不是 Supabase API key 或 access token |
| GitHub 状态 token / 重建 Environment | 已从方案移除，无需用户操作 |
| 本地连接、CA 与记录目录 | 执行者准备和核验；CA 无需用户手抄，连接秘密不写入实录 |
| Vercel Preview 变量与 Secret | 执行者核对原生集成、最新变量名与作用域，按用户授权来源配置；缺少安全来源或需要本人验证时再交接 |
| 首管理员选择 | 执行者先核对已有账号/管理员关系；存在歧义时请用户指定，记录受控身份引用 |
| 合并、维护、重建与部署 | 材料就绪后，在用户明确 test 切换授权范围内由执行者完成 |
| 自动验收与执行实录 | 执行者完成；用户可补充手机/常用操作体验验收 |

如果浏览器或部署流程要求本人登录/验证，记录实际交接与完成结果；不为一次性重建额外引入凭据或审批层。

## 现场盘点与切换前阻塞

| 项目 | 2026-11-09 只读结果 | 切换前要求 |
| --- | --- | --- |
| Supabase Git 集成 | test 监听 main，Deploy to production 开启 | 合并前暂停并记录原值、验证结果、恢复方法 |
| Vercel Preview | Branch Tracking 开启，All unassigned branches；自定义域名绑定 main | 合并前暂停 test 自动构建；单独验证旧站/API 停写 |
| Vercel Production | release，与 prod Supabase 原生集成 | 保持原配置，不 Disconnect 整个项目或集成 |
| Supabase 原生集成 | test→Preview，prod→Production 均已连接 | 核对最新变量名和目标映射；不从普通变量列表推断密钥缺失 |
| Auth | Email enabled；GitHub provider disabled | 原样保留并复核；本次不额外开启 OAuth provider |
| Auth Site URL | `https://cvmaker-preview.dyue.org` | 切换后对比 |
| Auth redirect URLs | `https://cvmaker-preview.dyue.org/**`、`http://localhost:3000/**` | 切换后对比 |
| 数据库身份与旧对象 | 尚未连接 hosted Postgres 盘点 | 合并后由受控只读 plan 核对 PG 版本、历史、catalog 与清理范围；另做独立只读平台保留盘点 |
| 写入口和旧任务 | 实际停写方法、cron、在途状态尚未验证 | 除暂停集成外，记录真正有效的隔离和排空证据 |
| 本地执行 | 一次性 hosted 重建从电脑执行 | 准备下表本地参数、私有记录目录及目标 CA |
| 重建 workflow | 已从方案移除 | 普通 CI 保留；正式重建前合并并固定实际 main SHA |
| G3 | 现有证明绑定 PR synthetic merge，不是已合并 main | 对实际候选运行 DB CI，核验并归档新 proof |
| keepalive | 盘点时 Action 覆盖 test+prod；新旧返回类型不同 | 代码改为只读 RPC 的 HTTP 成功检查，合并后分别核验两边，prod 保持旧库 |

本地执行准备项如下；凭据仅对执行进程提供，不创建 GitHub Secret/Variable。仅记录来源引用、存在状态和核验时间，不记录秘密值。

| 类型 | 名称 | 目标或要求 | 状态 |
| --- | --- | --- | --- |
| 进程环境 | REBUILD_PROJECT_REF | `uvitgcfqnciahvakqhnv` | NOT_STARTED |
| 进程环境 | REBUILD_OTHER_PROJECT_REF | `cspdbjusfbaobvyqxvag` | NOT_STARTED |
| 进程环境 | REBUILD_SUPABASE_URL | `https://uvitgcfqnciahvakqhnv.supabase.co` | NOT_STARTED |
| 进程秘密 | REBUILD_DATABASE_URL | 目标连接串；密码安全录入，受控记录仅保留无密码的连接身份 | NOT_STARTED |
| 进程环境 | REBUILD_CA_CERT_FILE | 官方目标 CA 的绝对文件路径；记录来源、指纹与有效期 | NOT_STARTED |
| 命令参数 | --state-dir | 私有绝对目录；同一目标始终复用同一目录 | NOT_STARTED |
| 进程环境 | REBUILD_EXECUTION_AUTHORIZED | 实际授权后当次进程设 true | NOT_STARTED |
| 进程环境 | REBUILD_MAINTENANCE_VERIFIED | 实际隔离验证后当次进程设 true | NOT_STARTED |
| 本地文件 | test-uvitgcfqnciahvakqhnv.json | 脚本创建和推进；不手改成功状态，结束后供 prod --test-state 读取 | NOT_STARTED |
| 本地文件 | test-uvitgcfqnciahvakqhnv.events.jsonl | 追加实际执行事件与脱敏结果，结束后归档 | NOT_STARTED |

## 候选提交与证明

当前基线共 15 文件，盘点时 baseline_digest 和 migration_manifest_digest 均为 `74138cc9c03c706e41a2d4c75968c71bff2ba4a10dd14e2758964d853adde1ad`。以下实际发布字段必须重新读取并填写，不能仅沿用盘点值。

| 字段 | 实际值 |
| --- | --- |
| 最终批准 PR head / 合并方式 | 待填 |
| 实际合并 main SHA / 冻结时间 | 待填，完整 40 位 |
| 后续实录提交 SHA | 待填；与发布候选分开，不能据此改绑接受状态 |
| 应用部署 source SHA | 待填，须与候选一致 |
| 实际本地脚本版本 | 待填，候选 checkout SHA 与脚本摘要 |
| DB CI run URL / head SHA | 待填 |
| G3 artifact ID / 下载时间 / ZIP SHA-256 | 待填 |
| Proof source_sha / 原始 proof SHA-256 | 待填，source_sha 须与实际候选一致 |
| 基线与完整迁移清单 | 待填，归档每个文件原始字节的 SHA-256 |
| cleanup SQL / retired inventory SHA-256 | 待填，须与 proof 和运行代码一致 |
| Supabase CLI / Node / psql / 目标 PG 版本 | 待填；CLI 固定 2.109.0，实际目标版本须通过 guard |
| 目标 CA 来源 / SHA-256 指纹 / 有效期 | 待填 |
| 验证后的长期归档位置 | 待填；公共脱敏证据与受控原始证据分别列出 |

盘点时的 PR G3 来自 [DB CI run 42600302836](https://github.com/Yuee98/typst-cv-template/actions/runs/42600302836)，source_sha 为 `e629e62e9d494e9fdfda586eb93405b5fe7228b4`。这是历史参考，不是本次 hosted 执行通过证明。当前 CI artifact 仅保留 7 天，必须及时归档；原始 proof 与脱敏副本的摘要分别记录。

## 逐步执行表

每步关联一条或多条下节实录。只有完成该步实际检查并附证据才能改为 PASS；执行失败立即追加记录，不覆盖原失败条目。

| 步骤 | 内容与通过条件 | 状态 | 实录与证据 |
| --- | --- | --- | --- |
| T01 | 核验目标、授权、管理员和保留范围，准备本地连接/CA/记录目录 | NOT_STARTED | 待填 |
| T02 | 核验 keepalive 的 HTTP 成功检查与同一只读 RPC，保留 prod 防回收能力 | NOT_STARTED | 待填 |
| T03 | 保存平台/集成原值，暂停 test 自动同步与部署，验证停写和排空 | NOT_STARTED | 待填 |
| T04 | 合并候选，固定实际 main SHA | NOT_STARTED | 待填 |
| T05 | 实际 SHA 的 DB CI、完整 G3 核验与长期归档 | NOT_STARTED | 待填 |
| T06 | 本地只读 plan 核对目标、PG、历史、清理清单和检查点；另行建立真实 hosted 平台保留基准 | NOT_STARTED | 待填 |
| T07 | 执行一次 application_allowlist rebuild，保存各阶段 operation/state；未知结果转恢复 | NOT_STARTED | 待填 |
| T08 | 核验当前迁移历史、contract、PREVIEW、首管理员、新 instance；AI off、jobs inactive | NOT_STARTED | 待填 |
| T09 | 部署同 SHA Preview，记录 deployment ID/URL/环境映射，限验收访问 | NOT_STARTED | 待填 |
| T10 | 完成下节应用与权限验收，记录 AI/付费调用实际范围 | NOT_STARTED | 待填 |
| T11 | 提交 acceptance evidence，本地最终 resume 后检查点=accepted | NOT_STARTED | 待填 |
| T12 | 最后一次 resume 后启用计划任务，核验状态及实际运行 | NOT_STARTED | 待填 |
| T13 | 恢复 test 集成/写入口；分别核验 test/prod keepalive，清理 shell 凭据/确认变量 | NOT_STARTED | 待填 |
| T14 | 核对保留项、关闭维护窗口、归档并提交实录，整理 prod 待办 | NOT_STARTED | 待填 |

### 每次执行实录

下表是待填写格式，不是执行结果。执行时为每次操作、重试和恢复追加独立条目，保留失败与修正轨迹。

| 字段 | 待记录内容 |
| --- | --- |
| 步骤与时间 | T 编号、开始/结束 ISO 时间、操作者、本地 attempt 标识；维护开始/结束同时标注北京时间 |
| 操作前 | 当前维护/集成/任务状态、实际写入口验证、目标和预期结果 |
| 操作 | 确切命令、SQL 文件路径及摘要、或 Dashboard 控件/原值/新值；敏感值使用环境变量名代替 |
| 命令输入 | target、完整 source_sha、mode、expected-project-ref、state-dir；rebuild/resume 的确认项、管理员受控引用及证据文件摘要 |
| 运行证据 | 本地 events/输出文件路径、实际 checkout SHA、退出码、截图引用；CI/部署等外部操作另记 run/deployment URL |
| 本地检查点 | 文件、operation_id、phase、maintenance、source/digests、instance、history；每次命令前后留存，事件日志记录实际检查点，不推断未观测时点 |
| 运行后 | 实际结果与 PASS/FAIL/BLOCKED、异常原因、是否继续、下一步 |
| 证据归档 | 文件名、SHA-256、非敏感长期位置；原始证据与脱敏副本分列 |

第一次 plan 之后保留完整旧对象 inventory 与迁移历史摘要；平台保留项另外只读盘点，plan 不输出 Auth/Storage/OAuth 指纹，CI G3 的演练指纹不能代替 hosted 前后证明。首次清理之后保存新历史、contract 和实际平台保留对比。`phase=migrations` 只代表进入该阶段，不保证所有迁移已完成。`reset_started` 或网络超时不等于执行失败/成功，先核对 state/catalog/history；不重复清库，不手工改为 applied/accepted。若使用恢复证明，标明实际观察或演练构造的来源，不混用。

### 应用验收

| 验收项 | 必须记录的结果 | 状态 |
| --- | --- | --- |
| Auth 与权限 | 真实登录/退出；首管理员允许；普通用户和失效会话拒绝管理操作；原有 Auth/回调配置保留 | NOT_STARTED |
| CV 与实例 | 新格式创建/编辑/保存/读取；旧实例 ID/缓存拒绝，无旧草稿/同意自动重传 | NOT_STARTED |
| Admin | 配置展示名、配置/价格原子保存、规则/候选、数据处理说明、冲突/错误反馈；手机与宽屏 | NOT_STARTED |
| 条款与选择 | 准确正文链接、当前内容的显式同意、候选选择；默认项不可用不静默切换 | NOT_STARTED |
| AI 开放与密钥 | 关闭时拒绝；实际启用范围、endpoint/credential_ref/接收方说明对应；仅记录引用及存在状态 | NOT_STARTED |
| 额度与结算 | 按已授权范围验证取消、限额、未知用量/费用、多币种隔离；注明测试方法 | NOT_STARTED |
| 付费调用 | 单独记录授权、服务/模型、请求数、实际结果与费用；未授权则标 NOT_RUN，不计通过 | NOT_STARTED |
| 接受证据 | source_sha、migration_manifest_digest、database_instance_id、all_gates_passed、applications_verified 与实测一致 | NOT_STARTED |

生成 acceptance evidence 前，以上适用且必需的应用门禁必须完成；未执行项必须说明为何不属于本次必需范围，不能直接填写 all_gates_passed。verify 只读检查不能代替带 acceptance evidence 的最终 resume。

### 接受后的恢复验收

以下在 accepted 之后执行，须全部核验后才能关闭维护窗口；不与应用接受证据形成先后循环。

| 验收项 | 必须记录的结果 | 状态 |
| --- | --- | --- |
| 任务 | 最终 resume 后 cv-ai-reconcile / cv-ai-retention 的 active、计划与实际运行结果 | NOT_STARTED |
| Keepalive | test、prod 各自 run/job、同一只读 RPC 的 HTTP 成功结果 | NOT_STARTED |
| 发布与保留 | test 源码 SHA/域名/集成正确；prod release 与配置未改动；平台指纹和 Auth/Storage/OAuth 对比 | NOT_STARTED |

## 异常与恢复

尚无线上执行异常。发生时按“时间、步骤、现象、已知 phase、实际 catalog/history、原因、采取的措施、关联 run/证据、复验结果”逐条追加。清理开始后的默认路径是按受控 state 修复并向前恢复；旧应用不能直接指向新库作为回滚。需要追加修复提交时，保留旧记录并在 test 验证新候选，不改写已应用迁移。

## Prod 重建前复用检查

- test 的最终 accepted source SHA、清单、实际部署与全部必要验收可互相核对；证据已归档，不能只依赖短期 artifact。
- 已填写实际停写、排空、暂停/恢复方法和耗时，解决所有影响 prod 的异常；keepalive 过渡有明确结束条件。
- 复制流程到独立 prod 实录后，将步骤状态重新置为 NOT_STARTED；重新核验项目映射、连接/CA、管理员、保留项、维护窗口、授权、部署和各类 run/operation/instance，不能照搬 test 的值或用户数据。
- 准备独立 prod 连接和 CA；本地 --target=prod 显式绑定目标和 --test-state，读取已归档的 accepted test 文件。无需重建 Environment、仓库状态变量或额外 GitHub token。
- prod 使用同一已通过 test 的完整 SHA 和两类摘要；先受控重建至 DB-ready，再按手册受控 promotion/deploy/验收，最后恢复集成。不得在数据库尚未就绪时让 release 的自动同步抢跑。
- prod 保留独立实例、管理员与用户授权；执行凭据、数据处理/价格/额度与开放范围重新核实，不能复制 test 的接受记录或成功状态。

当前结论：test 尚未开始，prod 尚无可复用的实际执行结果；以上待办随 test 实录持续补齐。
