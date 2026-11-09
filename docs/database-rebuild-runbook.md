# 数据库重建与发布手册

状态：第二轮实现与本地验收完成，结果见 [验证记录](database-rebuild-verification.md)。尚未执行 test/prod SQL、重置、配置变更、promotion 或发布。本文件只描述未来受控切换流程。

test 的现场盘点、待办与后续逐步实录统一保存在 [test 重建执行记录](database-rebuild-test-execution.md)。本手册维护可复用流程；执行记录保存当次事实，不能用计划或本地演练结果代替线上完成结果。

## 目标与保留项

继续使用已有 Supabase 项目。test 监听 main，prod 监听 release；两者应用同一份提交及新迁移清单。保留 GitHub 定时 keepalive Action 和 public.keep_project_active()、GitHub SSO/OAuth/回调/重定向、API 与 Git 集成配置。

用户已允许丢弃业务数据及 Auth 用户数据。现有重建工具仍采用经过演练的应用对象白名单清理，不直接 DROP 平台 schema；允许删用户不等于允许删除 OAuth/SSO 配置。若实际选择清理 Auth 用户，必须单独核对用户数据与配置表边界，不把原生 hosted db reset 当作保留 SSO 的保证。

本次 test 优先使用现有工具保留 Auth、Storage 和平台配置，重建应用对象。无需为了“彻底重建”额外删除账号；若现场改变这一选择，先更新范围、管理员建立方式和验证材料。

## 操作分工

用户亲自完成必要的登录验证和数据库凭据安全输入。若数据库密码未知，先盘点连接影响，再由用户在官方页面重置；已有可用凭据直接复用。此次一次性重建从操作员电脑执行，不申请额外 GitHub 状态令牌，不建立 database-test/database-prod Environment。

执行者准备本地连接与记录目录、下载并核验目标 CA、核对已有管理员身份、整理证明，代办维护开关、Vercel Preview 环境变量/Secret、部署与验收。凭据使用用户授权的安全来源，不要求用户手工拼 URL 或复制 SQL；如需本人登录或安全输入，再按实际界面交接。合并 PR、暂停 test 服务、清理 test 应用数据及部署须处于明确的 test 切换授权范围内，prod 重建另行授权。

## 执行记录与证据保管

维护开始前建立当次记录，逐步追加时间、操作者、目标、准确命令、执行前后状态、退出结果和证据位置。时间使用带时区的 ISO 8601；维护窗口同时标注北京时间。统一使用 `NOT_STARTED`、`RUNNING`、`PASS`、`FAIL`、`BLOCKED`，只读盘点使用 `OBSERVED`，非必需而未执行的项目使用 `NOT_RUN` 并说明范围，不把“没看到报错”当作通过。

每次本地 plan/rebuild/resume/verify 保存调用时间、执行模式、实际 checkout SHA、目标项目、操作标识、检查点与结果。失败也留记录，包括不确定结果、检查方式、恢复证据和再次执行的理由。连接信息不写入命令参数或日志；授权与维护确认只是工具断言，不能代替真实的旧应用、Data API 写入口和任务已暂停/排空的证据。

脱敏记录与经审查可公开的证据放入仓库 `docs`；原始证据含个人信息或其他敏感内容时，由项目所有者保存在受控位置，记录非敏感引用和 SHA-256。禁止保存密码、连接串、token、service-role key、AI key、Cookie、用户简历或会话。管理员用非敏感账号标签关联受控 UUID 记录。

当前 DB CI 的 G3 artifact 保留期为 7 天。执行者须及时下载原始 artifact、校验 ZIP 与 proof 的 SHA-256，并将本地检查点、事件日志、plan/verify 输出、平台保留对比及人工验收一起长期归档；仅有 run URL 或被忽略的临时目录不算完成。脱敏副本和原始证明分别计算摘要，不能修改原 proof 后沿用旧摘要。维护结束前整理实录并提交仓库；工作中从独立记录工作区保存，执行 hosted 工具的候选 checkout 必须保持干净。本地检查点用于核对执行阶段，不是数据库备份。

## 本地开发和验证

使用仓库固定 Supabase CLI 2.109.0。每次执行前使用 --help 核对选项；不使用本机保存的 hosted link 作为操作目标。普通开发仅使用显式 --local 与本机 Docker。

新基线文件由 CLI migration new 创建，按 schema/stage 顺序存放 migrations。supabase/baseline.json 明确冻结基线列表，全部文件 hash 组成 baseline_digest；完整当前迁移链形成 migration_manifest_digest。本轮移除 TOTP、增加展示名及解耦数据处理说明，均按用户授权直接重写原 15 条迁移并重建本地测试库；正式发布后基线不再改写，修复以追加文件演进。此前基线摘要和 G3 证明保留为历史证据，不能用于新候选的线上切换。

