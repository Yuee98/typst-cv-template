# 第二轮重构验证记录

状态：原始第二轮基线验收与后续修改分别记录。下方原始记录及其 [机器记录](evidence/database-rebuild-v2-local.json) 绑定 `3967ca5`，不会自动证明后来改写的迁移或应用代码。无 TOTP、运行设置修复及展示名/独立数据处理说明分别记录于后续章节。

## 实施范围

- 开始工作区无未提交代码，上一轮 UI/Admin 已有三个本地提交至 38cc1e4。
- 372b5c1 保存本轮实施计划检查点。
- 工具 manifest 改为读取显式 baseline.json，覆盖基线文件数变化、追加文件、乱序/重复/路径越界负向测试。
- 本轮不执行 hosted SQL、不重置 test/prod、不 push、不 promotion 或发布。

## 原始基线的本地验收（3967ca5）

| 范围 | 通过条件 | 状态 |
| --- | --- | --- |
| 新迁移 | 空本地库按完整清单重建；结构化表、跨 schema FK、权限与 API 都正确 | 15 条迁移、30 张表；最终正文同步后 82 SQL / 16 API 再次通过，生成类型无差异 |
| CV/Auth | 当前 CV v7、加密封装、真实 Auth 与账户/实例边界正负路径 | SQL/API、Web 回归及真实 Admin 登录/TOTP 通过 |
| AI | 同一请求/attempt 单次发送、late facts、HELD、取消/停用、四费率/未知用量/溢出/多币种 | SQL/API、运行时回归及两连接测试通过；未调用付费模型 |
| 出口 | 自定义 endpoint 的实际 DNS/IP 约束、TLS/跳转、凭据命名空间和标识隔离 | 共享出口 51 项测试通过，含有界压缩解码、实际连接 DNS 绑定及错误回调 |
| 竞态 | 重复 reserve/start/complete/finalize、限额争用、锁后时钟跨 UTC 日 | 独立临时库 8 类断言通过，包含首次发送日及上海时段边界；临时库清除 |
| 条款 | current+typed audit、common/provider 原子接受、历史精确阅读、安全 Markdown | SQL/API、浏览器和组件回归通过；源码、主本地库与新建独立库的 5 份种子正文全部匹配 |
| Admin | 六业务页统一列表/Dialog、配置价格与规则成员原子保存、缓存和脏表单保护、手机/宽屏 | 9 项真实浏览器测试、追加 2 项页面截图测试与聚合历史回归通过；390px 深色 / 1536px 浅色列表及控制页已人工查看；双读取和未知操作重试回归已修复并通过 |
| 工具 | manifest、维护/目标/CA/检查点守卫、独立白名单重建与平台保留演练 | 3967ca5 的旧 60 → 新 15 迁移链、12 项平台保留、恢复/重复恢复和检查点守卫全部通过 |
| 工程 | typecheck、lint、单元/集成、服务端/静态构建、无旧实现/兼容残留 | 1,206 Web / 35 工具测试、typecheck/lint 通过；3967ca5 双模式构建通过 |

## 已执行命令与证据

- `pnpm test`：88 个 Web 测试文件共 1,206 项、35 项 Node 工具测试通过；`tmp/round2-final-unit.log`。
- `pnpm typecheck` 与 `pnpm lint`：通过；`tmp/round2-final-typecheck.log`、`tmp/round2-final-lint.log`。
- 本地 SQL/API：最终条款同步和函数声明修正后，82 项 SQL 与 16 项真实 Data API/Auth 测试再次通过；`/tmp/cv-db2-final-summary.json` 记录最终迁移内容 hash。15 文件基线与完整清单 digest 均为 `94d98f5573f8d1e063675fe2794610a7f888fb7b6ac8b56d15611ba26b555c63`。
- `node scripts/db-ai-concurrency.ts --run-disposable`：独立库重复占额/尝试/终态/结算、额度争用、跨日及规则过期均通过；`tmp/round2-concurrency.log`。
- 真实 Admin E2E：9/9 通过；`/tmp/cv2-admin-e2e-pass.log`。真实 Provider 选择器浏览器 E2E：1 个完整旅程通过，使用假执行器，不产生付费请求；`tmp/db2-provider-choice-logs/browser-final-run.log`。
- `web/scripts/test-admin-build-modes.mjs`：冻结代码后执行 server → static → server 构建通过，静态边界扫描 139 文件通过；`tmp/round2-build-modes-final.log`。初次构建因沙箱无法获取现有 Google Fonts 失败；在允许联网的本地执行环境重跑成功，未使用字体 mock 或降低构建检查。
- 本地 `supabase db lint` 与 `supabase db advisors`：结果均为空，0 错误、0 警告/建议；结构、所有表 RLS、函数 owner/search_path、角色 ACL、无旧实体和完整迁移历史检查通过。`tmp/round2-final-advisors.log`、`/tmp/cv-db2-final-lint.log`。

