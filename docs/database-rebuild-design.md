# 数据库第二轮重构设计

状态：本地实现与验收完成，唯一契约为 cv_app_db_2。所有改动仅在本地验证；test/prod、Git 集成、远端分支和线上发布尚未操作。实际证据见 [验证记录](database-rebuild-verification.md)。

## 目标与边界

本轮替换上一轮配置身份/版本、发布/退役、验证报告/readback 模型。业务当前状态直接编辑；后台在保存事务内完成约束、审计和并发检查。配置历史保存在每表结构化 audit，请求执行与计价读取预留时冻结的独立快照。

CV 文档继续只支持当前 v7 和当前加密 envelope；Auth/OAuth/SSO 项目配置及 keep_project_active 保持。新的 app_context/写入契约不接受旧字段或旧客户端。内部配置使用整数 ID；请求、简历、法律阅读目标保留独立外部标识。数据库实例 ID 继续防止重建后自增 ID 重用造成串写。

## 当前业务模型

| 表 | 字段与职责 |
| --- | --- |
| ai.adapters | 代码维护的只读 id/name。1=DeepSeek Responses，2=MiMo Responses，3=Gemini Interactions；固定 ID 不复用，不再有 provider code/capability 目录。 |
| ai.configurations | id、name、adapter_id、endpoint_url、model_id、credential_ref、legal_document_id、enabled、revision。name 是用户可见别名，不要求唯一。 |
| ai.prices | config_id 主键、currency、普通输入/缓存读取/缓存写入/输出四项整数 nanos_per_million 费率。与 configuration 同读同写、共用 revision，无独立开关/版本/价格时间线。 |
| ai.routing_rules | id、weekday、start_minute、end_minute、enabled、revision。时间三列全 NULL 为兜底；普通规则三列全非 NULL，ISO weekday 1–7，分钟区间为 [start,end)。 |
| ai.routing_rule_configurations | rule_id/config_id 联合主键、is_default。与规则作为一个保存单元；不得有重复成员，启用规则恰好一个默认成员。 |
| ai.runtime_control | 唯一行 id=1；enabled、audience、三项额度、revision。没有 policy 指针、generation/close_cycle 或发布票据。revision 是整体状态与并发令牌，不是业务版本。 |
| ai.allowed_users | auth_user_id 主键；状态变化由自己的 audit 记录。 |

同星期启用区间不得重叠；恰有一个启用兜底。时区统一 Asia/Shanghai，不增加任意时区/priority。跨午夜规则拆为两段。默认项后来被停用不阻止紧急停用，也不静默替换供应商；剩余可选项由用户明确重选，空集合明确不可用。

配置改 adapter/endpoint/model 时，必须重新明确提交价格及匹配披露。同一保存事务完成配置、价格、audit、revision 和关联检查。价格变化、别名变化不制造新发布实体。

## 接入实现与可编辑 endpoint

协议实现与实际接收方分开。adapter 代码负责鉴权头、请求与终态字段、标准化 usage 和固定请求行为。配置保存实际 endpoint、key 引用、model 及匹配的法律目标；当前不建立单独供应商管理平台。

相同 wire 格式不能证明相同缓存/训练/留存政策，也不能保证相同 usage 语义。与现有 adapter 合同不同的接入必须新增明确实现，不通过数据库任意 parser/header JSON 或自动 fallback 凑兼容。

所有 adapter 使用共享受限 HTTP 出口。仅允许 HTTPS、公网目标，无 URL 凭据/fragment/密钥 query；拒绝重定向。校验 DNS/IP 必须约束实际连接，不能在校验后又让 fetch 自行解析为私网。测试 fetch 注入只存在于明确测试路径。

credential_ref 只允许 AI 专用环境变量命名空间，实际 key 不进入数据库、audit、浏览器或日志。可预测轮换使用新引用名，旧引用留至在途结束；冻结引用名称不等于冻结尚未读取的环境变量值。prepare 后一次 transport 两次 attempt 共用捕获值。

对上游发送的伪匿名标识按配置/接收端隔离，不按 adapter 向多家服务发送同一个标识。原始用户 UUID、邮箱与简历标识不作为该字段发送。

## 条款与同意

legal.documents 是当前文档：TERMS、AI_COMMON、AI_PROVIDER。普通条款和公共 AI 条款各一个当前目标；接入披露显式记录 recipient_name、adapter_id、规范化 endpoint_url、model_id 和双语标题/正文/生效日。相同 adapter/model 可有不同供应商、区域或账户条件的多份披露，不能再按协议/model 自动套官方条款。

双语正文使用 TEXT 和统一受限 Markdown；不保存 JSONB，也不另建翻译/章节/段落 CMS。禁原始 HTML、外部图片和危险链接协议。摘要由 DB 根据正文及授权 scope 生成，包含实际接收方、adapter、endpoint、model、生效日期和双语正文，排除 enabled、审计时间及通用 revision。

legal.acceptances 当前行按 user/document 唯一，保存 document_audit_id 和接受时间；不另设 revision，也不重复 accepted_digest/accepted_document_revision。AI 确认一次原子接受 common/provider 两项目标。阅读参数固定文档外部 ID、audit ID 和摘要；接受参数固定文档内部 ID 与 audit ID，数据库按该历史文档摘要核对当前有效目标。任何一项失配都不替换最新正文。

文档与接受记录各有完整 typed audit。历史 reader 只返回公开正文白名单，不公开接受者/操作者等审计数据。只公开曾启用的目标。阅读页按固定 common/provider 两个 audit 快照组合，不拼当前公共条款和旧披露。

