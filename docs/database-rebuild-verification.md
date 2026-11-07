# 数据库重构本地验收记录

日期：2026-11-07。分支：`codex/database-rebuild`。本记录保留 PR 创建前的本地实施和提交准备期验证；未修改 test/prod 数据库或触发线上发布。后续 feature 分支推送、PR CI 和 Relay 评审修复已由用户单独授权，其当前结果以 PR 的精确 head、checks 和评审记录为准。已按授权完成初次两次真实调用、DeepSeek Responses 切换后的两次复验、Gemini 一次验收，以及 MiMo 协议收紧后的一次复验；共六次生成，均仅使用合成文本和独立本地数据库。

这些测量在本地未提交实施期及分批提交准备期捕获，原评估基线为 `ccbeb1a4fc2baba9dbc2c15a4ba183a1be3558aa`；它不是新实现的候选或发布 SHA。代码随后分批提交，不改变历史测量的来源身份。[证据快照](evidence/database-rebuild-local.json)仅用于审查，不能将旧测量改填新 SHA 冒充候选验证；未来发布必须在候选提交或实际 merge SHA 上重新生成证明。

## 已交付的实现

- 删除原 60 条 migrations，替换为四条冻结基础迁移、第五条 owner 审计/管理员 active Auth FK/角色检查增量，以及第六条延迟策略图约束权限修复、第七条 DeepSeek Responses 和新法律目录切换、第八条 Gemini 官方 Interactions 和三家新法律目录。共 31 张私有业务表、3 个 public invoker view、50 个 public RPC；当前契约为 `cv_app_db_1`。
- 内部 bigint 主键、外部短 ID、RLS、显式 ACL、空 `search_path` 和独立 `app_api_owner` 已按个人 Supabase 规范实施。4 个私有 Auth 读取桥接函数使用 postgres owner，仅向 app owner 开放，返回安全投影；这一权限边界及原因见[设计](database-rebuild-design.md)，不是通用 Auth/Storage 表访问授权。
- CV、条款、Admin、AI 和运维工具全部改用新接口。时间段决定可选 Provider 集合和默认项，用户选择本次目标；reserve 冻结选项、配置、价格和精确披露，最多两次 attempt，不跨 Provider 回退。
- 旧配置解析、RPC wrapper、执行链、部署登记、价格回填、本地 CV 5/6 转换、旧 JSON 导入、旧 storage key 和草稿升级逻辑已删除。当前 CV v7、加密 envelope v1 和草稿 `cv_draft_1` 各自只有一个接受格式。损坏或不支持的内容不能被当作空文档覆盖。
- 云端写入固定账户 token、数据库实例和编辑 revision。跨账户迟到结果不能更新当前表单；后台刷新不推进未保存编辑的 revision；不确定 create 保留同一操作 key 与加密 envelope，草稿保留原 base revision。
- 新增手动重建、只读 plan/verify、持久 checkpoint/resume、环境与 SHA 校验、promotion 维护门槛。hosted/rehearsal 只允许清理明确列出的应用对象，未知对象、依赖或历史失败时回滚并停止。
- 保留 GitHub 定时 keepalive Action 和新基线中的同名 RPC；Action 已按当前唯一返回值 JSON `true` 校验，不再误判正常响应为失败。

当前接口说明见[数据库契约](database-contract.md)，操作与复现命令见 [web 开发说明](../web/README.md)。P0–P6 与 P7 的本地部分已完成；P7 的实际 GitHub CI、P8–P10 线上阶段尚未执行。

## 实际执行的检查