本轮付费调用数为 0，未访问或修改 hosted 数据库，未 push 或触发发布。线上性能与真实供应商最终行为不在本轮新证据范围内。

## 回归修复

- 快照等待及重试等待期间取消，取消 RPC 失败仍进入 finalize，不跳过已知事实结算；两种窗口均验证 RED → GREEN。
- 配置/价格两组历史同时读取，连续保存不能让先完成的读取消费另一读取的失效标记；真实 hook 回归验证 RED → GREEN。
- CREATE 提交结果未知后，再试遇到临时 4xx，继续冻结原操作标识与完整 payload，成功回执或明确数据库契约/实例失效之前不产生新操作；真实 hook 回归验证 RED → GREEN。
- 普通页面缓存仍按 5 分钟回收；每账户/实例的六个提交计数保留至账户清理。计时回归确认普通缓存被回收后计数仍可用，退出登录后计数也清除；不注册随账户增加的 Query defaults。

## 本地提交

- `372b5c1`：本轮计划检查点。
- `b41a8f8`：数据库新基线、typed audit、SQL/API 测试与生成类型。
- `807f796`：显式基线清单、初始化/重建/竞态工具和安全 fixture。
- `eda5830`：AI、精确同意和 Admin 六页整体切换。
- `3967ca5`：第二轮基线的缓存提交计数寿命回归修复。上述基线验收的运行代码 SHA 为 `3967ca536b0127d729f7b536c1a064c85fd9c9d1`；本轮演练以此 SHA 绑定。

紧随其后的 `09705d5` 仅包含文档与证据。后续修复单独记录，不会自动重绑已有证明。未来 hosted 切换仍须对实际合并/发布 SHA 重新生成材料，本记录不授予线上发布或清库授权。

## 隔离重建和恢复演练

在 `supabase_db_cv-remote-rehearsal` 的 loopback TLS 目标上执行 `run` → `checkpoint-guards` → `verify`，绑定完整 SHA `3967ca536b0127d729f7b536c1a064c85fd9c9d1` 与上述两类清单摘要。仅复制本地平台结构、ACL 和迁移元数据，未复制已有用户或 Storage 对象数据。

旧 60 条链经 application_allowlist 清理后完整应用新 15 条链。user、session、MFA、identity、refresh token、bucket、object、无关 cron、role、role membership、platform versions、platform ACL 共 12 项指纹前后相等。迁移完成后按预设故障中断，随后 resume 与重复 resume 均通过；实例保持 `663add7f-acb5-4fde-94e2-4eefae3b842d`，结束处于 DB-ready / maintenance=true。

移走检查点时拒绝再次清库；同时移走检查点与历史时也拒绝。另以明确构造的 reset_started 状态验证“检查实时 catalog 后恢复”，不重复 reset。此次初始中断已有 durable migrations 检查点，因此 `initial_checkpoint_loss_recovery_passed=false` 如实保留；构造状态恢复单独记录为 `TEST_CONSTRUCTED_STATE_ONLY_NO_REPEAT_RESET`，不冒充真实网络故障导致的检查点丢失。

原始 proof 已归档至 `tmp/pre-no-totp-g3-3967ca5-20261108T233027/remote-rehearsal-proof.json`，SHA-256 `8e305d07f7da29bc6d7a18c19c08897bacd099b8758d6df904d2cc40be9bfe84`；安全摘要 `tmp/g3-v2-final-summary.json`。日志为 `/tmp/cv-g3-v2-run.log`、`/tmp/cv-g3-v2-checkpoint-guards.log`、`/tmp/cv-g3-v2-verify.log`。这些是原始候选代码证据，不能代替当前新基线或未来实际项目、合并 SHA 和维护窗口的执行记录。

