# 第二轮重构验证记录

状态：本地实施与验收完成。汇总见 [本轮机器记录](evidence/database-rebuild-v2-local.json)。旧版证据不能证明 cv_app_db_2 或本轮新基线。

## 实施范围

- 开始工作区无未提交代码，上一轮 UI/Admin 已有三个本地提交至 38cc1e4。
- 372b5c1 保存本轮实施计划检查点。
- 工具 manifest 改为读取显式 baseline.json，覆盖基线文件数变化、追加文件、乱序/重复/路径越界负向测试。
- 本轮不执行 hosted SQL、不重置 test/prod、不 push、不 promotion 或发布。

## 已完成的本地验收

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

完整本地 proof：`tmp/remote-rehearsal-proof.json`，SHA-256 `8e305d07f7da29bc6d7a18c19c08897bacd099b8758d6df904d2cc40be9bfe84`；安全摘要 `tmp/g3-v2-final-summary.json`。日志为 `/tmp/cv-g3-v2-run.log`、`/tmp/cv-g3-v2-checkpoint-guards.log`、`/tmp/cv-g3-v2-verify.log`。这些是本地候选代码证据，不能代替未来实际项目、合并 SHA 和维护窗口的执行记录。

## 后续交互修复：新建 AI 配置的错误提示

本地 Gemini 表单使用了未配置的 `AI_PROVIDER_KEY_G`，BFF 把缺少服务器凭据引用与所有地址校验错误统一降为 `INVALID_REQUEST`，客户端也丢弃了已有的 reason 字段。现改为仅传递三种安全原因：凭据引用不存在、地址无效、地址无法解析为可用公网目标。界面提供中英具体提示、凭据字段说明及格式校验，并明确指引 TOTP 验证；不增加名称别名、不输出 Key，也不放宽校验。

本次 `pnpm test` 为 1,223 项 Web / 35 项工具测试全通过，typecheck/lint 通过。真实本地 HTTPS/Chromium 复测确认：错误引用显示具体原因且保留表单；正确的 `AI_PROVIDER_KEY_GEMINI_LOCAL` 通过配置校验，未完成 TOTP 的会话仍被写入安全门拦截。未创建配置、未调用 Provider、未改数据库结构或线上环境。日志为 `tmp/admin-configuration-final-unit.log`、`tmp/admin-configuration-http-verification.json`、`tmp/admin-configuration-browser.log`。上节 G3 证明仍保留其原 SHA，本次未重新生成数据库切换证明。