| 检查 | 结果 | 主要范围 |
| --- | --- | --- |
| `pnpm test`；补充工具测试 | 78 文件、954 项 web 测试，16 项工具测试通过 | 当前格式拒绝、账户/实例/revision、Admin、三家选择/精确同意、严格 Responses/Interactions 协议、模型不匹配拒绝、AI 结算、工具误环境、目标 CA、迁移只追加和恢复保护 |
| `pnpm typecheck`、`pnpm lint` | 通过 | web 与 scripts TypeScript；ESLint 无错误或警告 |
| `supabase test db --local` | 7 文件、130 项断言通过 | RLS/权限、领域事务、配置与时段资格、账本、金额溢出、初始化、审计及延迟校验 owner/ACL |
| 独立 privileged owner 负向 fixture | 45 项断言通过，事务回滚 | 危险角色属性/成员、Auth/Storage 表及列权限、删除与撤权边界 |
| `pnpm --filter web test:db` | 4 文件、12 项通过 | 真实本地 Auth/Data API、当前 DTO、CV/条款、真实 DB AI 生命周期、三家配置的 authenticated 提交/回滚，以及 USD/CNY 混合价格冻结、结算和统计 |
| `db-ai-concurrency.ts --run-disposable` | 6 个场景通过 | 独立临时库、多 SQL 连接、reserve 去重、单次传输权、终态与聚合只结算一次，以及等锁跨时段和 UTC 日界线；临时库已清理 |
| 普通 Chromium E2E | 2 项通过 | 本地编辑、恢复、排序、语言与导出；Admin 路径不进入公共遥测 |
| Admin Chromium E2E | 4 项通过 | 真实本地 Auth、TOTP、高风险权限、profile 身份创建、管理员资格/revision、当前中英文条款；版本草稿/发布链另由 SQL 测试验证 |
| Provider-choice Chromium E2E | 1 项通过 | 登录→切至非默认 MiMo→仅接受该披露→重新确认 READY→真实 Next fake API→预览结果 |
| `test:admin-build-modes` | server→static→server 通过，静态扫描 138 文件 | API 路由恢复；静态产物不含服务端密钥、Admin 或 AI 执行代码 |
| HTTP smoke | 两种通过 | fake 全链路的选择、安全投影、执行、重放、旧 generation 拒绝；无后端凭据的 AI 关闭态构建及 503 响应 |
| catalog / CLI 生成类型 | 通过，类型 diff 0 bytes | 31 表全部 RLS；public 业务表为 0；不安全函数、owner/ACL、直接表写入异常均为 0；history 恰为新 8 条 |
| keepalive Action 与 RPC | 本地三次请求通过，10 类错误输入拒绝；该 workflow 的 actionlint 通过 | 使用真实本地 publishable key 匿名调用，并执行 Action 原步骤；不带用户 Bearer，不触发远端 Action |
| 显式真实 Provider smoke | DeepSeek、MiMo 两项通过，各 1 次生成请求 | 合成文本、独立本地数据库、真实 runtime/transport、输出校验、用量和额度/成本落账、重放零新增发送；临时库已删除 |
| Gemini 官方 Interactions smoke | 1 项通过，1 次生成请求 | `gemini-3.8-flash`、稳定 v1、HTTP 200、独立当前八条迁移库、合成文本、输出/计量/结算/重放及临时库清理 |
| 文档、引用、YAML、diff | 通过 | 本地文档链接、模块/脚本引用、workflow YAML 解析、兼容残留核查；`git -c core.whitespace=-blank-at-eof diff --check` 保留冻结迁移和 CLI 生成类型的既有末尾空行，其他空白错误均检查 |

Provider-choice 浏览器测试的 Auth/Data API 使用浏览器拦截 fixture，执行使用真实本地 Next HTTP 和 paired fake runtime；只有测试进程固定时钟。它验证选择与同意的界面顺序，不代替真实 Auth/SQL 测试，也不证明外部 Provider 密钥或服务可用。所有故障注入和时钟替换均未进入产品运行路径。

并发边界测试在独立临时库中注入受控时钟，以 `pg_blocking_pids` 确认 service 连接确实等待运行控制行锁后，再推进时钟并解锁。17:59→18:00 的旧 B 选择返回 `OPTION_UNAVAILABLE`，账本和额度桶零增量；reserve 跨 UTC 午夜采用新 quota day，另一个仅提前 0.2 秒创建的请求跨午夜取得发送权后，保留原 quota day 并使用新的 Provider admission day。测试没有实际等待真实午夜，主库函数和 migrations 没有测试时钟残留。

保留的旧名称仅用于历史对象清理清单、从固定 Git 基线取出的临时演练、明确拒绝旧输入的最小负向 fixture，以及测试环境的旧密钥阻断清单。当前正式 wire/加密协议标识继续保留。没有提供旧格式读取或旧 API 执行能力。

## Responses 付费验收与提交权限回归

用户提供 `~/.keys/` 中的 DeepSeek/MiMo 密钥后，先完成初次真实调用；随后按要求将 DeepSeek 改为 Responses，再重新执行 `pnpm --filter web test:providers:live`。下表与当前[付费证据](evidence/provider-live-local.json)只描述这次两家均为 Responses 的验收，未拿此前 DeepSeek Chat 结果冒充新协议。普通 test、DB 测试与 CI 不加载这些密钥，也不自动运行付费 smoke。