## 后续交互修复：新建 AI 配置的错误提示

本地 Gemini 表单使用了未配置的 `AI_PROVIDER_KEY_G`，BFF 把缺少服务器凭据引用与所有地址校验错误统一降为 `INVALID_REQUEST`，客户端也丢弃了已有的 reason 字段。现改为仅传递三种安全原因：凭据引用不存在、地址无效、地址无法解析为可用公网目标。界面提供中英具体提示、凭据字段说明及格式校验，并明确指引 TOTP 验证；不增加名称别名、不输出 Key，也不放宽校验。

本次 `pnpm test` 为 1,223 项 Web / 35 项工具测试全通过，typecheck/lint 通过。真实本地 HTTPS/Chromium 复测确认：错误引用显示具体原因且保留表单；正确的 `AI_PROVIDER_KEY_GEMINI_LOCAL` 通过配置校验，未完成 TOTP 的会话仍被写入安全门拦截。未创建配置、未调用 Provider、未改数据库结构或线上环境。日志为 `tmp/admin-configuration-final-unit.log`、`tmp/admin-configuration-http-verification.json`、`tmp/admin-configuration-browser.log`。上节 G3 证明仍保留其原 SHA，本次未重新生成数据库切换证明。

## 当前变更：整体移除应用 TOTP

用户明确要求取消整套 TOTP 设计，并直接修改现有迁移、重建本地测试库。已删除应用绑定/验证组件、二维码与验证码逻辑、中英文文案、AAL2/近期验证门槛、step-up 参数及错误码。普通 Auth 登录、实时会话与管理员资格、账户/实例隔离、CAS、审计和最后管理员保护保留。既有 Supabase SDK 与平台表不由应用迁移删除；独立演练中的平台因素行仅是保留哨兵，不构成应用功能。

仍为原 15 个文件，新基线与完整清单 digest 均为 `3615590132917d8dfc69a585d7c620990731c34fe6d53670d0fbb178d9e7f8da`，不存在新增的第 16 条迁移或旧签名兼容重载。主本地库已按新文件完整重建，实例为 `57c3f500-800b-4395-9363-b598731b1cf2`。91 项 SQL、19 项真实 Auth/API 测试通过；普通密码登录的管理员可写，匿名、普通用户、已撤权管理员及失效会话仍被拒绝；数据库 lint/advisors 均无错误或警告。

当前运行代码提交 `9dd1bb8753267dca83c6cd37757bfbedbfe0ec51`，汇总见 [无 TOTP 验证记录](evidence/admin-without-totp-local.json)。1,220 项 Web 测试、35 项工具测试、完整类型检查与 lint 通过；9 项真实 Admin 浏览器测试确认普通登录后的配置/价格/规则原子保存和管理员授予/撤销。server → static → server 生产构建通过，静态边界扫描 139 文件通过。测试固定使用已安装的 CLI/Node 入口，不让浏览器副本的包管理器介入工作区依赖。文档和只读统计命令一并对齐当前 `admin_read` 契约。

新的独立 G3 将旧 60 条链重建为改写后的 15 条链，12 项平台指纹相等。真实迁移后中断恢复、重复恢复、缺检查点拒绝、缺检查点与历史拒绝，以及明确构造的检查点恢复都通过；没有冒称真实丢失检查点的故障。新 proof 为 `tmp/remote-rehearsal-proof.json`，SHA-256 `dadc0358777582208bc77e11691cd851011e42c584ac601b518061adc5ffdcc1`，新安全摘要 `tmp/g3-no-totp-final-summary.json`，绑定上述 `9dd1bb8` 和新 digest。

本地预览账号已使用原邮箱/密码恢复；实际内网 HTTPS/Chromium 验证普通登录可保存原样且保持关闭的运行设置（HTTP 200），绑定入口与因素请求均为零。窄屏页面已人工查看。未调用 Provider、未操作 test/prod、未 push 或发布；本地库实例变化后需退出旧会话并重新登录。后续纯文档提交不重绑上述源码证据，未来 hosted 切换仍需针对实际候选 SHA 重新验收。

