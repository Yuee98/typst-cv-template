# 数据库重构实施计划

状态：本地实现与验证完成；进入分批提交、PR/CI 与 Relay 评审阶段，线上切换未执行。日期：2026-11-07。对应[数据库设计](database-rebuild-design.md)与[重置发布手册](database-rebuild-runbook.md)，实测结果见[本地验收记录](database-rebuild-verification.md)。当前授权包含分批 commit、feature 分支推送、创建 PR 和 Relay 评审修复至收敛；仍不修改 test/prod 数据库、托管环境配置或触发线上发布。

## 交付和实施顺序

目标是提交一套能从空业务库重建的数据库、唯一的新运行时、同步更新的 Admin/CV/条款客户端，以及经过演练的两环境切换工具。本轮同时完成全仓历史兼容与 legacy 清理，包括本地旧 JSON、历史本地文档和草稿；全部入口只支持最新格式，不保留本地转换例外。本轮还交付用户可选 Provider：时间段决定可选集合及默认项，用户明确选择本次执行目标。DB、API、运行时和界面全部完成后再重置 test/prod，不将该功能推迟到重构后的第二次结构切换。仅压缩 migrations、仅搬表、只删除文件名里的版本号都不构成完成。

用户后续已允许 Auth 用户和其他历史数据一起丢弃；保留项改为项目和必要配置，重点是 GitHub 登录/SSO、回调与重定向、项目连接/keys/Git 集成，以及现有 keepalive Action 与 RPC。当前实现仍采用已验证的应用白名单清理；允许删 Auth 不表示当前工具已经实现全面清数据。若后续采用 Auth/Storage 一并清理的方案，需先补充定向清理、配置保留及恢复身份的本地演练；具体准入和步骤见[重置范围](database-rebuild-runbook.md#重置范围)。这次范围补充不授权立即操作 test/prod 或发布。

开发在 `codex/database-rebuild` 类隔离分支进行。除独立且不改当前行为的操作工具准备外，旧 migrations 的删除、新数据库和所有调用者必须作为同一个完整切换版本合入 `main`。可以分阶段提交和评审，不把不能运行的中间状态部署到 test。

| 阶段 | 内容与交付 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| P0 现状和业务契约冻结 | 生成旧表/函数/ACL/cron/客户端调用清单及全仓兼容/legacy 依赖清单；提取当前真实结算、取消、定价与条款行为；固定唯一当前 CV/存储格式和 cloud reset 范围 | 设计稿 | 本文映射覆盖旧对象及本地读取/导入入口；仅当前业务语义进入新契约；没有根据历史文档恢复已废弃行为 |
| P1 切换工具准备 | 新增仅手动触发 workflow、环境身份校验、SHA 固定、只读 preflight、持久化 phase/checkpoint 和 resume；补充 promotion 门槛、跨 workflow 排他及 Vercel/Pages 环境核验；可先合入 main，默认 plan | P0 | 普通 push/PR/schedule 不可能触发业务清库；fixture 覆盖误环境、重复/中断执行、已前移 release 的部分部署；默认不影响现有发布、不执行线上步骤 |
| P2 新基线 | 建立 common/业务 schema、31 表、external ID、约束、RLS、权限、内部角色及 Provider/能力/法律目录；新增 policy options 和 rule-option 关联 | P0 | 空本地库重建成功且未初始化时业务写入关闭；初始化后 ready；默认项归属、同策略/披露 FK、不可变约束、显式权限通过；public 无应用基表 |
| P3 领域事务和 API | 完成 CV/条款、配置创建发布、Admin 内核、运行控制和新 AI 账本 RPC；新增实例/契约写入屏障、当前可选列表、锁后时间校验、策略原子创建及价格原子接续；生成类型 | P2 | 每个公开入口有允许/拒绝验证；并发前置条件和报告依赖完整；选项失效或配置变化在占额和传输前拒绝；重放不重复授予传输权 |
| P4 唯一 AI 运行时 | 整合用户所选配置冻结、准备传输、attempt、取消、结算与 fake backend；删除旧分支 | P3 | 新 RPC 完整链路通过；跨时段与重试保持原选择，不能跨 Provider fallback；不存在旧 profile resolver/alias/legacy settlement 调用 |
| P5 全部客户端切换 | Admin 时段集合/默认项编辑器、润色 Provider 选择、逐选项披露、本地/云端 CV、JSON 导入、草稿、API DTO、缓存分区、external ID、revision 和错误处理 | P3，联调依赖 P4 | 实际浏览器验证选择、边界刷新、同意、管理员流程及最新格式文档；所有 CV 入口拒绝旧格式；旧 ID 和旧数据不会被静默重新上传 |
| P6 全仓清理和文档收敛 | 删除全部历史兼容分支、本地旧格式迁移器、旧 migrations、旧导出/配置入口、升级测试/fixture、脚本与 CI 残留；更新注释、README、运行契约和环境变量说明 | P4/P5 | 历史兼容/legacy 实现及可达引用归零，无本地保留例外；废弃文档退出工作树；当前文档只有一套操作说明 |
| P7 本地和 CI 演练 | 全套新 DB 测试和多选项时段切换验收；旧业务基线到新基线的远端模式 reset/恢复演练；服务端/静态构建；冻结发布材料 | P6 | G1–G9、用户选择与整体审查用例通过；产物含 SHA、baseline digest、完整 migration manifest digest、构建目标及演练记录；合入后核验实际 merge SHA |
| P8 test 切换 | 暂停自动部署与访问，合入 main，固定实际 merge SHA，重建 test、部署 Preview、完成验收 | P7，且后续明确授权线上执行 | test migration history、catalog、API 权限与 SHA 一致；AI 默认关闭后按受控配置启用 |
| P9 prod 切换 | 使用已在 test 验证的同一 SHA；先重建 prod，再 promotion 到 release，再部署和验收 | P8，且后续明确授权线上执行 | prod 与 release/应用均对应同一版本；无旧 API/cron/配置残留 |
| P10 收尾 | 恢复分支监听和 keepalive、核对客户端缓存、记录关闭旧入口；禁用一次性 destructive 执行入口 | P9 | 普通增量发布成功；重跑 workflow 默认只验证，不再清库 |

阶段依赖用于组织顺序，不要求另开 agent 或并行执行。P0–P7 的本地部分已完成，后续授权允许推送隔离分支并运行 PR 的临时 CI 数据库和验证；P8–P10 的实际 test/prod 切换、合并与发布仍需后续明确授权。当前 PR 只承载完整版本评审，不部署中间批次。

## 数据库对象映射

下表覆盖旧迁移定义的 51 张表。旧名字只用于删除清单和一次性 reset 演练，不保留 alias view、wrapper RPC、读回适配或数据回填。

| 旧 public 表 | 新结构或处理 |
| --- | --- |
| `cv_documents` | `cv.documents`；新增 external ID/revision，访问改为 view/RPC |
| `cv_key_wrappings` | 删除；当前代码未使用，不建立空替代表 |
| `user_terms_acceptances` | `legal.acceptances`，重建后重新同意 |
| `ai_feature_config` | `ai.runtime_control`、`ai.allowed_users` |
| `ai_request_ledger` | `ai.requests`，无 legacy source/旧投影列 |
| `ai_usage_daily` | `ai.user_usage_daily` |
| `ai_rate_minutes` | `ai.rate_minutes` |
| `ai_global_usage_daily` | `ai.global_usage_daily` |
| `ai_provider_profiles` | `ai.profiles` |
| `ai_provider_profile_versions` | `ai.profile_versions`，只保留 DB 配置字段 |
| `ai_price_versions`、`ai_price_components` | `ai.price_versions`、`ai.price_components`；去除 legacy lane |
| `ai_routing_policy_versions` | `ai.policies`、`ai.policy_versions`、`ai.policy_options`、`ai.routing_rules`、`ai.routing_rule_options`；单一自动目标改为时段可选集合及默认项 |
| `ai_profile_usage_daily` | `ai.profile_usage_daily` |
| `ai_legal_bundle_versions`、`ai_legal_bundle_manifests`、`ai_legal_manifest_versions` | `legal.document_versions`、`legal.bundles`、`legal.disclosures`；新 manifest 与展示内容绑定 |
| `ai_service_runtime_contract_versions`、`ai_service_runtime_target_versions`、`ai_service_runtime_contract_targets` | 合并为 `ai.capabilities` 中的当前执行语义及不可变版本引用；删除手工维护的目标组合目录 |
| `ai_price_component_seal_intents`、`ai_routing_policy_transition_intents` | 删除 intent 表；价格组件创建和版本转换由受控事务完成，不依赖 caller GUC 充当权限证明 |
| `ai_provider_attempt_ledger` | `ai.attempts` |
| `ai_routing_lifecycle_audit` | `audit.events` |
| `admin_environment`、`admin_principals`、`admin_audit_events` | `admin.environment`、`admin.members`、`audit.events` |
| `ai_adapter_catalog`、`ai_providers`、`ai_runtime_code_capabilities_v2` | `ai.capabilities`、`ai.providers`；代码能力保持迁移管理 |
| `ai_legal_display_versions_v2`、`ai_current_legal_bundle_v2`、`user_ai_legal_acceptances_v2` | `legal.disclosures`、`legal.current_state`、`legal.acceptances` |
| `ai_runtime_target_bindings_v2` | 删除；profile/price/policy/disclosure 的 FK、发布校验和冻结 request 定义目标 |
| `admin_committed_operations` | `admin.operations` |
| `admin_reviewed_deployments_v1`、`admin_reviewed_deployment_capabilities_v1` | 删除，无 build 注册替代表 |
| `admin_validation_reports_v1`、`admin_config_validation_reports_v2` | 单一 `admin.validations` |
| `admin_ai_control_state_v1` | 合并进 `ai.runtime_control`，保留 gate/revision/关闭周期语义 |
| `admin_runtime_readback_reports_v1`、`admin_runtime_readback_reports_v2` | 单一 `admin.readbacks` |
| `admin_admitted_runtime_deployments_v1`、`admin_admitted_runtime_targets_v1`、`admin_admitted_runtime_deployments_v2`、`admin_admitted_runtime_targets_v2` | 删除，无部署准入替代表 |
| `admin_runtime_authority_receipts_v2`、`admin_runtime_authority_expected_v2`、`admin_runtime_authority_receipts_v3`、`admin_runtime_authority_expected_v3` | 删除函数定义 hash、authority epoch 和切换收据目录；权限改由明确 ACL/RLS 和 catalog 测试约束 |
| `admin_config_lifecycle_events_v2` | `audit.events`，记录新模型的生命周期操作 |

旧 196 个不同函数名不按名字自动重命名。P0 生成签名级清单，将每个函数标记为：新领域事务、内部校验、公共接口、删除。函数 overload 必须逐签名确认；检查旧 ACL、trigger、policy、cron、publication 和 Auth hook 对这些签名的依赖。新对象目录只允许设计中的公开接口和必要私有 helper，不能照搬所有旧函数形成隐藏兼容层。

## 代码和脚本清理

| 当前路径或类别 | 实施动作 | 验证 |
| --- | --- | --- |
| `web/src/server/polish/handler.ts`、`handler-runtime-authority.ts` | 只组合一个 DB 执行器；删除 legacy resolver 和双 target resolver | 模块依赖测试；失配版本和缺失所选凭据明确失败 |
| `lifecycle.ts`、`lifecycle-post.ts`、`lifecycle-v2.ts`、`lifecycle-post-v2.ts`、`lifecycle-settlement.ts`、`quota.ts` | 按职责提取单一 HTTP/lifecycle/accounting 模块；删旧 reserve/mark/finalize wrapper | reserve→attempt→complete→finalize 真实 DB 测试 |
| `execution-snapshot-v2.ts`、`lifecycle-v2-contract.ts`、`runtime-config-receipt-v2.ts` | 新唯一 snapshot DTO；删除旧格式 union、fallback 和旧 authority receipt 字段 | 严格字段检查，旧/混合/未知格式拒绝 |
| `web/src/server/polish/lifecycle-availability.ts`、`routing-rules-v1.ts` | availability 返回当前集合、默认项、各项状态和 nextChangeAt；reserve 以 DB 时间重验所选项；删除单一自动 Provider 目标契约 | 集合与时间边界、非默认项、失效选择、跨策略引用、同键不同选项和冻结重放 |
| `web/src/components/cv-builder/polish/**`、`web/src/lib/polish/contract.ts` | 增加 Provider/模型选择和显式 option ID；选项切换更新披露；处理刷新、失效提示和 CONFIG_CHANGED；仅在当前交互状态保存选择 | 首次默认预选、仍有效则保留、失效清空、无静默代选、无自动重发、无旧单目标 DTO fallback |
| `profile-registry.ts`、`env.ts`、`service-runtime-contract-v1.ts` | 删除固定模型 profile、alias 和历史 runtime target 表；只留下安全规则与能力契约 | DB 换模型/凭据引用无需代码模型常量；未知语义失败 |
| `profile-execution-v2.ts`、`provider-binding-v2.ts`、`prepared-provider-execution-v2.ts`、`runtime-code-capability-v2.ts` | 提取有效能力校验、前缀约束、official origin/path 检查和 prepared transport；移除旧模型字段 | 跨 Provider key、任意 env、IP/private destination、redirect、adapter mismatch 零传输 |
| `deepseek.ts`、`mimo.ts`、`provider.ts`、`orchestrator.ts`、`pricing.ts`、`inference-v2.ts` | adapter 消费 prepared object；合并旧/新 inference 入口，保留实际协议/usage 语义 | response/usage fixtures、两次尝试、金额边界与取消 |
| `deepseek-v2-seed-v1.ts`、`mimo-v2-seed-identity-v1.ts`、`g4-routing-policy-seed-v1.ts` | 删除运行时代码对 migration seed UUID/hash/历史时间的绑定 | 空基线可配置新版本，无固定历史 profile 依赖 |
| `legal-fingerprint-v1*`、历史 legal 常量映射 | 新 manifest/renderer 数据契约；不引用已删除实现文档的 hash | 双语 display digest、exact consent、完整 Provider disclosure |
| `web/src/server/admin/**`、`web/src/features/admin/**`、`web/src/lib/admin/contract.ts` | 新 DTO/external ID；策略编辑原子提交选项、时间规则、成员关系和默认项；删 cutover/legacy、部署注册、旧 report 操作；统一当前管理 RPC | 本地真实 Auth/TOTP 浏览器测试和 DB 权限测试；发布/readback 覆盖未来时段和非默认项 |
| `web/src/lib/cv/cloud-storage.ts`、storage adapters、CV builder 调用者 | 新 view/RPC、revision、ID；明文和解密后内容仅当前格式；严查加密转换和 stale-save | 双用户隔离、冲突、不丢有效的当前格式草稿、不误标保存成功；拒绝旧格式 |
| `web/src/lib/legal/terms-acceptance.ts`、`pending-terms-acceptance.ts`、`legal-display-v2.ts`、`web/src/content/legal/**` | 删除旧表 upsert 和 v1 mapping；当前内容由新 current 接口给出；仅针对所选项验证/取得 exact disclosure 接受记录 | 账户切换、未知 bundle、错误 digest、旧 acceptance 拒绝；接受 A 不代替 B/C，未选 Provider 不要求预先接受 |
| `web/src/lib/cv/schema.ts`、`storage.ts`、`draft-storage.ts`、`encryption.ts`、`encryption-storage.ts`、`web/src/components/cv-builder/hooks/import-cv.ts` | 所有入口只用当前 schema；删除 CV 5/6 union/transform、历史字段补齐、旧单文档 key 读取；云端缓存增加 project/user/instance/contract 分区 | 本地/导入/草稿/云端/解密均拒绝旧格式；当前格式正常往返；instance 改变不重放旧保存 |
| `web/src/server/supabase/admin-client.ts`、Admin request client | 生成类型和角色区分；Admin 使用用户 bearer，执行 producer 使用服务端角色 | service_role 无 Admin 用户资格；JWT 元数据伪造失败 |
| `backend-fake.ts`、`provider-fake.ts` 与 fixtures | 仅新 DTO，移除 `legacyV1` 接口；增加 A/B 与 A/C 集合及可控测试时钟；保持测试/生产开关限制 | fake 与真实契约一致；托管环境不启用 fake 或接受外部传入的执行时间 |
| `web/.env.example`、README 中环境表 | 删旧 aliases、未实现 Provider、build/manifest 登记变量；保留必要环境与 secret binding | env contract 测试与静态产物扫描 |
| `web/scripts/ai-metrics.mjs`、integration/smoke/evidence 脚本 | 改用新计量 schema/RPC；逐一确认脚本不会误写 hosted 库 | 原 loopback-only 安全测试继续生效 |
| `run-cfg001/002/003-fresh-reset.mjs`、`test-admin-bootstrap-upgrade.mjs`、`test-admin-drafts-upgrade.mjs` | 删除历史链 gate；以新 baseline/schema/security/reset 演练替代 | CI 不再引用旧时间戳和旧 fixture |

新自动化脚本优先 Node 24 原生 TypeScript，使用 `scripts/*.ts`。已有无关 `.mjs` 不为形式统一迁移。生成 Supabase 类型和 shared DTO 后执行类型检查；外部 ID 的 prefix parser 按实体类型区分，不能通过 `as` 把任意字符串强转为有效 ID。

### 兼容层补充核查清单

以下清单记录源码评估基线 `ccbeb1a4fc2baba9dbc2c15a4ba183a1be3558aa` 中确认存在的内容，作为本地删除与替代测试的审计定位。历史文件只从该 Git 基线查看，不恢复为当前入口。前表按模块概括覆盖，本表将容易遗漏的调用、转换器和测试入口列为 P4–P7 的具体交付项；实施时逐项核对删除及替代测试，完成状态以验证记录为准。

| 评估基线内容与源码定位 | 本轮处理 | 验收重点 |
| --- | --- | --- |
| `web/src/server/polish/inference-v2.ts`、`web/src/server/polish/provider.ts` 中 `toLegacyProviderRequest/Result/Usage`、`toInferenceRequestV2/ResultV2`、`toNormalizedUsageV2` 和旧 `PolishProviderRequest/Result/Usage` 类型 | 删除应用内部新旧推理契约的双向桥接；保留一个规范化请求/结果/用量模型。评估基线中的 prepared DeepSeek adapter 调用 `toLegacyProviderRequest`，须同步改为直接序列化官方 wire body，不能仅删除导出 | 真 adapter、fake、orchestrator 和测试只消费同一内部契约；保留协议字段、用量未知值、cache/reasoning 守恒和输出校验 |
| [polish/contract.ts](../web/src/lib/polish/contract.ts) 的 `polishAvailabilityLegacyDisplayDisclosureSchema` union；[use-polish-flow.ts](../web/src/components/cv-builder/polish/use-polish-flow.ts) 的 `legacyBundle`、可选 `legalDisplay` 与两套 accept 分支；`web/src/components/cv-builder/polish/polish-provider-annex.ts` 的固定 display-key 映射 | 改为唯一 DB 披露 DTO 和 exact disclosure 接受路径；删除旧标签投影、静态 bundle 白名单和旧接受调用。普通条款页面继续存在，按新内容来源渲染 | 缺少必要披露字段直接拒绝；未知披露不能转去静态旧附录继续执行；用户选择与同意始终绑定同一选项 |
| `web/src/server/polish/lifecycle-post.ts` 为 older/fake wiring 保留的 finalize 无 quota、再次读取和 reserve 快照回退；`web/src/server/polish/quota.ts` 的旧可选结果形状 | 随旧 lifecycle 删除这些旧接线分支，成功 finalize 按新契约返回结算状态及权威 quota；fake 实现相同完整契约。网络不确定和持久化失败按新账本的幂等/HELD 规则处理 | 不用旧 reserve 快照冒充已结算额度；旧返回形状不再被接受；结算未知状态不会被解释为成功或零计费 |
| `web/scripts/lib/metrics-logic.mjs` 的 `legacy_v1`、`legacy_pricing_v1`、NULL route 分组及旧 ledger 字段归一化 | 删除旧数据格式支持和专门保留 legacy 分组的测试，计量脚本只读取新 requests/attempts 及聚合契约 | 不自动补造 route/profile/价格；继续保留未知用量、金额下界和币种隔离；未知格式明确报错 |
| `web/scripts/lib/integration-ledger-evidence.mjs`、[run-integration-tests.mjs](../web/scripts/run-integration-tests.mjs) 的固定 profile/price UUID、旧 `expected_route_v1`、历史 bundle/runtime 和旧凭据变量 | 重建集成证据契约；使用本次初始化实际生成、随后明确选定并冻结的 option/profile/price/disclosure 身份；删除历史种子对象和旧环境变量依赖 | 仍严格验证指定 Provider 和配置，不因去除固定 UUID 而放宽为“任意当前目标”；新实例无历史数据即可执行受控 smoke |
| `web/src/server/polish/validate.ts` 的 `perItemPolishedCharCap` 历史别名；evidence 中 `isOfficialDeepSeekChatCompletionsEndpoint` 兼容导出；[polish-client.ts](../web/src/components/cv-builder/polish/polish-client.ts) 为旧 import 保留的重导出 | 调用者和测试统一到规范名称或明确的新模块接口，删除仅为旧名字/路径保留的导出。当前 client factory、接口和正常模块聚合可保留，不能把整个 facade 都当成无用代码 | 新代码无历史 alias import；从入口追踪运行时与测试引用，避免只剩测试依赖就一直保留桥接 |
| [admin-app.tsx](../web/src/features/admin/admin-app.tsx) 和 messages 的旧 alias 字段；[admin-control-plane.spec.ts](../web/e2e/admin-control-plane.spec.ts) 的 `withLegacyDraftPreparation`；`web/test/fixtures/admin-contract-v3.json` 的 legacy mode；[package.json](../web/package.json)、[db-tests.yml](../.github/workflows/db-tests.yml)、[run-db-tests.test.mjs](../web/scripts/run-db-tests.test.mjs) 的旧 gate 命令/路径断言 | 同步清理管理 UI 字段、双语标签、fixture、E2E、package scripts、workflow steps/path filters 和“要求旧命令存在”的测试；改用新初始化环境直接验证草稿/发布/权限 | 不保留 legacy mode 来让测试通过；删除脚本后没有悬空命令或 CI 路径；实际 Auth/TOTP、发布和拒绝路径仍有覆盖 |
| [schema.ts](../web/src/lib/cv/schema.ts) 的 `cvSchemaV5/cvSchemaV6`、legacy section 类型、`persistedCvSchema` union/transform；[import-cv.ts](../web/src/components/cv-builder/hooks/import-cv.ts)、[draft-storage.ts](../web/src/lib/cv/draft-storage.ts)、[cloud-storage.ts](../web/src/lib/cv/cloud-storage.ts)、[encryption.ts](../web/src/lib/cv/encryption.ts) 的调用 | 删除旧格式 schema、版本转换和补字段逻辑；所有调用者直接使用唯一当前 schema，不保留 `persistedCvSchema` 旧名 alias。加密 envelope 只支持其当前格式，解密后的 CV 也必须为当前格式 | CV 5/6、缺失/未知版本、缺少必填字段在本地导入、读取、草稿、云端和解密后全部拒绝；不把修改版本号当成升级 |
| [storage.ts](../web/src/lib/cv/storage.ts) 的 `LEGACY_CV_STORAGE_KEY`、`readLegacyCvData`、`initializeCvDocumentLibrary` 旧单文档回退 | 删除对 `typst-cv-builder:data` 的读取、迁移和回退；只按当前文档索引/记录结构初始化和读取；不提供临时迁移工具 | 即使旧 key 的内容是 v7，也不能从旧 key 恢复；无当前库时只走最新的新建流程，不从历史 key 补造文档 |
| [schema.test.ts](../web/src/lib/cv/schema.test.ts)、[storage.test.ts](../web/src/lib/cv/storage.test.ts)、[import-cv.test.ts](../web/src/components/cv-builder/hooks/import-cv.test.ts) 及相关草稿/加密 fixture 的旧格式升级断言 | 删除“升级 CV 5/6 成功”“缺字段自动补齐”“从旧 key 恢复”的成功用例，替换为当前格式往返和旧格式拒绝的测试；旧输入只作为最小负向 fixture | 不能为了让旧测试通过保留 parser、桥接器或迁移 helper；失败不覆盖有效当前文档，不写入云端 |

新增 Provider 选择还要求同步替换 [中英文法律展示内容](../web/src/content/legal/zh.ts)及 `web/src/server/polish/legal-fingerprint-v1-descriptors.ts` 中“界面不提供 provider selector”/`fact.route.no-selector.v1` 的旧产品事实。这是内容契约更新：通过新审核内容、bundle/disclosure 和 digest 发布，不在原不可变版本上改字。G8 同时校验中文与英文，不能只完成选择控件却继续展示旧事实。

### 全仓仅支持最新格式

用户已明确取消本地兼容例外。JSON 导入、本地文档、本地/云端草稿、明文云端和加密云端共同使用一个当前内容 schema；当前源码版本为 `CV_SCHEMA_VERSION=7`，本次不因 DB 重建另行增加内容版本。存储索引和加密封装也各自只接受唯一当前格式。删除全部 CV 5/6 转换、历史存储读取、旧字段补齐及过渡工具，不提供兼容开关、手动升级入口或“只在导入时保留”的转换器。

遇到旧格式、未知版本或不完整内容时，返回明确的不支持/校验失败状态，禁止改写 schemaVersion、补齐旧字段或把失败的读取当成成功保存。当前格式文档继续正常读写；导入和读取失败不能覆盖有效的当前文档。旧单文档 key 不再查询或转换；本次不通过清空整个 localStorage 实现代码清理。新建文档的默认值由当前新建流程提供，读取历史数据不能借用该流程隐式升级。

`normalizeSectionOrder` 等被编辑器与 Typst 渲染使用的 helper 按当前格式语义收敛：取消为历史数据缺字段兜底的调用，当前 schema 必须验证必填结构；当前 UI 排序行为由当前合法输入驱动。正式 Provider wire 协议标识和现用加密 envelope 版本继续表示当前协议；正常错误处理和网络不确定性不是旧格式接受通道，不得被改造成兼容回退。

P7 提交全仓兼容残留清单，范围覆盖 `web/src`、`web/scripts`、`web/e2e`、`web/test`、Supabase 配置与新 migrations、package scripts、CI、注释和当前文档。逐项检查旧符号/格式/环境变量、版本 union、历史默认值、导出 alias、双执行链、升级入口及其引用，从所有应用和工具入口验证不可达且实现已删除；本地路径同样要求零历史兼容引用。旧兼容实现即使没有生产调用者，也必须删除，不能改名、移动到 utilities 或留给测试使用。

旧字符串仅可出现在明确拒绝旧输入的最小负向 fixture、旧基线到新基线的一次性 reset 演练、迁移删除清单，以及与兼容实现无关的真实产品内容中。这些记录不能提供旧契约解析或执行能力。当前正式协议版本不按字符串机械改名。所有声称支持旧版本、升级成功或保留 legacy mode 的文档、注释和成功测试都必须清理；此前“本地保留项”不再适用。

## 迁移与文档清理清单

- 删除 `supabase/migrations/` 当前 60 个 SQL 文件；创建全新 CLI 生成的基线文件。不得把旧文件转存到仍会被测试或部署 glob 扫描的目录。
- 旧代码和 SQL 可以通过评估基线 Git commit 找回；普通仓库工作树不复制一套 archive migrations。
- 不提供旧表同名 view、旧签名 wrapper、ignored 参数（例如 `p_project_ref`）、旧 ID 转新 ID 映射、双写、旧快照 fallback 或历史价格回填。
- 删除本地旧 JSON/历史文档/草稿兼容 schema、旧单文档 storage key 读取、多版本 transform、旧字段补齐、历史名称导出和升级成功测试；所有入口只支持最新格式，不发布迁移器或旧格式恢复工具。
- 旧 Profile/Price/Policy/Legal/Runtime 版本值不导入新库。新运行配置通过新接口创建，外部 ID 在本环境生成。
- 删除旧 `*_v1_upgrade`、legacy pricing、旧 deployment admission/cutover 的断言；将其中仍正确的权限/并发/业务场景移入新测试，不因文件名旧而丢失覆盖。
- 重新整理 `docs/admin-control-plane-*`、`admin-development.md`、`admin-operations-draft.md`、`admin-draft-preparation.md`、`admin-runtime-simplification.md`、旧 provider/runtime v1/v2 文档。最终文档集合为当前数据库设计、当前执行/结算契约、Admin API、运营说明和发布手册；历史评审记录留在 Git。
- 旧 legal evidence 中引用实现文档字节的部分，在删除文件前由新 manifest 和 renderer 替换并测试；不能留下可点击但内容已变的“历史证据”链接。
- 同步 `README.md`、`README_CN.md`、`web/README.md`、环境样例和测试命令。注明 prod/test 是独立项目，各自 Git 集成里的 production branch 分别为 `release`/`main`。
- 本次三个设计文档在实现后更新“待实施”状态和实际证据；未完成项不得提前改为已完成。

## 验证矩阵

验证使用 disposable 本地 Supabase 和 CI 容器；普通测试不得使用 prod/test URL。既有 DB runner 的 loopback 检查、完整凭据检查和 child-process 错误传播保留。

| 门槛 | 场景 | 可交付证据 |
| --- | --- | --- |
| G1 空库重建 | 所有新 migrations 逐文件在单事务执行、必要目录数据、默认关闭状态；重复本地 reset；扩展与 owner 初始化；初始化前后 ready 行为 | 两种 migration digest；31 表与 API catalog；零历史对象；未初始化写入拒绝、合法原子初始化后 ready |
| G2 Supabase 规范 | 外部 ID 格式/唯一/碰撞 5 次边界；普通客户端不可改 ID；search_path/volatility；默认 ACL；RLS、view invoker 和列权限 | 以 anon、本人、他人、Admin、service_role、owner 分别执行允许和拒绝路径 |
| G3 远端模式重建演练 | disposable Supabase 库先装旧链及合成用户/session/MFA、Storage 元数据、cron/ACL/平台哨兵；hosted/rehearsal 唯一方法为 `application_allowlist`，覆盖清理、各 phase 中断、重复 resume、追加第五至第八迁移和 checkpoint 丢失拒绝 | 实际删除集合及前后 catalog/history/12 类平台指纹；method、cleanup SQL digest、retired inventory digest、baseline/full manifest digest 匹配的证明；原生删除 Auth/session/MFA 是历史观察，用户现已允许删除这些数据；原生清理还触及 SSO 配置、平台策略与扩展，当前工具仍限已验证的应用白名单路径；仅 local reset 不足以替代 |
| G4 管理发布 | 首管理员初始化、last-admin、session 删除/封禁/撤权、TOTP；active generated Auth FK 阻止未撤权管理员删除、保留撤权历史；owner 初始化/法律 current 的 SYSTEM 审计与幂等；owner 属性/成员/Auth&Storage ACL 拒绝；草稿/校验/发布/指针/readback/reopen；幂等相同与不同 payload；空集合、跨策略引用、默认项不在集合、未使用选项 | DB 测试 + 真实 Auth 浏览器 E2E；直接 RPC 也不能绕过；校验 digest 覆盖所有时段/选项/成员/默认项 |
| G5 选择与冻结 | A/B→A/C 和等锁跨界；显式选择、过期列表；reserve 后修改 defaults/pointer/价格发布；两次 attempts；所选/未选 key 缺失；能力目录与代码不一致 | 锁后时刻确定资格；冻结同一选项/版本、不重新选路；未选项故障不阻断健康项；不支持的配置零传输 |
| G6 额度和金额 | 并发 reserve/start/finalize；gate/start 争用；UTC 跨日和上海时段；切换 Provider 的共用额度/限流；金额溢出；cache/reasoning 守恒；不同币种 | 单次扣次/退款/计量；换 Provider 不重置限额；未知≠0；锁序无环；不发生 partial settlement |
| G7 取消和未知 | 取消早于/晚于完成、reserve/start/complete 响应丢失、completion 写入失败、零 attempt 超时、STARTED 后迟到 complete、unknown sibling、reconciler 并发 | 每个 attempt 只发放一次 may_transmit；不确定状态保留 HELD；迟到事实可填未终结 attempt；不重复传输/结算 |
| G8 CV 和同意 | 当前格式 JSON 导入/导出、本地文档/草稿、明文/密文存取、模式转换、乐观锁、双账户隔离、过期缓存、实例重建；所有入口拒绝 CV 5/6/缺失与未知版本/必填字段缺失，旧 key 不恢复；切换选项的披露及 exact consent | 浏览器流程和 DB/客户端负向用例；当前格式正常往返，旧格式无升级、无副作用；旧接受记录不授权新目标；未接受项仍可查看，展示/预选不代替同意 |
| G9 构建和契约 | unit、typecheck、lint、server build、static build、静态无服务端密钥/Admin/AI 检查；生成类型 diff；全仓兼容残留及 package/CI/脚本引用检查 | 干净 checkout 可重现；全部本地/云端/AI/Admin/工具路径无旧 RPC/格式 fallback/历史桥接；已删除无调用者的 legacy 实现和过时文档/注释 |
| G10 hosted test | 精确 merge SHA 的新基线、Admin/CV/同意、权限、实际候选验证；Preview 及独立静态预览的项目映射；新旧页面/请求拒绝检查；有预算的 Provider smoke | test 验收含非默认选择、逐 Provider 同意、当前格式与实例屏障；故障注入留在本地/CI，普通 CI 不自动付费 |
| G11 prod 关闭态 | 与 test 同 SHA；两种 digest 和迁移/权限一致；AI off；无旧 schema/API/cron；prod 各时段配置和法律目标就绪；Production/Pages 项目映射正确 | DB-ready 与各应用部署分别记录，再按 allowlist 开启；旧部署不能重放写入；不复用 test 的配置 ID/同意记录 |

用户选择功能至少覆盖以下用例，证据归入 G4–G8，不因仅默认选项成功而视为通过：

1. 当日 09:00–18:00 可选 A/B、其余时间可选 A/C；在 09:00、18:00、午夜、周日到周一和无明确规则的兜底边界，按 Asia/Shanghai 与半开区间得到唯一集合。A/B/C 为合成 fixture；真实配置可选择已支持并完成验证的 DeepSeek、MiMo、Gemini profiles，不能只添加 Provider 名称就成为可执行候选。
2. 首次默认预选 A，用户可选择非默认 B；未接受 B 披露时先完成 B 的同意，不能用 A 的接受记录代替。相同且仍有效的精确接受记录可复用，无需接受未选 C。
3. 页面在 17:59 显示 A/B，18:00 后首次提交 B 返回 OPTION_UNAVAILABLE，零占额、零 attempt、零传输；刷新后清空 B 并由用户重选。相同 policy/generation 下仍有效的 A 可直接提交，并记录新命中的规则。
4. B 在 18:00 前已 reserve，之后相同 key/fingerprint 重放返回原冻结请求；允许的第二次 attempt 仍用 B。不能把同 key 改成 A；切换选择要新 key，原请求按取消/结算语义处理。
5. pointer/generation 或所选配置身份发生变化返回 CONFIG_CHANGED；篡改 profile/price、跨 policy option 和缺失 option 的提交均拒绝，不静默回退到默认项。
6. B 凭据失效时显示 B 不可用，A 仍可执行；默认 A 不可用时不自动选 B。发布/readback 仍须验证每个候选，而不是只验证当下默认项。
7. 在 A/B 间切换仍共用用户日额度、分钟限流和全局准入限制；计量与价格归属实际冻结的选项。集合或默认项变更必须创建新不可变策略版本。

可控时钟仅用于本地/CI 测试依赖和 fixture；可由测试 owner 在 disposable 库替换时钟依赖，但该替换不得进入 migration 或构建产物。真实 reserve 在获锁后读取 DB 时间，公开 API 不接受用户传入的“当前时间”。测试应同时覆盖规则解析和实际事务资格校验，不能只有前端 mock。

整体审查补充用例归入既有门槛，均是实施验收要求，实际通过情况记录在实施验收中：

| 门槛 | 必需补充场景 |
| --- | --- |
| G1/G2 | 无 environment 或 current 初始化时 ready=false、业务写入拒绝；instance 重建后旧 CV create/条款接受/AI 请求拒绝；invoker view 真实列权限、非暴露 schema 与显式 ACL 一起验证 |
| G4/G5 | 创建完整策略的临时 option key 解析；跨 Provider/disclosure/bundle 错配；seal 后新增/修改披露拒绝；价格接续原子性、有效区间边界/空档和报告依赖变化；不可变版本操作使用父 revision/expected status |
| G5/G6 | 17:59 发起但 18:00 后获锁的请求；UTC 跨日等锁；availability 组装期间 generation 改变；用户删除与 reserve/start/complete、管理员删除与撤权争用 |
| G7 | 同 key 两个执行者并发；attempt_start 成功但响应丢失后重放 may_transmit=false；600 秒后零 attempt 释放、STARTED 请求 HELD 后迟到 complete 正常结算；terminal UNKNOWN 不被覆写 |
| G8 | 直接明文写 RPC 拒绝旧/缺字段 JSON；DB 只验证加密封装和声明版本，客户端在加密前及解密后拒绝旧内容；更新响应丢失先读回 revision，失败不覆盖有效当前文档 |
| G3/G9 | 缺失 checkpoint 但新基线已存在时禁止重复 reset；部分 migration/初始化/部署的显式 resume；`S2` 只追加 migration；旧 migration 链从固定 Git 基线取到临时目录演练，不重新放回工作树 |
| G9–G11 | 实际 merge SHA 的证据、PR preview 历史冲突处理、migration 单事务限制；跨 workflow 发布锁；错误 Pages/Test 项目映射被拦截；release 已前移而仅一个产物失败时补齐该产物 |

P0 必须特别抽取这些当前实现行为，防止测试迁移时退化：取消已传输请求扣一次、Provider 失败/无效输出退用户额度但保留成本、unknown held、首次 Provider admission 的全局计数、UTC 日桶、最多两次 attempt 和不可跨 Provider fallback。

catalog 验证检查对象职责、函数签名/owner/ACL、RLS、约束和 view 选项，不对整段 `pg_get_functiondef()` 做运行时准入 hash。生成的对象清单可以作为测试期 diff，但不得重新引入人工维护的多代 authority manifest。

仅对实际改动运行适当检查。本轮实际执行的数据库、代码与构建检查在本地验收记录中列出；未执行的 CI 和 hosted 门槛单独保留。

## CI 和发布工具

保留 `.github/workflows/ci.yml` 的 server/static 双构建及 fake smoke，改接新契约。`.github/workflows/db-tests.yml` 使用相同固定 CLI 和 PostgreSQL 主版本，删除历史 predecessor reset，增加 G1–G9 的 DB 部分；路径过滤覆盖全部新 SQL、领域代码、DTO、生成类型和切换脚本。

新增 `.github/workflows/database-rebuild.yml`，仅 `workflow_dispatch`。计划的输入与约束：

| 输入或设置 | 规则 |
| --- | --- |
| `target` | 枚举 `test/prod`，分别绑定独立 GitHub Environment 和独立 project ref/secret |
| `source_sha` | 必须是完整 commit SHA；执行中 checkout 后验证 HEAD；不能在 reset 时解析一个移动中的 `main` |
| `mode` | 默认 `plan`；可选 `rebuild/resume/verify`；rebuild 仅首次清空；resume 明确剩余 phase 且不 reset；verify 只读 |
| `expected_project_ref` | 与环境配置、连接目标、Supabase URL 三方一致；test/prod ref 不得相同 |
| `baseline_digest`、`migration_manifest_digest` | 前者固定最初四条基线；后者覆盖当前 SHA 的全部迁移，当前为四条基础、第五条 owner 审计/FK 增量、第六条延迟约束权限修复及第七条 DeepSeek Responses 切换、第八条 Gemini Interactions 接入；prod 要求 test 同 SHA/两种 digest 的验收记录 |
| `method`、`cleanup_sql_digest`、`retired_inventory_digest` | hosted/rehearsal 只接受 `application_allowlist`；清理 SQL、旧对象清单与演练证明和持久 intent 必须匹配，不允许更换方法或临时扩大删除范围 |
| `rehearsal_evidence` | 手动 workflow 输入 JSON，写入 runner 临时文件后传给工具；证明的 `source_sha` 必须等于当前完整 SHA，同时要求 `old_chain_passed` 和方法/两个清理 digest/两个 migration digest/CLI/平台保留与恢复结果匹配；不要求把自引用 SHA 的证明提交进该 SHA |
| destructive 确认 | 手动运行 rebuild 时明确输入目标项目标识和“清空业务数据”确认值；不复用普通 promotion 作为清库授权 |
| 并发 | 同一环境的 rebuild/resume 与 promotion 共享串行锁/维护记录，`cancel-in-progress: false`；现有 promote-release 独立 group 不足以覆盖重建流程；执行前持久化意图及各 phase checkpoint |
| 构建目标 | 固定 Vercel Preview/Production 与 Pages 的 Supabase 项目映射；核验仓库变量和部署环境，不以相同 SHA 代替环境验证 |
| 凭据 | owner DB 连接及必要 access token 使用 Environment secrets；CLI/psql 通过环境传入，不回显、不进入 artifact |
| 配置和保活保留 | 保留 GitHub OAuth/SSO、Site URL、redirect allowlist、项目 ref/URL/keys、Git 集成及 keepalive 仓库变量；新基线重建 `keep_project_active()`，Action 只接受当前布尔 `true` |
| 结果 | 只输出目标、SHA、phase、baseline digest、migration/catalog 验证摘要及失败点，不输出业务内容或 key |

现有 `scripts/db-rebuild.ts` 实现 plan/rebuild/resume/verify；hosted/rehearsal 通过 `supabase/retired-application-reset.sql` 和 `scripts/database-retired-objects.json` 按明确清单清理旧应用对象，不调用原生 remote reset。`scripts/db-initialize.ts` 提供仅本地的原子环境/首管理员/法律 current 初始化，hosted 初始化由受控重建阶段执行；`scripts/db-contract-check.ts` 验证 catalog 和权限。cron 迁移只定义私有函数，初始化后另行注册并默认停用。

workflow 必须先在默认分支存在，GitHub 才能正常提供手动入口；P1 因此可单独提前合入。准备工具的提交不能删除旧 migrations，也不能自动修改线上。主重构 merge 完成后再通过完整 SHA 指定新基线。

现有 Promote Release 保持日常职责。P1 增加维护记录检查：记录激活期间，任何模式的 promotion 都只能放行目标 project、SHA、两种 digest 匹配的 prod DB-ready 版本；不能通过选择“日常模式”绕过。无维护记录的日常发布不要求重建记录、不执行 reset。门槛必须接入 workflow。rebuild 完成 DB-ready 后结束并释放执行锁，再运行 promotion；维护记录持续到切换验收完成。切换期间 main/release 冻结；修复 `S2` 先在 test 验收、prod 只追加缺少的 migration/幂等初始化，再 promotion。release 已前移但单个应用部署失败时仅续跑该部署。详细 phase、PR preview/required check 处理和平台保留边界见发布手册。

## 完成定义

重构开发完成需要：新数据库可从空业务库重建；31 张目标表、完整 view/RPC 和权限已实现；用户可按时段集合选择 Provider，Admin 可管理集合/默认项，所选配置和同意在 reserve 冻结；本地/云端 CV、JSON 导入、草稿、AI/Admin/条款及工具均只支持最新契约和格式；旧 60 migrations、旧公开入口、全部历史兼容/legacy 实现及可达引用退出工作树，无本地保留例外，补充核查清单逐项完成；相关测试、fixture、脚本、CI、注释和文档完成收敛；本地和 CI 门槛全部通过；远端模式演练证明 migration history 与平台保留边界；发布工具固定目标和 SHA 且不会重复清库。

线上切换完成另需：test/prod 实际验收、分支和应用版本一致、默认关闭到受控开启流程成功、旧客户端不能访问旧接口、无重复/悬空 cron、自动部署恢复，且后续一次增量迁移发布正常。源码完成与线上切换完成分开记录。

## 本轮本地交付与发布前门槛

当前工作树已替换旧迁移链和调用者，完整新链为最初四条冻结基线、第五条 owner 审计/管理员 active Auth FK/角色检查增量，以及第六条延迟策略图约束权限修复、第七条 DeepSeek Responses 能力和披露更新，以及第八条 Gemini Interactions 接入和三家法律目录；Admin、Provider 选择、精确同意、当前 CV/草稿格式及本地测试入口均使用新契约。Admin 支持配置身份与版本、当前管理员资格的独立查看；版本生命周期使用父 revision，成员变更使用成员 revision。时段集合与默认项通过原子 JSON 配置创建，价格接续通过单个管理事务提交完整接续参数，验证/检查报告显示有效期并绑定全部候选。

已执行的本地验证包括空业务库重建、真实角色 SQL 与 Auth/Data API 验证、真实 Admin 登录/TOTP/profile 身份创建/成员变更浏览器流程，以及无托管凭据的编辑器流程；版本草稿/发布链由 SQL 测试验证，具体命令见 [web 开发说明](../web/README.md)。这不等于全部发布验收完成。G3 本地独立演练已通过：旧 60 条到四条基线的 `application_allowlist` 清理、迁移后中断与重复 resume、同 instance 追加第五至第八条迁移、12 类平台指纹前后相同、缺 checkpoint（含同时缺 history）时拒绝 rebuild，以及构造 `reset_started` 状态后以匹配方法/digest/catalog 的证明恢复且不重复清理。原生 reset 删除 Auth/session/MFA 是历史演练记录，用户现已允许丢弃这些数据；方法选择仍须保护配置，不据此直接启用原生 reset。本地证据不证明后续 PR 阶段的 CI 结果；G10/G11、任何 test/prod SQL/重置、使用 test/prod 数据库的付费 smoke 和线上发布均未执行。不能以本地 `db reset --local` 成功替代这些门槛。

G3 运行证明保存在本地 `tmp/remote-rehearsal-proof.json`，可审查快照见[本地证据](evidence/database-rebuild-local.json)。其中 `constructed_checkpoint_recovery_passed=true` 表示人工构造 checkpoint 的故障注入；`checkpoint_loss_recovery_passed=false` 保留原义，不声称实测 kill 在 `reset_started` 窗口。最终链为八条、baseline 仍为原四条；合入后仍须按实际 merge SHA 重新核验发布材料。

用户提供本地 Provider keys 后，显式 opt-in smoke 已对 DeepSeek/MiMo 各完成一次真实生成调用，以独立本地库验证新配置发布、所选模型、输出校验和结算/幂等。此步骤发现并通过第六迁移修复 authenticated COMMIT 的延迟图约束权限；常规 DB 测试已增加真实角色提交与回滚回归。真实模型测试不进入普通 CI，也不替代使用 test/prod 数据库的 G10/G11。结果见[本地验收记录](database-rebuild-verification.md)。

按后续要求，DeepSeek 已完整切到官方 Responses，MiMo 保持 Responses。当前代码、能力目录、profile 创建和 Provider defaults 均拒绝旧 Chat 配置；第七条迁移仅替换没有 profile/default 引用的旧能力，否则原子拒绝，不能修改冻结版本使其悄悄换协议。新 bundle/disclosure 重新封存并要求新同意，旧封存字节保留；AI 关闭、指针清空，需重新配置、校验和 reopen。已对两家重新执行各一次 Responses 付费验收，验证真实响应对象、严格 wire 字段、输出和结算/幂等；这份新证据不复用此前 DeepSeek Chat 调用。

Gemini 接入沿用同一选择、发布、冻结、同意和结算流程，使用官方 `gemini-3.8-flash` 与稳定 `/v1/interactions`，不添加 OpenAI 协议代理或自动回退。第八条迁移追加能力、Provider 和新三家法律目录，更新 Admin 精确校验，保持旧冻结配置及封存字节不变；新目录生效时关闭 AI、清空策略指针并推进 generation/close cycle。Google 请求使用 JSON Schema、low thinking、`store:false`、无用户标识及历史续接；usage 的 visible output 与 thought 合并为计费 output，reasoning 仅记录子集。独立合成文本验收使用 `CV_LIVE_PROVIDERS=GEMINI`，不重复调用已有两家；结果与 Google 免费/付费数据处理的核验边界见[本地验收](database-rebuild-verification.md)和[发布手册](database-rebuild-runbook.md)。