| Provider | 实际配置及响应模型 | 实际接口 | 生成请求 | 输入 / 输出 tokens | 结果 |
| --- | --- | --- | --- | --- | --- |
| DeepSeek | `deepseek-flash` | `https://api.deepseek.com/responses` | 1 次，HTTP 200 | 580 / 22 | Responses 对象、输出验证、最终结算及幂等通过 |
| MiMo | `mimo-v2.6-flash` | `https://api.xiaomimimo.com/v1/responses` | 1 次，HTTP 200 | 564 / 22 | Responses 对象、非默认项选择、输出验证、最终结算及幂等通过 |

本轮合计 1,144 输入、44 输出 tokens，无生成重试。两个 request 均为 `FINALIZED/SUCCEEDED`，每项只有一个实际传输的成功 attempt；共扣两次用户额度、无残留预留；相同 key 重放没有新增 HTTP 请求。真实 usage 与冻结的测试价格在 JS 和 SQL 中计算一致。价格是明确标记的 synthetic fixture，账本中的金额用于校验公式，不代表上游实际账单。

付费测试发送前严格检查 Responses wire：无 `messages/thinking/response_format/max_tokens/user_id`，使用 `instructions/input/max_output_tokens/stream:false/reasoning.effort:none`；DeepSeek 还必须使用 `text.format.type=json_object` 和 64 位 HMAC `user`，不发送 `store` 或 tools。两家实际响应均为 `object:"response"`、模型匹配，DeepSeek 本次响应声明 `store:false`；这不是一个客户端留存控制或整体零留存承诺。MiMo 此次报告 512 cache-read tokens，JS/SQL 正确按冻结测试价格计量，未报告的 cache-write 保留 NULL。

测试从本地容器克隆独立数据库，生成仅面向本地合成样本的新 legal bundle/disclosures，再通过真实 Admin RPC 创建/校验/发布 profile、price、双选项 policy、设置指针、readback、reopen 和逐项同意；没有改动已封存种子来容纳新模型。执行使用真实 `executePolish` 和官方 HTTPS transport。SQL bridge 为测试提供合成 Auth/session/MFA 上下文，不是一次带真实用户登录的 Next/浏览器实测；真实 Auth/HTTP/浏览器验证仍由上表的独立测试提供。这份本地证据不能替代 hosted test/prod 验收。

这次预演还发现并修复此前覆盖遗漏：`complete_policy` 延迟触发器在 authenticated RPC 返回后、事务提交时恢复调用角色，原 `SECURITY INVOKER` 无权读取私有 AI 图。旧 SQL Admin 链使用较高权限连接加 JWT，没有暴露提交阶段的真实权限边界。第六条迁移将 `ai.validate_policy_graph()` 改为受限 `app_api_owner` 所有的 `SECURITY DEFINER`，保持空 search_path、撤销 API/PUBLIC 直接执行，不给 authenticated 增加 schema/table 权限；普通数据库测试新增真实角色的 COMMIT/SET CONSTRAINTS 回归。前五条迁移保持不变。另将 fake quota 与真实数据库统一为规范十进制字符串，删除 number/string 双解析；新增边界与耗尽测试，HTTP 配额仍为安全整数数字。

第七条迁移以新能力 `DEEPSEEK_RESPONSES` 和 descriptor 替代尚无 profile/default 引用的旧目录项；如存在旧引用即原子拒绝，不能改写冻结执行语义。它更新 Admin 当前能力/endpoint/config 校验，创建并封存新的法律 bundle/disclosures，保留旧封存字节和 MiMo 已审阅内容，并关闭 AI、清策略指针、推进 generation/close cycle。当前代码无 Chat transport、旧字段解析或回退；两种 `Responses` 能力都通过真实 DB/代码 descriptor 校验与新配置发布。

密钥仅在测试进程内存中使用，没有写入仓库、数据库、日志或证据。临时调用库已删除；脱敏记录见[真实 Provider 本地证据](evidence/provider-live-local.json)，原始本地材料为 `tmp/provider-live-smoke.json`。

## Gemini 官方 API 验收

第八条迁移追加 `GEMINI_INTERACTIONS/gemini_interactions_v1/interactions_v1`、`GOOGLE_AI_STUDIO` 接收方及新 `CV_APP_GEMINI_20261107` bundle。新 common AI terms 和三家新披露更新了公共 Provider 列表，DeepSeek/MiMo 的 Provider 特定事实保留；原有封存行和已发布 profile/policy 的逐对象摘要不变。隔离副本覆盖未初始化、LOCAL、PREVIEW、PRODUCTION 四种状态；已有三家 published profiles/policy 的实例保留，切换后 AI off、策略指针清空，generation/close cycle 推进。前七条文件保持原 SHA-256，完整链为八条。