## 后续交互修复：运行设置的依赖错误（2026-11-09）

本地日志中 7 次失败均为 `INVALID_ROUTING_GRAPH`：启用的时间规则引用了一条未启用的配置。额度 20/2000/3 合法，关闭状态也不要求完整路由；BFF 丢弃 SQL detail、界面在取消勾选后仍保留旧错误，导致只看到 `INVALID_REQUEST`。

现仅转发三种安全运行校验原因并显示中英指引：条款不可用、缺少启用的兜底、规则引用未启用配置或无效披露。修改字段清除已确定的旧错误，未知结果仍冻结原 payload/key；并发冲突保留草稿，刷新后必须显式载入最新设置。没有放宽 SQL 条件，也没有改动 migrations。

1,239 项 Web 测试、类型检查、lint 通过。相关 SQL 文件 22/22 通过，新增 11 个事务回滚断言验证：不完整配置可关闭保存、启用失败的 flag/revision/receipt/audit 原子不变、缺省规则引用 disabled 配置时的具体失败原因。浏览器验证了中文说明与取消勾选后清错；因用户在排查期间已启用配置与总开关，浏览器错误响应采用明确模拟，真实 HTTPS POST 仅用保证过期的 revision 校验到 409，不提交写入。测试未关闭或重新启用用户的 AI，也没有重置数据库、调用 Provider 或操作线上。

证据：`tmp/admin-runtime-final-unit.log`、`tmp/admin-runtime-final-lint.log`、`tmp/admin-runtime-validation-red.log`、`tmp/admin-runtime-validation-bff-green.log`、`tmp/admin-runtime-feedback-browser.log`、`/tmp/cv-runtime-draft-regression.log`。此前绑定 `9dd1bb8` 的基线和 G3 证明仍按原 SHA 保留，不自动证明后续应用改动。

## 展示名称与独立数据处理说明（2026-11-09）

用户批准直接修改原 15 条基线并重建本地测试库，不新增兼容迁移。配置保留内部 name，新增必填 display_name；公开选择器仅显示展示名，不再向浏览器投影内部名或模型。配置 typed audit、预留快照及历史统计保留当时的展示名。

legal.documents、对应 typed audit、摘要及 DTO 删除 adapter_id、model_id、endpoint_url。配置显式引用 AI_PROVIDER 文档，多份不同技术配置可共享说明。Admin 新增数据处理说明列表和 View/Edit Dialog，支持新建、双语受限 Markdown、预览、生效日及启停。普通条款和公共 AI 条款不进入该编辑器；文档 kind 不可更改。管理员负责核实实际接收方和数据处理的适用性，系统不再声称能用技术字段自动验证隐私政策。

配置名称、展示名、价格或技术字段修改不改变同意摘要；说明内容或接收方变更要求新请求重新同意。精确历史文档链接、接受记录与既有请求冻结证据保持不变。旧技术字段在新写入契约中被拒绝，不作为兼容输入。

本次代码提交为 `7d7c1d9`（数据库及 fixture）和 `4a3c02dafb7923f0578ae39b880e7d7fdfef8803`（应用及浏览器测试）。仍是原 15 条迁移；最终基线与完整清单摘要均为 `058ba12c140f8a281e78b6b063642f4d83b3f73613e0cb73b9cf835c014682e0`。最终文件已完整重建本地库，实例为 `9aefa2c5-6f3d-413f-a608-725da0b84547`；5 份 canonical seed 正文/元数据全部匹配。机器记录见 [展示名与独立说明验收](evidence/ai-disclosures-local.json)。

验收通过：129 项 SQL / 6 文件、19 项真实 Auth/API / 5 文件、1,271 项 Web / 89 文件、36 项工具测试、完整类型检查和 lint；db lint/advisors 均无问题。独立临时库并发预留、单次发送/结算、额度争用、UTC 跨日及上海时间规则边界全部通过。新增断言覆盖跨 adapter/endpoint/model 共享说明、名称变化不失效同意、正文变化要求重新同意、历史正文与冻结名称不变，以及双语 65,536 个中文字符保存。

