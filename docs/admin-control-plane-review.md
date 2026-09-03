**Admin 方案 Relay 收敛记录**

日期：2026-09-03。范围：既有 admin-control-plane-plan.md 的方案评审与修订，不授权实现、数据库迁移、线上调用、部署或 GitHub 发布。

操作依据：D:/code/cgcon/agent-instructions.md 与 workflows/review-convergence.md。模式：default；这是已有草案的 artifact review，不声称是重新进行的独立设计讨论。预算：最多三轮实质提交。

Repository：D:/code/typst-cv-template。代码基线：2783057292cef4ba3889d6bded31ce7863b2270f。

Relay session：6a994932-0c0c-83e8-ba9b-878517117977。已核对服务正常、session 存在、未暂停、无排队或执行中的任务。

初始方案 SHA-256：f5e785d9cbe5f95819e53beaa1e0fb9b00830bd938497e37108f7a8376f4d40f。

用户已确定：同一 web/部署；首位管理员 DB 添加、后续页面授权；单一 admin 角色；adapter 使用迁移维护字典和代码实现；endpoint/env 名/model 文本配置并保留受控解析；提交时创建不可变版本；Provider/Profile/Price/Routing 独立管理；两级菜单与统一审计入口；复用主题与语言；用户 AI 白名单管理后续实现；沿用现有 retention。第一版不增加 execution_sha256 或 destination_policy_id。

| 轮次 | Task ID | 方案 SHA-256 | 结果 |
| --- | --- | --- | --- |
| 1 | a5fffacd-545d-4696-b165-990c8abec501 | f5e785d9cbe5f95819e53beaa1e0fb9b00830bd938497e37108f7a8376f4d40f | done / CORRECT；四项 blocker R1–R4，无实质产品分歧 |
| 2（传输失败，不计实质轮次） | 3ac5ee9d-b603-4ee9-a7c4-7fd3837c3f53 | 149d6ed6d826a0c3cb90e055907900a4632286b3d22edbf9a05e486cd3068167 | failed / submission_not_observed，无评审回复 |
| 2（受控恢复） | d41e6349-c43f-4f75-ba56-978f0fc13354 | 149d6ed6d826a0c3cb90e055907900a4632286b3d22edbf9a05e486cd3068167 | done / READY；R1–R4 全部 CLOSED，无新增 blocker |

**问题台账**

四项均为 required-now：当前方案已承诺相应权限、恢复、测试或发布行为，问题影响后续阶段共同契约，不能只延后给某个按钮实现。以下四项均已由代理修订并核对，在第二轮获得 Relay CLOSED 确认。

| ID | 分类与具体失败 | 根因及影响范围 | 最小充分修正 | 状态与版本 |
| --- | --- | --- | --- | --- |
| R1 | blocking：旧 service_role RPC/控制列 UPDATE 可绕过新 Admin 授权与证据引用 | 外层 actor 校验未收口 DB mutation authority；影响成员、创建、发布、运行控制、证据 producer、审计与 operator 操作 | JWT 外层 RPC 以 auth.uid() 定 actor；旧 operator 实现 owner-only；撤销控制列直接 DML；发布从不可变 report/evidence ID 取事实；保留明确来源的 DB-owner 应急；同步检查数据面锁权限与更新 runbook | resolved / Relay CLOSED；第 1 轮 SHA → 第 2 轮 SHA |
| R2 | blocking：单一事务的 operation 行无法承诺跨回滚 durable pending/failed | 混淆 committed-result、客户端未知状态与外部网络任务；影响全部同步 mutation 和 Audit | 使用同事务 committed-result 幂等；当前权限后、expected-state 前返回幂等结果；回滚不承诺保留失败，按客户端 key 查询恢复；外部 probe 独立；已提交 key 不提前清理 | resolved / Relay CLOSED；第 1 轮 SHA → 第 2 轮 SHA |
| R3 | blocking：直接 Admin fetch 无 durable start/结算/成本；普通 attempt 又必须属于产品 request | 缺少真实 probe producer 与独立生命周期；影响候选验证、限额、重放、unknown、成本投影和 retention | 保留用户同意的测试能力，选专用 probe parent/attempt；P4b 单独交付，单次发送资格/无重发、共享全局限额和独立用户统计；Web probe 为诊断证据，不新增统一激活硬门槛；P4a/P5 不依赖该 UI 功能但仍需真实合格证据 | resolved / Relay CLOSED；第 1 轮 SHA → 第 2 轮 SHA |
| R4 | blocking：canary 标签可能误导流量范围，pointer 流程遗漏既有 gate-off 边界 | 生命周期资格、实际流量范围和关闭/读回/开启次序未分清；影响发布、回退、并发及故障恢复 | 明确 canary 无百分比含义；set/clear/rollback 在 gate-off 下执行，读回并单独 step-up 开启；DB 约束关闭周期、generation/revision 和受信 readback，失败保持关闭 | resolved / Relay CLOSED；第 1 轮 SHA → 第 2 轮 SHA |

**本地验证依据与处置理由**