新 reservation 核验当前有效的目标及接受摘要；普通 current 更新不改写已经预留请求的证据。如果必须阻止既有请求继续发送，显式停用/取消。内容相同而管理字段改变不迫使用户重新同意。

## 请求、尝试与计费

ai.requests 保留 req_ 外部标识、按 owner 隔离的 client_request_key/request_fingerprint 幂等校验、control_revision、state/outcome/charged、reserve_day/provider_admission_day 及预留/进度/取消/完成时间。请求级用量和完整/已知估算费用由最多两条 attempt 聚合读取，不再保存一套重复结果。无配置版本 FK、重复币种、usage/known_usage JSON 或 12 个重复汇总列。

ai.request_snapshots 仅以 request_id 为主键，预留事务只 INSERT。冻结实际 config/adapter/endpoint/model/keyref/contract、配置 audit 引用、四项费率和币种，以及 common/provider acceptance audit 引用。时间规则在准入时校验，规则变更由独立 audit 保留；快照不再复制整份规则。真实 key、简历正文、输出和原始用户标识不复制进快照。

ai.attempts 以 request_id/attempt_no 为主键，最多两次；保存状态、发送/可能计费/是否可重试、终态事实摘要、开始/结束时间、六项结构化 token 用量及估算结果。不再有独立 ID/external_id、Provider 真实账单空槽。

NULL 用量是未知，0 是已知零。reasoning 包含在 output，不重复收费。SQL 按冻结四项费率计算、一次取整并处理溢出，不相信应用提交的金额。完整估算与已知下界分开，缺 usage 不当作免费。

重放 reservation 不授予再次发送；STARTED/UNKNOWN 不自动重发；HELD 继续保留占额；终态/日桶只结算一次。改价、换地址不重解释旧事实。

停用 control 或 config 时持久写受影响非终结请求的 time_canceled；重新启用不清除取消。attempt 授权与停用使用同一锁序，不能发生 off→on 后旧请求复活。已经传输的迟到事实仍接受并按快照结算，不因停用或删除用户而丢失费用。

## 额度、统计与审计

user_quota_daily 只保留用户/UTC预留日/reserved_count/charged_count；global_quota_daily 只保留首次发送日/admitted_count；rate_minutes 只保留用户/分钟/request_count。三者对应不同准入事件，不合并。

配置日统计集中记录成功/失败/取消/释放、请求与尝试次数、token 下界、原币估算和不完整计数，统一按 UTC 预留日。全球首次发送准入次数按发送日单列，不能混入预留日结果图。历史配置/接入/model/currency 维度固定，不能用 current 配置重新贴标签。

可变配置、价格、规则、成员、运行设置、允许用户、文档、接受及管理员资格各自 typed audit；共同记录 audit ID、来源对象、action、可信 actor、operation_id、时间和完整行快照。当前表不机械重复保存四个创建/修改 actor/time 字段。audit 不含密钥或简历正文。

当前行删除不级联抹除历史；未结算请求及其 snapshot/acceptance/document audit 引用不提前清理。按既有保留政策协调账户删除、去身份化、日桶与历史清理，不能用审计 FK 永久阻止账号删除，也不把全部个人历史无条件永久保存。

## Admin 界面

六个业务入口：AI配置、时间规则、运行设置、用量与请求、账户与权限、操作记录。使用统一摘要列表，每行右侧 View/Edit；只读对象仅 View。价格属于配置弹窗，候选/default 属于规则弹窗，adapter 仅作为只读选择项。

后台读写统一以有效账号、实时 Auth 会话和当前管理员资格授权。不要求 TOTP、AAL2 或近期二次验证，也不提供绑定/验证页面。匿名、普通用户、已撤权管理员和失效会话不能读写；实例、并发修订、幂等操作、最后管理员保护和审计继续保留。

查看以字段和正文展示，编辑使用明确输入组件，移除 Object.entries 卡片/原始 JSON 展示、身份版本切换、发布/退役、验证票据及 digest 输入。保存成功失效相关缓存并保留分页/筛选/滚动位置；失败保留表单，冲突不自动更新 expected_revision 重提。

手机与宽屏复用同一套组件；窄屏摘要折行，操作按钮靠右，Dialog 接近全屏、头尾固定、中间滚动。背景读取不能覆盖脏表单；旧请求回调不能关闭新 dialog 或跨账号/实例覆盖数据。

## 唯一新迁移基线与发布边界

本轮明确替换上一轮十条 migrations。新文件由固定版本 CLI 创建，按 foundation、各 schema tables、跨 schema constraints、各 schema functions、public API、catalog/jobs 分阶段。每个文件支持事务及历史原子记录，权限默认收紧，public 接口最后开放。

supabase/baseline.json 显式列出本次 15 条基线全部文件；不再以最初四条或任何固定文件数推断基线。本轮尚未线上部署，按用户授权直接修改原基线移除 TOTP helper、布尔参数与所有调用者，不追加兼容迁移，并重新构建本地测试库。正式发布后基线冻结，后续修复 append-only。真实 key、管理员 UUID、运行配置不写死进迁移；固定 adapter/审核后的条款随迁移，本地测试数据单独准备。

先完成本地重建、SQL/API角色约束、竞态、Admin浏览器及两种构建验收。同步更新初始化/重建工具、清理清单、类型和fixture。test/prod 依然监听既有 main/release，GitHub keepalive 与 SSO/OAuth 配置保留，本轮不触发这些环境的重置或发布。