显式运行 `CV_LIVE_PROVIDERS=GEMINI pnpm --filter web test:providers:live`，本轮没有再次调用 DeepSeek/MiMo。先以本地 key 访问官方模型元数据，再对 `https://generativelanguage.googleapis.com/v1/interactions` 发出一次合成文本请求，指定与响应模型均为 `gemini-3.8-flash`，HTTP 200、`object:"interaction"`、`status:"completed"`，输出校验通过。请求设置 `store:false`、`background:false`、`stream:false`、low thinking、无思考摘要及代码定义的 JSON Schema，不发送用户标识、历史续接或工具；2048 输出 token 硬上限下，实际请求预算为 1804。

实际用量为 569 input、20 visible output、0 thought、0 cache-read tokens；cache-write 保持 NULL。本次未产生非零思考用量，非零 thought 合并计费由单元测试证明。归一化 output 为 visible output 加 thought，reasoning 记录子集且不重复收费；真实 JS/SQL 冻结测试价格计算一致。账本为一个 `FINALIZED/SUCCEEDED` request、一个成功且实际传输的 attempt，用户额度 20→19、charged=1、reserved=0；相同 key 重放没有新增发送。合成价格 609 CNY nanos 仅验证公式，不代表 Google 实际账单。临时库已删除，独立[Gemini 脱敏证据](evidence/provider-live-gemini-local.json)保留本次记录，不覆盖此前两家 Responses 验收。

本次模型访问及合成文本成功不能证明 Google project 的付费层级、数据分享设置、处理地区或零留存。真实简历使用前的 owner 核验见[发布手册](database-rebuild-runbook.md)，免费/付费及日志/缓存边界见[官方来源记录](../web/src/content/legal/ai-terms-sources.md)。当前产品路径还会拒绝上游明确报告另一模型的成功输出，同时保留已知 usage；缺少实际模型观察仍保持未知，不冒称与配置一致。

## PR 提交前的补充验证

新增混合币种数据库回归以 DeepSeek/MiMo 的 CNY 和 Gemini 的 USD 真实发布价格、预留请求、冻结 snapshot、结算并读取 authenticated Admin analytics。故意传入相反币种及伪造成本不改变冻结事实；数据库按冻结价格重算，分别保留 CNY 22 nanos、USD 11 nanos，重复 finalize 不重复记账。金额仍为合成测试值；没有汇率换算或跨币种总价，用户按次额度仍共享。

清理最后的无 consumer Chat prompt 投影及旧工具导出；中英文完整 golden 直接校验执行中的 canonical blocks。240 组 prompt 输出的前后字节指纹一致，未修改执行语义版本。另收紧 MiMo 的 Responses envelope 与嵌套 assistant message 状态校验：错误 envelope、未完成或无效输出不再被判成功，同时保留已知用量。增加 17 项协议回归后，单元测试共 954 项。

该 MiMo 收紧路径另做一次最小真实复验，未重跑其他 Provider：HTTP 200、`object:"response"`、实际嵌套 `message/assistant/status:"completed"`，模型匹配、输出/结算/幂等及临时库清理均通过。仅保留安全状态枚举及用量，不记录响应正文；独立[MiMo 协议复验证据](evidence/provider-live-mimo-local.json)保留本次结果。

PR 推送仅更新 `codex/database-rebuild`，不推进 main/release。仓库根和 web 根的 `vercel.json` 均只对该评审分支禁用自动 Git 部署，以覆盖 Vercel 两种项目根目录设置；其他分支的配置仍由既有发布流程管理。CI 数据库仅在 runner 的临时容器中重建。当前本地快照不冒充后续 PR CI 的精确 SHA 证明。

## G3 平台保留与恢复演练

固定工具为 Supabase CLI `2.109.0`、PostgreSQL `17.6`；SDK 固定为 `2.110.0`。普通本地栈之外另建 loopback 独立容器，复制真实 Auth/Storage schema 和平台迁移元数据，不复制业务用户正文；在其中安装历史 60 条链并创建合成哨兵。