10 项真实 Admin 浏览器测试全部通过，含普通登录后新建/编辑/停用说明、typed history、手选关联到配置、权限和缓存隔离；390px 深色及 1536px 浅色的新列表和 Dialog 已人工查看。用户选择器的独立浏览器流程也通过，使用明确的假 Provider，不加载真实密钥。最终代码 server → static → server 构建通过，静态 Admin 边界扫描 139 文件。

独立审查发现并修复了公共法律 reader 的孤立 100 份上限；真实条款门槛回归验证 101 份有效文档仍可检查普通条款同意。CLI typegen 曾在有效代码后混入遥测关闭错误 JSON，已验证有效类型部分与既有 public 类型逐字相同，移除非代码尾部后重新通过类型检查及完整 Admin 浏览器验收。新 E2E 的正文定位、缓存回访等待及延迟约束清理也已收敛，最终 10/10 及清理流程通过。

日志位于 `tmp/disclosure-refactor/` 与 `/tmp/display-legal-*.log`，具体路径见机器记录。本地预览账号沿用原邮箱/密码，恢复原有一份配置、时间规则、额度及启用状态；展示名初始使用原配置名称，可在 Admin 修改。旧本地接受记录未恢复，需重新登录及同意当前说明。

旧 `9dd1bb8` 的 G3 proof 和摘要不重绑；未来 hosted 切换仍必须为实际候选提交和新迁移摘要生成证明。本轮未操作 test/prod、未 push、未发布，付费 Provider 调用为 0。

## 评审修复候选的本地验收（2026-11-09）

以下结果对应修复提交 `1f39b85`（含前一修复 `dc5ac77`）的代码与迁移，机器摘要见 [评审修复本地证据](evidence/pr43-review-corrections-local.json)，不回填为上述历史 SHA 的验收。记录时尚未形成新候选的 CI 或 G3 通过结论。

- 全量 Web 测试为 90 文件 / 1,520 项通过，工具测试 36 项通过，完整类型检查和 lint 通过；日志位于 `tmp/relay-v2-final/round2-{web-unit,tools,typecheck,lint}.log`。
- 隔离空库完整应用当前 15 条迁移，8 份 TAP 文件的 173 个断言全部通过。验收同步本地平台结构、角色及 ACL，不复制平台用户数据；来源主库只读，未执行原生 reset，临时容器已清理。最终记录为 `tmp/relay-v2-final/isolated-sql-summary.json`，其中保存被测迁移的逐文件 hash；此前因平台角色与空库默认值不同而失败的尝试不作为通过证据。
- 法律写入触发器与严格 reader 共用 [格式用例](../supabase/test-fixtures/legal-markdown-corpus.json)：97 个链接、126 个正文和 20 个元数据样例。覆盖完整 HTTPS authority、IPv6、本站路径、现有来源链接及 Markdown 原有结构语义，同时校验 Unicode 空白、UTF-16 长度和真实四位正年日期。隔离库中的实际 authenticated 角色 RPC 提交验证合法内容逐次保存后可通过严格 DTO 且字段值原样回读，非法新建或更新不改变正文、审计、操作及运行状态账本；这里使用明确的合成有效会话，不冒充 GoTrue 密码登录。独立记录为 `tmp/relay-v2-final/legal-markdown/summary.json`。
- 完整 DB/Auth/API 套件 6 文件 / 21 项通过；其中新增 2 项为隔离库中实际 authenticated 角色 RPC 的合成有效会话测试，其余现有 Auth/Data API 验收使用本地真实服务。日志为 `tmp/relay-v2-final/round2-db-api.log`。为保留当前本地预览，只在事务内同步固定的 5 个函数并验证所有业务数据、迁移记录、原 RPC/触发器元数据和 schema 权限前后一致；未重建主库，账号、配置和 AI 开关保留。全链空库证明来自上述独立容器。

本轮未操作 test/prod，也未调用付费 Provider。先前浏览器、构建和 G3 记录保留各自原始提交边界；它们不自动证明本修正提交或未来推送的候选 SHA。后续 CI、生产构建、浏览器及实际候选 G3 结果须分别记录，不把尚未结束的门禁标为通过。