本地空库重建后运行 SQL 角色/约束测试、真实 Auth/Data API 集成、隔离库两连接竞态和 Admin 浏览器测试，再做 typecheck/lint/服务端与静态构建。合成 Auth/session 数据只能出现在明确 disposable fixture；浏览器验证真实普通登录即可执行管理员读写，并验证无权限或失效会话仍被拒绝。应用不设计 TOTP 绑定或 AAL2 门槛。

普通本地 seed 不含生产密钥、生产用户或预置同意。adapters、审核后的条款与 AI 默认关闭状态随 migration；真实服务配置通过 Admin 的普通保存建立。

## 本地执行

scripts/db-rebuild.ts 提供 plan、rebuild、resume、verify。脚本在操作员电脑执行，显式 `--target=test` 或 `--target=prod` 连接目标 Supabase；`--local` 仍只代表本机 disposable Docker 库，不能用它操作 test/prod。连接使用显式目标 URL 和 CA、完整 TLS 验证，不从开发 .env 或保存的 hosted link 推断目标。连接方式以 [Supabase 官方说明](https://supabase.com/docs/guides/database/connecting-to-postgres) 为准。

每次显式指定绝对 `--state-dir`，同一环境始终使用同一目录中的检查点与追加日志，由本地互斥锁防止并行。目录与文件限制为当前用户读写；不得将记录目录放在会自动清理的位置，结束后另存一份。检查点包含项目、SHA、迁移摘要、清理方法、当前阶段和实例，日志保存实际执行事件与脱敏结果。非正常退出若留下锁，先确认原进程已经结束、归档锁和检查点，再由操作者移除孤立锁，以只读 plan 核对实际 catalog/history；不能自动按超时删锁或换目录重跑清库。

事件日志保留检查点与结果摘要，plan/verify 的完整 JSON 标准输出另存为私有文件，并记录命令退出码；实际旧对象清单、每文件摘要和契约检查以这些输出为准。文件采用 0600 权限。不要将包含凭据输入或会话的整个终端历史作为日志上传。

目标映射通过本地进程环境 `REBUILD_PROJECT_REF`、`REBUILD_OTHER_PROJECT_REF`、`REBUILD_SUPABASE_URL` 显式提供，连接秘密使用 `REBUILD_DATABASE_URL`，CA 文件使用 `REBUILD_CA_CERT_FILE`。`REBUILD_EXECUTION_AUTHORIZED`、`REBUILD_MAINTENANCE_VERIFIED` 仅在实际授权、停写验证后对当次进程设为 true，不需要保存为 GitHub 变量。不要把数据库密码放入 shell history 或实录。

只读 plan 可在干净的评审候选 checkout 上预检。实际 rebuild/resume 必须绑定完整 SHA、干净 checkout 和已进入 origin/main 的候选，核对演练证明及显式目标/清理确认；从本地执行不跳过这些检查。prod 另以 `--test-state` 指定本地已 accepted 的 test 检查点，核对另一项目、同 SHA 和同清单。网络断开后先 plan 和 catalog/history 检查，再决定 resume，不能因为结果不确定重复清空。

检查点已记录实例时，resume/verify 要求实际实例完全一致；实际实例缺失或改变时停止，不能覆盖旧记录。plan 仍可只读展示两者，供查明是否使用了旧归档或错误的恢复材料。

hosted 初始化由同一次本地重建命令的受控阶段完成。独立 db-initialize.ts 仅允许 --local，输入已有且有效的 Auth 管理员 UUID。初始化同时建立环境实例和首管理员；不猜用户、不自动接受条款、不自动启用 AI。jobs 注册后保持 inactive，待验收完成才启用。

命令示例仅供准备，尚未执行。先通过安全来源向当前进程提供上文连接与映射变量，再设置候选 SHA、私有绝对目录、管理员 UUID 和证明文件路径；真实值不进入 shell history 或实录。以下 plan 不写数据库：

```bash
node scripts/db-rebuild.ts \
  --mode=plan --target=test \
  --source-sha="$REBUILD_SOURCE_SHA" \
  --expected-project-ref=uvitgcfqnciahvakqhnv \
  --state-dir="$REBUILD_STATE_DIR"
```

最终材料、授权和维护就绪后，才执行一次：

```bash
node scripts/db-rebuild.ts \
  --mode=rebuild --target=test \
  --source-sha="$REBUILD_SOURCE_SHA" \
  --expected-project-ref=uvitgcfqnciahvakqhnv \
  --state-dir="$REBUILD_STATE_DIR" \
  --confirm-project=uvitgcfqnciahvakqhnv \
  --confirm-destruction=DELETE_APPLICATION_DATA \
  --admin-user="$REBUILD_ADMIN_USER" \
  --rehearsal-evidence="$REBUILD_REHEARSAL_EVIDENCE"
```

后续 verify 复用相同目标、SHA 与目录；需要恢复时将 mode 改为 resume，保留确认和证明参数，按实际情况增加 reset-recovery-evidence。验收完成后的最后一次 resume 增加 acceptance-evidence。prod 使用独立目标与凭据，另外传入 `--test-state="$REBUILD_STATE_DIR/test-uvitgcfqnciahvakqhnv.json"`。允许使用经摘要核对、字节一致且保持私有权限的归档副本；禁止手写成功状态或把 test 文件改绑为 prod。

## 发布前材料

- 本次完整提交 SHA；baseline.json 对应文件及全链 hash，当前迁移历史。
- 本地测试与两种构建通过记录；当前实现的角色允许/拒绝结果。
- 独立 disposable remote-mode 演练证明：旧应用对象清理、平台指纹、迁移后中断、重复 resume、检查点丢失拒绝/检查后恢复。
- test/prod 项目映射和连接身份、CLI/Postgres 版本、Data API exposed schemas、RLS/GRANT、Auth/OAuth/SSO、cron 及 Git watch 配置盘点。
- 维护暂停、发布和失败恢复的执行人及窗口；真实 AI key 仅记录引用名和存在状态。

演练证明绑定实际候选 SHA 和两类清单摘要。工作树旧证据、上一轮十条链、仅 native local reset 或手工构造窗口不能冒充新基线的完整 hosted 模式证明。证明不得包含 key、访问令牌、用户正文或连接密码。

不通过 GitHub Action 执行 hosted 重建。普通 CI 继续在隔离环境验证迁移和恢复；一次性清理、迁移和初始化由本地命令完成。合并前可先只读预检，合并并冻结实际提交后再次核对 plan，不能用早期预检代替最终目标和清单确认。

PR 的 synthetic merge SHA、PR head SHA、最终实际合并 SHA 分开记录。当前 DB CI 只有 pull_request/workflow_dispatch 触发器，合并后须手动运行实际 main SHA 的 DB CI，核对 run 的 head SHA 和新 G3 `source_sha` 均为该提交。即使迁移摘要相同，也不得给旧证明改绑 SHA。执行期间 main 如推进，继续锁定已核验 SHA；若更换候选，则重新核验其门禁。后续实录提交 SHA 单独记录，不能因为保存实录而把发布候选自动改成最新 main；prod 继续显式使用 test accepted 的 SHA。

keepalive Action 继续对 test/prod 调用同一个只读 keep_project_active RPC，以 HTTP 成功判定调用完成，不再依赖无业务用途的返回类型。这样 test 升级、prod 保持旧库期间也继续防回收；切换后的两边分别核验，不为过渡升级 prod 函数。

## Test 切换

1. 准备本地连接、CA、绝对记录目录和管理员；记录 test 范围及合并/维护/清理/部署授权。只读预检目标，保存 Auth/Storage/OAuth、重定向、Git 与应用集成、任务、Vercel Preview 变量名/作用域和部署的原始配置摘要。
2. 暂停 test Supabase Git 集成的自动部署、Vercel Preview Branch Tracking；另行实施并验证旧应用及直接 Data API 写入的维护隔离，停止应用任务并排空在途。暂停新构建不等于旧站和 API 停写。记录实际隔离方法、验证结果、恢复方式；release 和 prod 保持原状。
3. 合并已批准 PR，冻结实际 main SHA，手动运行并校验同 SHA DB CI 与 G3；下载、核验并归档证明。不得把 PR 的合成提交直接当作最终部署提交。
4. 本地执行最终只读 plan，复核目标、Postgres 版本、迁移历史、旧对象清单与本地检查点；另做独立只读平台保留盘点，保存实际 hosted 项目的 Auth/Storage 对象与权限、OAuth/回调配置等脱敏基准。plan 不输出这些平台指纹，CI G3 的平台演练指纹也不能代替真实项目的前后核对。意外对象、版本不符、维护未生效或材料不匹配时停止；不能修改 guard 绕过。
5. 确认维护与清理范围后执行一次 application_allowlist rebuild。按顺序应用新基线并核对历史、角色边界和 current contract。不得将未执行文件通过 migration repair 标为已应用。结果不明时转入下节恢复流程。
6. 同一 rebuild 命令会使用已确认的有效 Auth 用户初始化 PREVIEW 和首管理员，生成新的 database_instance_id。保留实际初始化结果，确认 AI 关闭、jobs inactive。管理员 UUID 必须在执行前准备好；若另获授权清理用户，先完成用户清理并通过真实 Auth 建立有效管理员，再执行 rebuild，不能等 DDL 完成后才准备账号。
7. 部署同 SHA 应用并只向验收路径开放，记录 Vercel deployment ID、源码 SHA、域名及环境变量引用。检查原生 Supabase 集成提供的变量是否符合最新应用名称，不能只根据普通变量列表判断缺失。核验客户端发现实例改变后拒绝旧 ID/缓存，不自动重传旧云端草稿或同意记录。
8. 在 Admin 核实/维护实际接收方的数据处理说明，保存真实接入配置（内部名及用户展示名）和价格，并明确选择覆盖该接入的说明；再设置候选时间规则、开放范围/额度。检查 endpoint、密钥引用、有效会话和管理员资格。技术字段与说明不做自动匹配，适用性由管理员核实。
9. 验收登录、CV v7、Admin 有权/无权访问、当前条款/准确链接、显式选择与同意、取消/额度/费用、多币种和手机/宽屏布局。AI 的启用范围与付费 smoke 单独记录；未授权的调用标记未执行，不冒充验收通过。
10. 使用绑定实际部署 SHA、清单和实例的 acceptance evidence 在本地执行最终 resume，确认检查点为 accepted；只读 verify 不会推进为 accepted。未接受阶段的 rebuild/resume 会 register_jobs 并使任务 inactive，因此应在最终接受之后，明确启用需要的 `cv-ai-reconcile` / `cv-ai-retention` 并核验实际状态与运行结果。accepted 后只运行 verify，不再通过 rebuild/resume 更改本次状态或重新停用任务。
11. 只有在历史与监听分支文件完全一致后，才恢复 test Git watch、应用自动部署和写入口；分别核验 test/prod keepalive 都正常。清理当前 shell 的凭据与确认变量，核对集成、Auth/Storage/OAuth 保留结果，关闭维护窗口并归档实录、异常和 prod 待办。

## Prod 切换

prod 只接受同 SHA、同基线/完整清单且已通过 test 的材料。重复上述维护、清理、初始化 PRODUCTION、应用部署与验收流程。prod 独立生成实例、用户授权和服务配置，不复制 test 的用户/接受/请求/管理员数据。

执行前从已完成的 test 实录创建独立 prod 记录，保留操作和经验，清空完成状态、run/operation/instance、授权、凭据及用户选择，并重新盘点 prod 现场。验收前为修复 test 问题更换候选时，prod 必须使用最后实际通过 test 的提交与材料。accepted 后如又需更换候选，暂停 prod 切换，重新准备和核验材料；不能用 resume 或手改文件给既有成功状态换绑 SHA。

正常 Promote Release 不读取此次重建的本地检查点，也不依赖额外状态 token。prod 维护窗口由操作者控制，数据库尚未 DB-ready、与待发布 SHA/清单尚未核对时不触发 promotion。一次性重建的操作顺序与结果记录在实录中，不把临时重建状态变成日常发布的长期依赖。

不删除 release 分支、不强推 main，也不把清库塞进日常 Promote Release。prod 正常发布仍为 main/test 验收后 promotion 到 release；历史与监听分支同步后才恢复集成。

## 失败与恢复

| 状态 | 处理 |
| --- | --- |
| 未开始清理 | 保持维护，修正候选代码/材料并重新验收 |
| reset_started 结果不明 | 先 plan 和 catalog/history 检查，用绑定实时清单的恢复证明推进；禁止盲目重清 |
| 基线部分应用 | 只补缺失文件，保留同一实例与本地检查点 |
| DB ready、应用发布失败 | 重试同 SHA 应用发布；如需代码/DDL修复，先在 test 验收并追加迁移 |
| 配置/价格/条款不匹配 | AI 保持关闭，在单个业务保存事务修正，不恢复旧版本或默认 fallback |
| 已发送但结果未知 | 保留 HELD 与额度，不猜测免费；迟到事实仍可结算 |

已进入 DB-ready 后，不能因为 SHA 或应用构建失败再次清库。后续追加迁移不得改写已应用历史。验证结束后的本地证明与线上执行记录分开，未实际执行的步骤不标记为完成。