原生 `db reset --db-url` 在该独立本地演练中清掉了合成 Auth user/session/MFA，Storage 哨兵仍在。这是固定版本下的本地观测，不推断所有 hosted 实例或未来 CLI 的行为。该记录以当时的 Auth 保留要求标记为失败，原始证据与容器仍保留。用户之后已允许丢弃 Auth 数据，删除这些用户本身不再构成业务阻碍；但固定版本原生清理还触及 SSO 配置表、RLS policies 和扩展，当前工具仍使用已验证的应用白名单方法。普通开发库的 `db reset --local` 仅限可丢弃本地环境。

替代方法 `application_allowlist` 已实测通过：

1. 旧 60 条应用链按明确对象/签名清单清理，事务内拒绝未知 public 对象、重载、依赖和迁移历史；Auth、Storage、平台角色及无关 cron 不进入删除清单。
2. 应用最初四条基线后在初始化前中断；resume 完成初始化，重复 resume 不清库、不改变实例和审计哨兵。
3. 同一实例先后追加第五至第八条迁移，完整 history 为八条，平台指纹不变；新 Responses 目录与披露保持同一实例。
4. 分别移除外部 checkpoint、同时临时移除 history/checkpoint，rebuild 均因实际新应用对象/实例而拒绝；测试后已恢复原记录。
5. 人工构造 `reset_started` checkpoint，使用绑定方法、cleanup/inventory digest、操作 ID、SHA、两种 migration digest 和实时 catalog 的恢复证明，resume 保留实例、审计哨兵与平台指纹。`constructed_checkpoint_recovery_passed=true`；`checkpoint_loss_recovery_passed=false`，不声称实际 kill 命中了清理窗口。

12 类前后指纹一致：合成 Auth user、identity、refresh token、session、MFA、Storage bucket、object、无关 cron、指定合成保留角色的属性和成员，以及 Auth/Storage schema/table/column ACL、平台 migration metadata。角色哨兵比较不是全平台角色 catalog 的全量比较；ACL 指纹忽略的仅是新应用角色的预期权限增量。

| 材料 | SHA-256 |
| --- | --- |
| 四条冻结基线 `baseline_digest` | `45d98c91189daa67fe932666781dbae3e5302c7914bdc911981a086ab7454ab5` |
| 八条完整链 `migration_manifest_digest` | `93588b0b84ad56910773a60950c13c49d44704aee36c939dd9492aade57860af` |
| 应用清理 SQL | `2830f6c075dc6bf94d09906fa2ee09a005c48f8249c1b4bcff51e8bb026f48f5` |
| 旧对象清单 | `f657ea9cc89c0407737579510fa2ac3c718a13c07d80efcba5a4e89dc8c3c6a6` |

原始运行材料在本机 `tmp/remote-rehearsal-proof.json`；摘要及前后指纹已保存到[证据快照](evidence/database-rebuild-local.json)。该快照没有连接密码、API key、真实用户正文或有效凭据。演练完成后已停止并保留独立演练容器；主本地开发栈继续保留，临时并发数据库已删除。

## 未执行的发布门槛

用户最新边界允许 Auth 和其他历史数据重置，必保留 GitHub 登录/SSO 等项目配置、keepalive Action/RPC。现有工具保留 Auth/Storage 的行为仍是实测事实，不是必须保留旧用户的要求；本轮没有新增全面清 Auth/Storage 的执行入口，也没有重新读取或修改线上登录配置。若后续选择该删除范围，需先完成[发布手册](database-rebuild-runbook.md#选择同时清理-authstorage-时的前置工作)中的定向清理、配置保留、新 UUID bootstrap 和 TOTP 演练；上述 G3 证明不冒充这一新范围的证明。

CI 配置已接入当前单元测试、双构建、两套 fake 浏览器流程、真实本地 DB/Admin 测试，以及独立 G3 的 `prepare → start-db → platform → legacy → run → checkpoint-guards → verify`。本文件的本地结果不证明远端 CI 已通过；PR 阶段应读取当前精确 head 的 checks 和 runner 产物。

未来执行仍需[发布手册](database-rebuild-runbook.md)中的明确授权及目标核验：先按候选/merge SHA 重跑 CI 与演练，取得 test/prod 实际环境映射、暂停访问与 Git 自动集成，再进行 test 验收、同 SHA 的 prod 重建和应用发布。G10/G11、真实托管集成、以 test/prod 为目标的 Provider smoke、线上恢复自动部署和后续增量发布均未执行；本地真实 Provider smoke 不能替代它们。不能仅推送本次新迁移链到仍有旧历史的环境。