- R1：20260824004000_add_ai_provider_operator_lifecycle.sql:146 保留三个 feature 列直接 UPDATE，:332/:354/:376 等仍向 service_role 授予 operator execute；:161 evidence validator 只验证格式/时间/sealed runtime，未引用不可变 validation report。同文件 :149–159 的有限 UPDATE 另有行锁用途，故修正特别要求保留数据面有效锁权限并验证 security-invoker guard，不能机械撤尽所有权限。reserve/start 主函数为 SECURITY DEFINER。只加 Web wrapper 无法兑现原方案的完整 mutation 边界，所以采纳收口；不增加部署或应用角色。
- R2：原方案第 7 节的同事务 operation，与第 9 节 durable pending/failed 承诺相冲突。SQL 事务回滚会丢弃同事务操作记录，无需数据库实验即可确定。修订限定幂等于已提交结果，并明确并发/回滚/响应丢失三个邻近场景。没有证据需要通用异步 command bus，故不引入。
- R3：20260823234500_add_ai_provider_attempt_ledger.sql:9–11 的 reservation_id 非空外键证明现有 attempt 无法独立承载候选 probe。用户已同意有成本固定测试，因此采用评审方案 B 的最小专用生命周期，未将已同意功能直接删除；P4b 与 P4a 分开，不让新增网络生命周期阻塞纯配置管理。全局调用限额与测试成本投影必须随功能同步验收。
- R4：docs/ai-provider-operations.md:166–171 明确现有 gate-off/pointer/readback 再启用流程；20260824004000_add_ai_provider_operator_lifecycle.sql:334–375 的 pointer 函数接受 canary/active，但没有流量百分比语义或 gate-off 检查。修订将已记录的操作顺序落实为新 Admin RPC 约束，不宣称旧 DB 已强制执行。零停机切换不属于用户当前要求，保持后续讨论。

P0/实施细化项继续保留：Provider 与 model vendor 的身份关系、v1/v2 投影/约束、能力内动态 model 的证据组合、环境身份、非敏感 binding revision、Auth 账户有效性与密码/GitHub step-up、static 路由生成、Admin 遥测、Analytics 分母/完整性及安全 audit projection。它们不被重新编号为当前 blocker。

继续拒绝没有现有依据的扩展：独立 Admin 部署、多个应用 admin 角色、execution_sha256、destination_policy_id、credential_generation、共享 workspace packages、通用事件总线、数据仓库和可变 workspace draft。复杂 DNS/egress 未完成的目标维持拒绝，不强制为当前官方目标建设通用出站代理。

第 2 轮前验证：只修改两份方案文档；main 基线未变；plan diff whitespace 检查通过；四项修订覆盖对应章节、阶段依赖、失败场景与运行迁移次序。未执行实现测试、迁移、Provider 调用或线上验证。

**第 2 轮发送恢复决定**

任务 3ac5ee9d-b603-4ee9-a7c4-7fd3837c3f53 在 2026-09-03T12:52:38.147Z 终态 failed，error=submission_not_observed，dispatchedAt/sendAttemptedAt/submitAcknowledgedAt/generatingSeenAt 均为空，未返回 reply/lateReply。随后核对同一 session 未暂停且无 active/pending。cgcon task-lifecycle 将此状态定义为明确未观察到提交；extension/service-worker.js 的失败处理会尝试清理旧 composer。此为传输失败，不消费第二轮实质评审预算。

代理据此明确决定一次受控恢复提交，保留原失败任务身份与相同方案 SHA，不执行自动无限重试。新输入保留完整当前方案、完整台账、修订摘要和已在 session 中的前版身份，移除重复的大段全文 diff（完整 diff 已本地保存）。提交前再检查原任务无 late reply、session 空闲且未暂停。

**第二轮非阻塞项**

| ID | 分类 | P0 处置 |
| --- | --- | --- |
| N1 | late-nonblocking / 实施细化 | 将方案第 7 节“仅验证服务可生产成功报告”落实为 DB 可区分的 producer capability 与拒绝测试，不能仅靠 TS 模块约定。继续列入 P0 的证据 producer 权限契约，不增加应用角色或独立部署。 |
| N2 | late-nonblocking / 表述与实施细化 | 方案第 6 节已分别规定 Admin 状态查询/停用在 AI 关闭时可用，付费 probe 服从 deployment API gate、DB kill switch 和专用 admission。P0 在端点/权限矩阵中逐项列出这一差异，避免将控制面可用性泛化为外呼许可。 |

两项均没有新增产品决定，也不阻塞总体方案。它们作为既有 P0 验收细化保留在本记录；获评方案正文不再修改，维持与 READY 结论相同的精确 SHA。

**最终判定**

Decision：CONTINUE_TO_P0_PLANNING。

Phase：Admin 总体方案收敛。Relay verdict：READY。Open verified blocker IDs：none。Authority blocker：no。Absolute disagreement：no。

有效实质轮次：2；另有一次明确发送失败及一次受控恢复，不需要第三轮。

终态任务：d41e6349-c43f-4f75-ba56-978f0fc13354，done/replied，完成于 2026-09-03T13:02:52.054Z。Relay 确认嵌入完整方案 SHA-256 为 149d6ed6d826a0c3cb90e055907900a4632286b3d22edbf9a05e486cd3068167，并关闭 R1–R4；未发现 revision-regression、新 blocker 或实质产品分歧。

代理结论：四项修正与本地代码/runbook 证据相符，保持用户确定的产品边界。总体方案可进入 P0 契约冻结；P0 和后续实施仍必须完成文中列出的具体权限、SQL、接口与验证工作。本次仅完成方案评审，未实施功能、执行迁移、调用付费 Provider、部署、修改线上配置或发布 GitHub 产物。

原始输入、各版方案、diff 和完整终态回复保存在本地 tmp/admin-plan-relay-6a994932/；该目录是本地评审证据，不是部署产物。

最终状态：CONVERGED_READY。
