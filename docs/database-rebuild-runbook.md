# test 和 prod 数据库重置发布手册

状态：本地实现及演练记录；线上执行待另行授权。日期：2026-11-07。配套[数据库结构](database-rebuild-design.md)和[实施计划](database-rebuild-plan.md)。本文描述重构完成后的操作；当前没有授权执行线上 reset、SQL、配置变更或发布。

复用现有两个 Supabase 项目，test 监听 `main`，prod 监听 `release`。每个环境只执行一次新基线重建，之后恢复分支集成的增量迁移。当前不填写或猜测线上 project ref、数据库连接和 Git 集成实际配置；执行阶段先核验这些值。

本次发布包含按时段选择 Provider 的完整功能：数据库保存各时段可选集合与默认项，界面提交显式选择，服务端冻结所选配置及披露。必须在 DB/API、Admin 配置和用户界面均完成验收后执行重建，不先发布只有新表但仍自动选择单一 Provider 的中间版本。

本次同时执行全仓历史兼容与 legacy 清理。本地 JSON 导入、历史本地文档和草稿也只支持最新格式；不提供旧格式升级或旧 storage key 恢复。当前目标 CV 内容版本为 v7，发布记录与提示须明确 CV 5/6 及旧单文档存储不再支持。此范围适用于 Vercel 和 Pages 两种产物；代码和本地验证已完成，当前不执行线上步骤。

## 发布拓扑和约束

| 环境 | 数据库 | 应用 | Git 来源 |
| --- | --- | --- | --- |
| test | 独立 Test Supabase 项目 | Vercel Preview | `main` |
| prod | 独立 Production Supabase 项目 | Vercel Production、GitHub Pages 静态产物 | `release`，由 Promote Release 前移 |

两个项目的 Supabase GitHub Integration 都把各自监听分支称为 production branch；这不意味着 test 使用了 Supabase preview branch。不能把“删除并重建临时 Supabase branch”套用到这两个独立项目。

现有 [Promote Release](../.github/workflows/promote-release.yml)验证来源可从 main 到达、构建静态产物、前移 release 并部署 Pages。分支监听按当前部署配置分别触发 Vercel Production 与 Supabase，两者没有就绪屏障；执行前必须核实 Actions 推送是否实际触发对应集成，不能仅凭 push 成功认定已部署。重构发布采用“先完成 prod DB，再推进 release”的顺序，并逐个确认 Vercel/Pages 部署的 SHA、环境和 URL。

Pages 在现有 workflow 中读取仓库级 Supabase URL/publishable key，Vercel 使用自己的环境变量；同 SHA 不保证连到同一项目。P1 需提供构建环境核验：test Preview 只连接 Test project，Production 与 Pages 只连接 Production project，静态产物不得带测试 URL 或服务端凭据。实际自动触发缺失时使用已准备的精确 SHA 部署流程，不以新空提交触发发布。

