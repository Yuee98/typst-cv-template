# 数据库重构实施计划

本轮执行用户确认的第二轮简化方案。授权范围为代码、全新 migrations、文档和本地测试；不操作 test/prod、不发布、不 push。上一轮 UI/Admin 工作已提交至 38cc1e4，开始本轮时无待提交代码，仅有本机 .DS_Store。

## 已定模型

- 仅支持 cv_app_db_2，不保留 cv_app_db_1、旧 profile/policy/price version、validation/readback 或其他兼容入口。
- adapters 是代码管理的只读整数目录。服务配置保存 name、adapter_id、可编辑 endpoint_url、model_id、AI 专用 credential_ref、明确 legal_document_id、enabled、revision；不另建供应商管理层。
- prices 与配置一对一，保存币种及四项非空整数费率，与配置共用 revision，一次原子保存。
- routing_rules 保存当前星期/分钟区间、enabled、revision；三个时间字段全 NULL 表示兜底。关联表保存允许配置和 is_default，与规则一次保存。
- 固定格式使用列和关系表。每表 typed audit 保存完整历史；配置域不使用 external_id/code。
- requests 保留对外 req_ 标识、用户幂等、状态、额度日期及最终结算事实；request_snapshots 在预留事务中冻结执行参数、报价和精确授权证据。
- attempts 使用 (request_id, attempt_no) 主键，最多两次；六项 token 用量列允许 NULL。删除 attempt 独立 ID、cancel_sequence、Provider 实际账单金额空槽及请求重复 usage。
- 用户/全局/分钟额度桶只记录限额计数；单份日汇总集中保存结果、用量、估算费用和不完整计数，按 UTC 预留日统计，首次发送日的准入次数单独呈现。
- legal.documents 保存当前普通/公共 AI/所选接入披露，双语正文为受限 Markdown TEXT。接收方、adapter、规范化 endpoint、model 为明确适用范围；accepted document audit 与 acceptance audit 保留准确历史。
- 普通配置/价格/条款更新仅影响新 reservation；在途使用快照。停用持久写入 time_canceled，重新启用不会复活旧请求；迟到事实始终允许结算。
- CV 保持唯一 v7 格式和当前加密封装。Auth 配置、GitHub SSO/OAuth 与 keep_project_active 保留。
- migrations 全部重写为唯一新基线，按 schema 和建表/关联/函数/API 阶段组织。不维护第二份手工 DDL 镜像。

## 执行顺序

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 三方固定 SQL/API/UI 的 v2 契约；更新本计划 | 不存在互相猜测的 DTO |
| 2 | typed tables、audit、约束、RPC、目录数据与角色权限；替换旧迁移链 | 仅本地空库重建、角色正负测试、SQL 约束测试 |
| 3 | 执行运行时、可配置出口、同意与选择器整体切换 | 幂等、未知费用、迟到结算、取消、跨日和 endpoint 负向测试 |
| 4 | Admin 六业务页统一列表和 View/Edit Dialog | config+price / rule+members 单次保存、脏表单与缓存隔离、窄屏/宽屏检查 |
| 5 | 初始化/重建工具、manifest、真实 DB/E2E fixture 与部署检查切换 | 本地集成、两连接竞态、平台保留演练、类型/lint/构建 |
| 6 | 清理旧代码/测试/文档，补充本轮验证记录 | 无旧实体、兼容字段、发布票据或过时操作流程 |

## 并行写入归属

数据库实现维护 migrations、SQL/API 角色测试及生成类型；AI 实现维护运行链、选择器和 Provider fixture；Admin/Legal 实现维护管理页面、条款与浏览器测试。主执行者维护公共 context/CV 集成、工具与 CI、文档和端到端收敛。

## 必须保留的边界

自定义 endpoint 校验实际连接并禁止重定向，不读取 AI 密钥空间外的环境变量；同格式不继承官方价格和隐私事实。不同接入方使用隔离的匿名标识。

配置及价格、规则及候选集合、预留及快照占额分别原子提交。revision 和实例校验是技术并发边界；UI 不管理这些字段。默认项失效不静默改选其他服务。

审计历史不可随当前配置删除级联丢失。未结算请求与其依赖不提前清理；账户删除后的去身份化不能阻止迟到事实记录。

本地验收前不更新 main/release。test/prod 重置发布仍是独立、尚未执行的流程。