Supabase Git 集成只运行尚未应用的 migrations。远端历史有版本而仓库没有对应文件时会失败；删除文件不会删除数据库。重建必须得到“新业务对象 + 新 migration history + 新代码”三者一致的结果。[官方 Git 集成说明](https://supabase.com/docs/guides/deployment/branching/github-integration)

## 重置范围

用户已补充允许删除 Auth 用户及其他历史数据。保留旧账户不再是要求；必保留的是项目、登录与部署配置、keepalive Action 及其 RPC。这是后续重置的数据边界调整，当前仍不执行 test/prod 操作。

| 对象 | 处理边界与当前工具 |
| --- | --- |
| 旧 CV、AI 配置、额度账本、业务同意、Admin membership/report/audit | 按用户已接受的业务数据废弃前提清空，从新基线初始化 |
| 旧业务表、函数、view、policy、trigger、索引 | 删除；不能只清行后保留旧结构 |
| `supabase_migrations` 中应用迁移记录 | 与新基线重新对齐；reset 后必须精确核验，没有旧文件对应的记录不能残留 |
| Supabase 项目、ref/URL、API keys、OAuth/SMTP、Site URL/redirect allowlist、Git 集成 | 保留原配置；不删除重建项目、不主动轮换 key、不执行配置 push 覆盖登录设置 |
| GitHub 登录/SSO 配置 | 保留 GitHub OAuth provider 的启用状态、client 配置、GitHub OAuth App 的 callback，以及已有 SSO/SAML provider/domain 配置；不把登录配置记录当成用户数据 |
| Auth 用户、identity、session、refresh token、MFA 等用户数据 | 用户允许清空；当前 `application_allowlist` 工具未删除它们。若选择同时清理，先完成下节的定向清理与重新初始化演练 |
| Auth/Storage 平台 schema、系统表定义与平台 migration metadata | 保留平台运行结构；清用户数据不等于 DROP/recreate auth 或 storage schema |
| Storage buckets 与对象内容 | 用户允许清空；当前应用白名单工具保留。若选择清理，使用 Storage API 管理对象及底层文件，不只删数据库元数据 |
| GitHub 定时 keepalive Action 与 `public.keep_project_active()` | 保留任务、production/preview 两目标和仓库变量；函数由新迁移重建为当前 boolean 契约，切换期间暂停、验收后恢复 |
| 旧 cron | 停用并明确 unschedule 本项目任务，新任务在验证后恢复 |
| 自定义角色、默认 ACL、Data API 暴露设置、publication、Auth hooks | 单独核查并按新契约处理；业务白名单清理不隐式删除平台配置或角色 |
| 客户端本地文档、JSON 导入和草稿 | 只读取最新内容/存储格式；CV 5/6 和旧单文档 key 不迁移、不恢复，旧格式明确拒绝；符合最新格式的文档继续可用，不批量清空浏览器存储 |
| 云端缓存与 pending 操作 | 按新 database instance 隔离；不兼容旧 ID、旧格式、旧接受记录或旧同步队列 |

本轮独立本地 disposable 演练观察到，固定 CLI `2.109.0` 的原生 `db reset --db-url` 删除了该演练库的 Auth 用户、session 和 MFA 数据。该记录只证明本次版本、命令及演练环境的行为，不断言其他版本或线上项目的删除范围。官方 CLI 的 reset 说明不能代替平台保留证据。[CLI reset 说明](https://supabase.com/docs/reference/cli/supabase-db-reset)

删除上述 Auth 用户数据现已获用户允许，因此该现象本身不再是业务阻碍。但固定版本的[原生清理 SQL](https://github.com/supabase/cli/blob/v2.109.0/apps/cli-go/pkg/migration/queries/drop.sql)会清空除 `schema_migrations` 外的 Auth 普通表，包含 SSO/SAML 配置表，还会删除所有 schema 的 RLS policies 和部分扩展；它也保留部分平台对象与 Storage 数据，不能直接称为“清空数据且保留全部配置”。当前不据此切换重建方法。

当前已实现的 hosted/rehearsal 清理方法为 `application_allowlist`：仅删除审核清单中的旧应用对象及对应旧应用 migration history，保留 Auth/Storage、扩展、角色与平台 schema；不调用原生 remote reset，不执行 `DROP SCHEMA public CASCADE`。这是已演练的实际工具范围，不是必须保留旧用户的业务要求。清理 SQL 和 inventory 由固定旧 Git 基线生成并进行依赖检查；发现未盘点对象或跨平台依赖即停止，不能临时扩大 DROP 范围。演练与执行证明同时绑定方法和两个清理 digest，现有 12 类指纹仍作为此次保留行为的实测记录。

### 选择同时清理 Auth/Storage 时的前置工作

若后续采用连同用户数据一起重置的方案，先在独立本地库完成以下工具增量和演练，再使用新的方法/范围及证明执行。现有 `application_allowlist` 的证明不能充当 Auth/Storage 清理证明；当前脚本尚未提供这一全面数据清理入口。

1. 固定可删数据和必保留配置清单；记录 GitHub OAuth/SSO 启用状态、callback、Site URL、redirect allowlist 和必要配置的安全指纹/secret 存在性，不输出凭据。当前代码使用 `provider: "github"` 的社交登录；其项目配置与数据库内 SSO/SAML 配置分别核对。[GitHub 登录配置](https://supabase.com/docs/guides/auth/social-sign-in/auth-github)
2. 在停写和旧应用对象清理后，对用户数据执行定向清理；保留 SSO/SAML 配置、平台表定义与平台 migration metadata。若删除 Storage，先通过 Storage API 清理真实对象及文件；不得只清行留下孤立文件。新旧应用依赖、任务和回滚/恢复边界一起演练。
3. 新基线完成后在 `catalog_verified` 明确等待管理员身份，不立即标记 DB-ready。允许受控的 GitHub Auth 登录来重新创建用户，同时保持业务 Data API、AI 和线上应用在维护边界内；Auth 登录不依赖业务 Data API 开放。需补充明确等待/resume 入口，不能把当前缺少 `--admin-user` 时的报错当成设计流程。
4. 从目标环境重新核验本人的新 Auth UUID，再显式 `resume` 执行 owner bootstrap。旧 UUID 不复用，不把“第一个登录的人”自动设为管理员；test/prod 分别核验新身份。用户需要重新接受当前条款，管理员重新注册 TOTP、验证 AAL2。
5. 验证配置未变、GitHub 登录和回调可用、keepalive 匿名 RPC 正常，再完成 test/prod 各自的应用和发布验收。新增清理步骤同样遵守持久 checkpoint、精确目标/SHA、仅首次清理和重复 resume 不再清空的约束。

### keepalive 必保留项

[Keep Supabase active](../.github/workflows/supabase-keepalive.yml)保持每周一/四 UTC 02:17 的计划及 production/preview 两目标。保留仓库变量 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`PREVIEW_SUPABASE_URL`、`PREVIEW_SUPABASE_PUBLISHABLE_KEY`，继续核验两个 URL 不同。`public.keep_project_active()` 的旧实体可随旧业务对象删除，但新基线必须重建同名零参数、只读、允许匿名调用的 RPC；当前唯一返回格式为 JSON 布尔 `true`，Action 已同步严格校验。

维护窗口只暂停执行，不删除 Action、cron 配置或仓库变量。完成两环境对应的新函数及匿名 API 校验后，恢复定时任务；每目标的三次请求均须通过。切换期间旧库与新库返回契约不同，通过维护暂停协调，不在 Action 中加入双格式兼容。

## 执行前材料

所有值在同一份切换记录中固定，保存到权限受控的 Actions artifact 或操作记录；连接字符串、数据库密码、key、JWT、CV 和 Provider 请求内容不得进入记录。

| 项目 | 要求 |
| --- | --- |
| `source_sha` | 完整 SHA；test 使用 main 实际合入后的 SHA；prod 必须使用 test 已验收的同一 SHA |
| 基线指纹 | `baseline_digest` 固定最初四条冻结基线；`migration_manifest_digest` 覆盖本次 SHA 的完整有序清单，当前含第五条 owner 审计/FK、第六条延迟约束权限修复及第七条 DeepSeek Responses 切换、第八条 Gemini Interactions 接入；分别记录每文件 SHA-256 |
| 清理方法与指纹 | `method=application_allowlist`、`cleanup_sql_digest`、`retired_inventory_digest` 与演练证明、checkout 文件及持久 intent 一致；不得复用原生方法或其他清理清单的成功证明 |
| 项目映射 | test/prod 名称、ref、URL 主机、数据库连接对应关系；两者不得相同 |
| 目标数据库 CA | 从目标 Supabase 项目的 Database Settings 下载 Server root certificate，核对目标后分别配置对应 GitHub Environment secret `REBUILD_CA_CERT`；必须为 PEM X509 CA，不复用开发者默认 CA |
| 分支和部署 | main/release 当前 SHA；当前 Vercel/Pages deployment 及对应 Supabase 项目；暂停/恢复入口、维护访问隔离方式和负责人；本次切换期间冻结 main/release 自动推进，只允许验收后的修复 SHA |
| 平台配置 | exposed schemas、Data API 状态、Postgres/CLI 版本、扩展安装 schema、默认 ACL、角色、Auth hooks、publication、应用 cron |
| 初始化目标 | LOCAL/PREVIEW/PRODUCTION 标签；首管理员 Auth UUID；Provider 凭据引用和初始配置来源；各时段选项/默认项、profile/price lane、对应披露及其审核来源；不保存 secret 值 |
| 验证结果 | 本地 G1–G9（含 A/B→A/C 边界、非默认选择、逐项同意、全部 CV 入口仅最新格式及全仓 legacy 残留检查）与 remote-mode 演练；prod 额外要求同 SHA 的 test G10 记录 |
| 客户端格式切换 | 固定当前 CV 内容/索引/加密封装格式；备齐当前格式成功、旧格式拒绝及旧 storage key 不恢复的验收记录；发布说明不承诺历史文件可导入或自动升级 |
| 旧系统定位 | 旧部署 SHA、旧 schema/ACL/任务清单，便于诊断；无需迁移已声明废弃的业务数据 |

真实环境清单必须在将要操作的 project 中读取，而不是只使用 GitHub variable、当前目录 `.temp/project-ref` 或本地 Supabase 状态作为目标证明。工具将这些读回值与显式传入的 expected project ref 比较。

本次可以接受维护窗口和业务数据丢弃。数据回滚不属于默认方案；如果临执行前决定需要恢复旧数据，必须先调整备份和恢复计划，不能在已经 reset 后承诺恢复。

## 停止旧系统访问

维护分为应用流量和数据库流量两层。仅设置 `AI_POLISH_ENABLED=false` 不阻止云端 CV、条款接受和 Admin 操作；仅部署维护页也不阻止已经打开的旧浏览器直接访问 Supabase。

1. 暂停目标项目 GitHub Integration 的自动 production 部署，保留其 repo/工作目录/分支配置记录。两个独立项目分别操作，不关闭整个组织的 Supabase GitHub App。
2. test 暂停 Preview 自动发布；prod 冻结 promotion。Vercel、Pages 和任何旧 preview URL 要纳入维护访问边界；不能只控制主域名。
3. 关闭旧 DB 的 AI gate，停止新 reserve/start；等待已经传输的请求完成和结算。关闭 gate 不应先切断完成事实写入。
4. 停止本项目 cron、keepalive 和其他写入/部署任务，等待正在运行的任务退出。cron 停用不代表当前 run 已停止，应检查活动事务。
5. 应用进入维护后，在目标项目的 Data API integration overview 关闭 **Enable Data API**。该开关使自动 REST 接口停止响应，可阻断旧浏览器和旧服务端的 REST 写入；数据库 owner 连接继续用于 reset。[官方 Data API 开关说明](https://supabase.com/docs/guides/api/securing-your-api)
6. 核验任何实际启用的 Realtime、Storage 写入路径、直接数据库连接、Auth hooks 或外部 jobs。Data API 开关不替代这些产品/连接的控制；本次不使用的入口记录为未启用，实际存在的应用写入必须单独停止。
7. 检查不存在旧 migration/deployment 正在执行或排队，确认业务写入已静止后才开始 reset。超时或有不明写入时保持维护并停止后续步骤。

旧 Provider 请求是否已传输不能由取消 HTTP 连接证明。若已无活跃执行但仍存在 HELD/unknown 记录，记录其数量和最后状态；本次按明确的数据废弃范围清除，不把清除解释为已结算或 Provider 未计费。

## 重建工具的行为

现有 `database-rebuild.yml` 和 `scripts/db-rebuild.ts` 采用 plan/rebuild/resume/verify 四种模式，默认 plan。rebuild 仅用于首次业务清空，resume 只执行经过核验的剩余 phase 或追加修复，绝不隐式再次 reset；verify 只读。普通 push、PR 和 schedule 都不调用 rebuild/resume；CLI 的 `--yes` 只能在已确认目标和执行内容的手动流程内部使用。

### 只读计划

plan 模式固定 checkout SHA，验证 target、两种 migration digest、分支关系、项目映射、CLI/Postgres 版本、平台保留项和目标对象清单，并输出 `application_allowlist` 方法、清理 SQL/inventory digest 和已有持久 intent（如有）。新 operation ID 在首次 rebuild 写入 intent 时生成。执行脚本先记录外部操作意图，再进行破坏性步骤；不能到全部成功后才留下首个 checkpoint。plan 不暂停集成、不关闭 API、不改 SQL，不把“生成计划”标记为“已重置”。

开始维护时激活跨 workflow 的环境维护记录。其存在期间任何 promotion 都必须匹配该记录的 DB-ready SHA/digest，日常模式同样受约束；重建 job 完成后先释放执行锁，再单独运行 promotion，避免持锁等待另一个同锁 job。只有环境切换验收完成后才解除维护记录，不能靠某次 job 退出自动解除。

### 执行阶段

工具在专用临时 checkout 中连接目标项目，不能复用开发者工作目录里可能指向其他环境的 link。使用固定并已演练的 CLI；本项目当前依赖为 `2.109.0`，实施时核对实际 lockfile 和安装后的 `--help`，CLI 更新需重跑 remote-mode 演练。

hosted 的 plan/rebuild/resume/verify 均要求显式目标 CA。按 [Supabase PSQL 说明](https://supabase.com/docs/guides/database/psql)，从目标项目 Database Settings 下载 Server root certificate，并分别存入 `database-test` / `database-prod` Environment 的 `REBUILD_CA_CERT` secret。手动 workflow 以 `0600` 权限写入 runner 临时文件，通过 `REBUILD_CA_CERT_FILE` 指定绝对路径；脚本先验证 PEM X509 CA，再显式设置 `PGSSLROOTCERT` 和 `PGSSLMODE=verify-full`。缺失、非 CA 或格式错误立即停止，不读取开发者默认 `root.crt`，不回退到 system trust 或关闭验证。手动在受控 checkout 运行时也须明确设置该文件路径；本地 Docker/rehearsal 不使用 hosted CA 配置。

执行入口是受控白名单工具。以下仅为参数示例，不在本轮执行；连接凭据与项目映射由 Environment 提供，变量须已固定到审核后的值。prod 还须通过同 SHA 的 test 验收门槛：

```bash
node scripts/db-rebuild.ts --mode=plan --target=test \
  --source-sha="$SOURCE_SHA" --expected-project-ref="$TARGET_PROJECT_REF"

# 维护与清空授权已核验，且演练证明匹配当前方法、清单和完整迁移链。
node scripts/db-rebuild.ts --mode=rebuild --target=test \
  --source-sha="$SOURCE_SHA" --expected-project-ref="$TARGET_PROJECT_REF" \
  --confirm-project="$TARGET_PROJECT_REF" --confirm-destruction=DELETE_APPLICATION_DATA \
  --admin-user="$ADMIN_AUTH_UUID" --rehearsal-evidence="$REHEARSAL_EVIDENCE"

# 已有持久 intent 时仅恢复剩余阶段，绝不再次清理。
node scripts/db-rebuild.ts --mode=resume --target=test \
  --source-sha="$SOURCE_SHA" --expected-project-ref="$TARGET_PROJECT_REF" \
  --confirm-project="$TARGET_PROJECT_REF" --confirm-destruction=DELETE_APPLICATION_DATA \
  --admin-user="$ADMIN_AUTH_UUID" --rehearsal-evidence="$REHEARSAL_EVIDENCE"
```

停在 `intent/reset_started` 的 resume 还须提供与实时 catalog 匹配的 `--reset-recovery-evidence`，不能仅凭上述参数跳过检查。白名单入口不运行本地 seed。新基线包含 Provider 身份、能力目录、审核后的不可变法律内容及默认关闭状态；初始化脚本另行设置环境、管理员、current 指针和实际执行配置。GitHub production integration 默认也不保证应用 seed 或 API/Auth 配置，不能把 `seed.sql` 当成部署初始化入口。所有新 migration 都必须能在单个事务内执行；分支集成按文件开事务，不支持在其中使用 `CREATE INDEX CONCURRENTLY` 等非事务 DDL。[Git 集成迁移事务说明](https://supabase.com/docs/guides/deployment/branching/github-integration)

执行顺序如下：

1. 验证已完成冻结和维护阶段，核对目标连接、SHA 和 manifest 未变化。
2. 确认本项目旧任务 `ai-polish-retention-cleanup`、`ai-polish-stale-reconciliation` 已停用；白名单清理事务只 unschedule 这两个精确名称，不批量删除其他任务。核对指向旧业务函数的 Auth hooks、trigger、publication；遇到白名单之外的依赖即停止，先形成并演练受审计方案。
3. 工具核对 `application_allowlist`、cleanup SQL/inventory digest 和演练证明后，事务性清理清单中的旧应用对象/历史，再逐文件应用最初四条基线及第五至第八条追加迁移。没有成功完成时保持 Data API 关闭；不继续 bootstrap 或 promotion。
4. 读取迁移历史和 catalog，要求新基线全部已应用且不存在旧版本。`migration repair` 仅更改历史记录，不清业务对象；不得用它代替 reset，也不得把未执行的新 migration 标记为 applied。
5. 核对新 31 表、public 接口、函数 owner/search_path/ACL、RLS、外部 ID 约束、默认权限和扩展。特别核对 policy options、规则成员关系和默认项的复合 FK，不能残留只绑定一个 profile 的旧路由结构。核对无旧公开签名、legacy 表、悬空 cron 或意外新增角色权限。
6. 核实无环境记录时 `app_context.ready=false` 且业务写入被拒绝。owner 先核验 `app_api_owner` 安全属性、双向 membership 与 Auth/Storage 有效表/列权限，再以 `FOR KEY SHARE` 锁定未删除且未封禁的首管理员 Auth 目标；单事务创建 environment/新 instance、首管理员、已 seal 的法律 current 及关闭态 runtime，写 actor 为 `SYSTEM/NULL` 的初始化审计，目标管理员不作为 actor。提交后才 ready；相同结果重放不增加假审计。管理员 active generated FK `ON DELETE RESTRICT` 阻止在撤权前删除 Auth 用户，撤权后保留历史 UUID，派生键不进入 Admin DTO。
7. 确认无伪造用户接受记录。实际 Provider 默认值/profile/price/policy 按依赖顺序独立创建草稿；已有基线法律内容若不适合实际模型/接收方，先经 owner 创建并 seal 新 bundle/disclosures，再绑定 profile。所有候选配置和披露验证通过前不启用，不能为了开放列表替用户接受条款。
8. 配置 Data API 仅暴露新设计的 `public`，内部 schema 不暴露；核验平台持有的默认权限和新对象显式授权，不依赖默认值。
9. 初始化后注册新任务 `cv-ai-retention` 和 `cv-ai-reconcile`，分别调用私有 `ai.retention_cleanup(1000)`、`ai.reconcile(100)`，验证期间保持停用；迁移只创建函数，不提前注册可运行任务。对同名任务只能创建一次，并核验执行角色与私有函数权限。
10. 保存不含 secret 的 DB-ready checkpoint：operation ID、project、SHA、baseline digest、完整 migration manifest digest、`reset_method=application_allowlist`、cleanup SQL/inventory digest、instance ID、迁移/平台保留项验证结果与时间；它不等于应用已部署或 AI 已启用。

若 reset 后存在旧 migration history 或不在预期目录的自建对象，工具直接停止并输出清单。任何修正必须先在演练环境复现，再用受审计的补充步骤处理；不能在脚本中无条件 `DROP SCHEMA public CASCADE` 或删除平台 schema。

### 幂等和中断

reset 本身是破坏性的，不能将普通网络重试套在整个重建步骤上。跨 run 的 checkpoint 放在不被 reset 删除的受控持久记录中，包含计划、破坏步骤开始/结束、迁移完成、初始化完成、应用部署和验收 phase；不能只依赖某次 job 的临时文件。已有新 instance/history 或进行中的操作时，rebuild 拒绝再次清库，进入 verify/显式 resume；checkpoint 丢失不等于允许 reset。再次清空需要新的明确清空意图。

若连接在 reset 中途断开，先只读检查远端 migration history/catalog 和工作流日志，区分“未开始”“部分应用”“已完成但响应丢失”。部分应用不自动推进 release，也不从第一步无提示重新清库。工具应提供明确的恢复 phase，并在再执行前重新核验目标和已完成状态。

新基线已经落地后的修复只追加 migration。修复 SHA `S2` 必须保留原基线 digest，在 test 通过后，resume 比较 prod history，按顺序应用缺少的追加 migration 或重试幂等初始化，再生成对应 `S2` 的 DB-ready 记录；不得编辑已部署基线或因 SHA 改变而 reset。仅应用部署失败且 DB 已 ready 时，只重跑失败的部署 phase；release 已前移则保持不动，Pages/Vercel 分别补齐。外部记录必须区分部分部署状态，不能将一个 job 的成功当成两边都已完成。

## test 操作顺序

1. P1 安全工具先行合入默认分支并确认手动 workflow 可见且默认 plan；它不改变当前业务或自动部署行为。随后在完整重构候选上完成 P7 本地/CI 验证和远端模式演练，才进入 test 维护阶段。
2. 对 test 执行 plan，记录 Test project 和当前 main。按上一节暂停 Test Supabase 自动部署、Preview 自动发布、旧系统写入及目标 keepalive；关闭 Test Data API。
3. 合并完整重构到 main，固定实际 merge SHA 为 `S`，计算两种 digest，并确认 G1–G9 对实际 `S` 通过；PR head 的验证不能冒充合并结果验证。对 `S` 重新执行只读 plan，形成最终执行清单，合并前的预演不能代替它。冻结 main/release 后续推进直至此次 prod 切换完成，除非走 `S2` 修复流程；不能在执行中把 `S` 悄悄改为 main 的最新值。
4. 手动 rebuild Test project，参数只引用 `S` 和 test 的独立凭据；执行 owner SQL 验证、bootstrap 和关闭态初始化。
5. 部署精确 `S` 的 Vercel Preview，核对实际 Test URL/配置并保持维护访问和 AI off；同时在独立预览地址验证同 SHA 的 Pages 静态产物，不发布 prod Pages。部署到位后恢复 Test Data API，刷新 PostgREST schema cache，验证新 API；旧表名和 RPC 必须返回不存在或拒绝。
6. 用真实普通用户及管理员验收：登录、重新接受条款、当前格式本地文档/JSON 导入导出/草稿、明文/密文 CV、新 external ID、保存冲突、Admin/TOTP、配置发布和权限拒绝。使用合成旧输入确认 CV 5/6、缺失/未知版本及不完整结构被拒绝，旧单文档 key 不恢复；失败不改写有效当前文档、不触发云端保存。Admin 应能配置每个时段的多选项及默认项，并拒绝空集合/错误默认项。两个不同用户必须能证明互相隔离。
7. 在已配置测试凭据和审核内容的前提下，发布测试 Provider/price/policy，完成覆盖全部时段与候选的 readback，再只向 allowlist 开 AI。核对界面当前集合与 DB 时间一致，验收默认预选、非默认项选择、对应披露接受、失效刷新和明确重选；对实际支持的 Provider 安排有次数预算的受控 smoke，检查冻结 option/profile/price。取消、重试、HELD、迟到完成和响应丢失的故障注入以本地/CI 证据为准，不为 hosted 验收刻意制造未知计费，也不把付费调用放入普通 CI。
8. 验收通过后启用新 cron，恢复 Test Supabase main 监听、Preview 自动发布及 test keepalive。等待对当前 main 的同步，确认没有重新执行 baseline 或历史 migration；有旧排队部署时先取消它们。
9. 记录 `S`、baseline digest、完整 migration manifest digest、instance ID、策略/选项/默认项和逐项验证摘要、客户端格式与全仓兼容残留验收、测试结果及 Actions/部署链接，作为 prod 唯一输入。test 后续若有修复，必须生成新 SHA 并重新完成受影响验证；不得用未经 test 验收的修复 SHA 发布 prod。

精确的 09:00/18:00/跨日切换由本地和 CI 的可控时钟及真实 DB 事务用例证明；hosted test 使用真实 DB 时间，不修改线上时钟或开放时间覆盖参数。A/B/C 是测试示例；真实配置可使用已接入的 DeepSeek、MiMo、Gemini，但每一项都必须有完整发布的 profile、价格、当前披露及验证，不能以一个 Provider 名称代替配置。

配置 Gemini 时使用 Google AI Studio API key，凭据引用为 `AI_PROVIDER_KEY_GEMINI_*`，endpoint 固定为 `https://generativelanguage.googleapis.com/v1/interactions`，当前披露模型为 `gemini-3.8-flash`。启用真实简历处理前，由 owner 在对应 Google Cloud project 核验活跃 Cloud Billing 及数据分享、dataset/feedback 设置，并记录核验时间与项目身份，不保存 key。不能从 key 文件名、模型可访问、HTTP 200 或 Admin readback 推断付费服务条款已生效。Google 免费服务可能使用输入/输出改进模型并人工审阅；付费服务、区域例外及日志/缓存边界见[披露来源](../web/src/content/legal/ai-terms-sources.md)。合成文本 smoke 只验证接口和结算，不证明该项目适合处理真实个人信息。`store:false` 关闭 Interactions 可检索历史，不是全局零留存或零训练配置。

Supabase required checks、PR preview branch 和自动 production deployment 的设置要在 P1 分别核对。即使生产监听暂停，基于旧历史的 PR preview 仍可能运行新基线并失败；本次需要暂停该预览的迁移执行或用已重建的临时预览验证，不能复用旧 preview 数据库直接跑新基线。若 required check 阻止合并，应提前记录只针对该集成的一次性受控处理、替代本地/CI 证据和恢复步骤，脚本不自动放宽 branch protection，也不全局关闭其他检查。

恢复 Data API 后，它对所有持有效凭据的调用者恢复访问，并非只向维护人员开放。此时全部对象必须已具备最终 ACL/RLS、实例/契约检查；维护页和 Vercel Deployment Protection 只能约束应用入口，不能作为数据库隔离证明。通过重新打开旧页面/旧请求验证拒绝路径，不能仅访问新界面验收。

## prod 操作顺序

1. 读取 test 对 `S` 的验收记录，校验它来自预期 workflow/job 和 artifact，而非接受一个手工填写的“已测试”布尔值。确认 `S` 可从 origin/main 到达，当前 release 是 `S` 的祖先，符合现有 promotion 的前移规则。
2. 对 prod 执行 plan，核对 Production project 与 test 不同。冻结其他 promotion，暂停 Production Supabase 自动部署、prod keepalive；应用和 Pages 进入维护边界。
3. 按统一冻结顺序关旧 AI gate、等待请求、停旧 cron、关闭 Production Data API 并确认写入静止。release 此时仍可指向旧代码，但旧服务端和浏览器已无法写旧业务库。
4. 从 `S` checkout 重建 prod，完成新基线、migration history、权限和 owner 初始化。prod 独立生成 external IDs、instance ID、membership 和运行配置，不导入 test 的用户/账本/报告/接受记录。AI 保持 disabled。
5. 使用 owner 连接完成关闭态 DB 检查，保存“prod DB ready for S”checkpoint。Data API 继续关闭。
6. 通过增加了切换门槛的 Promote Release，`source_ref=S`；必须读到目标 project、SHA、两种 digest 一致的 prod DB-ready 记录才放行。检查 release 实际前移到 `S`，Vercel Production 与 Pages 的源码、实际环境与项目连接一致；若某集成未自动触发，执行预先验证的精确 SHA 部署。Production Supabase 自动部署仍暂停，避免与手动重建并发。
7. 等待应用全部到位后，在维护边界内恢复 Data API，检查 schema cache、新 RPC、普通角色拒绝路径、CV 与 Admin；确认 Vercel 和 Pages 的本地读取/导入均只支持当前格式，旧 key 不恢复、旧云端队列不重放。仅部署成功不等于数据库权限和客户端格式验证完成。
8. 初始化/验证 prod 自身各时段的选项集合、默认项、Provider/profile/price 和对应法律目标；所有候选均须通过验证，包含未来时段和非默认项。先验证 AI 关闭态，再设置 pointer、取得当前环境 readback，通过 Admin TOTP 仅向自己的 allowlist 开放。用 prod 生成的 option ID 验收用户选择和对应同意，再按受控 smoke 验证实际选择及冻结结果；不复用 test 的接受记录或配置 ID。
9. 启用新的 cron，移除维护边界，恢复 Production Supabase 对 release 的自动部署和 prod keepalive。此时 release 必须已是 `S`；不能在 release 仍指向旧 migrations 时恢复监听。
10. 验证一次当前 release 的集成同步，要求基线被识别为已应用；记录实际权限/功能检查。日常后续发布重新采用“新增 migration → main/test → promotion/release/prod”的流程。

无需把业务清库永久塞进 Promote Release，也无需删除并重建 release 分支或强推 main。自动部署恢复时的条件是远端 history 与该监听分支的 migrations 一致。

## 失败恢复

| 失败位置 | 处理 |
| --- | --- |
| preflight 或冻结前 | 不执行 reset；修正目标、版本或配置差异，原环境维持现状 |
| 已冻结但 reset 未开始 | 可按记录恢复旧 API/任务/部署，必须确认没有部分 DDL 和未完成写入 |
| reset 或 migration 中断 | 保持维护和 Data API 关闭；读取实际 history/catalog，基于 checkpoint 恢复；不 promotion、不自动整库重试 |
| 新 DB 完成，初始化失败 | verify 确认实际状态后，resume 幂等初始化；不得因 bootstrap 失败再清一次库 |
| 新 DB 完成，promotion/build 失败 | prod 保持关闭态，按 checkpoint 补齐失败部署；若需 `S2`，先 test 验收并在 prod 追加缺少的 migration/初始化再部署，保持原基线不变 |
| release 已前移但 Pages 或 Vercel 失败 | 保持维护和 AI off，只重跑失败产物的同 SHA 部署；不得再次 reset 或以未核验的新 main 代替 |
| 新应用关闭态验收失败 | 保持维护/AI off；修复接口或权限并重新验证；已接受的业务数据丢弃不授权更多平台删除 |
| AI 启用后失败 | 先紧急关闭 AI gate，保留 complete/cancel/finalize；CV/Auth 可在验证安全后继续服务；沿新基线向前修复 |
| 必须回旧架构 | 作为新的恢复操作重新建立旧 schema、旧初始化和匹配旧代码；旧数据仅在另有可用备份时恢复，单纯回滚 Git 不恢复 DB |

现有 promotion 明确拒绝 release 向后或侧移。因此不能把“再运行一次旧 SHA”写成默认回滚；如确需旧架构恢复，需要独立流程。首选同一新基线向前修复，避免重新引入兼容模式。

## 发布完成记录

最终记录分别包含 test 和 prod 的项目身份、实际 SHA、baseline digest、完整 migration manifest digest、migration history、database instance、API schema/权限、初始化管理员、发布配置 external IDs、各时段选项和默认项、全部候选的验证/readback 摘要、用户选择与对应同意验收、客户端当前格式及旧输入拒绝验收、全仓兼容/legacy 清理证据、各应用部署 phase、受控 smoke 和 cron 状态。密钥只记录引用名及“存在/已验证”，不输出值。

确认旧 `public` 业务表、旧 RPC overload、旧 aliases、历史 admission/cutover、旧任务和旧权限入口均已退出；本地旧格式 parser、转换器、storage key 读取及关联测试/工具/文档均按计划完成清理。确认 ordinary/authenticated/service_role 均不能直接写业务基表，Admin 界面不能读 CV 正文，旧浏览器云端缓存没有被自动上传。不能为通过发布验收临时恢复兼容分支。

恢复自动部署后禁用此次一次性 destructive 入口，或将其保留为默认只读且需要新的明确清空意图的维护工具。后续新 migration 正常追加；不再编辑已部署的新基线，也不因为 test 数据少而在每次 push 自动 reset。

## 官方依据

- [GitHub Integration](https://supabase.com/docs/guides/deployment/branching/github-integration)：分支部署、migration history 对齐、production 默认不应用的配置/seed。
- [CLI reset](https://supabase.com/docs/reference/cli/supabase-db-reset)：远端 `--linked`/`--db-url` 和 custom role 保留边界。
- [Data API security](https://supabase.com/docs/guides/api/securing-your-api)：Data API 开关、显式授权、schema 与 RLS 的独立职责。

实际执行前核对当前平台界面与固定 CLI 能力；本文不宣称已验证任何线上 project 的配置或可重置状态。

## 实施后的 workflow 凭据与恢复证据

`REBUILD_STATE_TOKEN` 使用限定到本仓库的 GitHub fine-grained token，授予 repository Variables 的 Read and write；无需赋予 Contents 写权限或数据库权限。把它设置为重建 workflow 和 Promote Release 均能读取的 Actions secret。持久状态由该 token 读写仓库级 `DB_REBUILD_STATE_TEST/PROD` 变量，不能假设默认 `GITHUB_TOKEN` 具有 Variables 权限。`PROD_SUPABASE_PROJECT_REF` 必须配置，日常 promotion 同样核对 Pages 的 Supabase URL。promotion 在构建前及真正推进 release 前实时读取持久状态，不使用 workflow 启动时的 vars 快照；读取失败或结果不完整即停止。

托管初始化统一经 `db-rebuild.ts` 的受控阶段运行；独立 `db-initialize.ts` 只允许 `--local`。`resume` 包括已验收后的追加修复，每次都重新进入维护状态，要求目标身份、破坏性操作授权及 API/集成维护已验证。演练证明须包含 `method=application_allowlist`、`cleanup_sql_digest`、`retired_inventory_digest`、`cli_version=2.109.0`、两种 migration digest 及平台保留/恢复通过标记；持久 intent 的 `reset_method` 与两个清理 digest 也必须匹配当前 checkout。

原清理停在 `intent/reset_started` 时，先运行只读 `plan` 获取实时对象清单和 `reset_catalog_digest`；完成平台保留项检查后提交恢复证明，绑定 `operation_id/project/source_sha/baseline_digest/migration_manifest_digest/reset_catalog_digest` 以及相同的清理方法/SQL/inventory digest，明确 `reset_completed/platform_preservation_passed=true`。证明必须与操作记录和实时 catalog 一致，且不存在旧 public 表或意外 public 函数；恢复仅应用缺失迁移，绝不重复清理。checkpoint 丢失但新基线已存在时直接拒绝 rebuild/resume，不推断清理授权。

手动 workflow 的 `rehearsal_evidence`、`reset_recovery_evidence` 和 `acceptance_evidence` 均接受 JSON 证明，分别写入 runner 临时文件后交给脚本校验。G3 证明必须满足 `source_sha` 等于当前完整提交 SHA、`old_chain_passed=true`、方法/清理 SQL 与 inventory digest/两种 migration digest/固定 CLI/平台保留与恢复结果全部匹配。先提交候选 `S`，再以 `S` 复跑 G3 并传入生成的 JSON 或 CI artifact；当前未提交工作树的本地证明不能冒充未来发布 `S` 的证明，也不把包含自身 SHA 的证明提交进同一 commit。证明内容不得含连接密码、API key 或用户正文。证明缺失/失配时保持维护状态；验收完成后才保存 accepted 并解除维护。

## 本轮本地验证与线上执行的分界

完整命令、结果和本地证据边界见[本地验收记录](database-rebuild-verification.md)。本轮交付的是工作树中的实现和本地验证，不是可直接用于线上授权的候选提交证明。

当前代码已提供新 schema/RPC、Admin 与客户端、初始化脚本及仅手动的重建入口，并完成本地 Auth/Data API、角色权限及 Admin TOTP 浏览器验证。本轮没有执行本手册的 test/prod 操作，也没有触发 promotion 或线上部署。G3 已取得本地独立演练证明 `tmp/remote-rehearsal-proof.json`：旧 60 条到四条基线的白名单清理、迁移后中断与重复 resume、同 instance 追加第五至第八条迁移、12 类平台指纹相同、缺 checkpoint（包括同时缺 history）时拒绝 rebuild，以及构造 `reset_started` checkpoint 后凭匹配方法/清理 digest/实时 catalog 的证据 resume。后者明确为 `TEST_CONSTRUCTED_STATE_ONLY_NO_REPEAT_RESET`；`constructed_checkpoint_recovery_passed=true`，而 `checkpoint_loss_recovery_passed=false`，没有声称实测 kill 在清理窗口。恢复保留 instance、audit 哨兵及平台指纹，不重复清理。不得把原生 reset 的失败观察或普通 local reset 当作平台保留证明；线上执行前仍须核验实际 merge SHA 对应的最终材料。

切换验收时还须检查当前条款页面确实来自目标环境的 legal_current，Provider 切换只接受所选披露，Users 的管理员资格列表展示正确成员 revision，以及旧页面/切换账号后迟到的 CV 或条款操作被实例/账户 guard 拒绝。Admin 未配置、未登录和错误态的返回编辑器链接均为普通完整导航并设置 no-referrer，避免管理路径进入公共遥测。
