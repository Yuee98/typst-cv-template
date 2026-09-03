**Admin Implementation Plan 评审记录**

用户本轮要求：在已收敛总体方案上制订 implementation plan，并同样通过 Relay 收敛。范围仅为实施计划文档；不开始实现、迁移、付费调用、部署、GitHub 发布或合并。

沿用当前任务 session：6a994932-0c0c-83e8-ba9b-878517117977。代码基线：2783057292cef4ba3889d6bded31ce7863b2270f。设计依据：docs/admin-control-plane-plan.md，SHA-256 149d6ed6d826a0c3cb90e055907900a4632286b3d22edbf9a05e486cd3068167；总体方案已在前一周期获得 READY，R1–R4 CLOSED。

这是用户新请求的实施计划产物，开启该产物自己的评审周期，不重新评审或重置前一个总体方案周期。模式 default。操作依据为 D:/code/cgcon/agent-instructions.md 和 workflows/review-convergence.md；实施计划正式评审最多三轮实质提交。

独立讨论：先向同一 Relay session 提交已确认事实与设计约束，代理在读取回复前保存自己的完整实施草稿；随后核对、合成。独立讨论不代替正式完整计划评审。不会把未完成任务或流式进度作为评审结论。

| 阶段 | Task ID | 产物身份 | 状态 |
| --- | --- | --- | --- |
| 独立实施讨论 | 2d3e2bce-971f-4465-8023-9bc16fa324b1 | 已确认设计 SHA 与 main 基线，无本轮实施意见 | done / replied |
| 正式 round 1 | 17d8dca4-3a09-4819-bf08-801db261babc | 025a2ca822ea8cd473697b54ec08fece5b2a2eb76f71d0b09b7d687775ad2b60 | done / replied，CORRECT |
| 正式 round 2 | b31c7e29-7b81-4bb6-a9a5-50f66ed46056 | ecba8af39b47f5c84c9486684ed4c106bc4b5f0ab74df76cf5a297a327bcba4f | done / replied，READY |

独立性证据：先提交 facts-only prompt；在读取回复前于 2026-09-03T13:27:17Z 保存完整代理草稿（41,908 bytes），SHA-256 `993f6c253cbcc3c082893f697203a63dc55adf6ebe1efb910af77ac33deb76ef`。快照位于忽略目录 `tmp/admin-implementation-relay-6a994932/agent-independent-draft.md`；读取终态后才做合成。

独立讨论合成：

| ID | 判断 | 依据与处理 |
| --- | --- | --- |
| D1 | 共同结论 | 只读先行、v1/v2双读、独立权限cutover、幂等/报告/closing cycle、Analytics并行及probe后置均已在独立草稿中 |
| D2 | required-now，已补入 | attempt ledger也有NOT NULL aliases及触发器/complete派生逻辑，核对20260823234500/235000和20260824000000迁移后扩展I03的完整生产消费链 |
| D3 | required-now，已补入 | 非空库升级含用户、历史/在途请求；FK先NOT VALID、历史Provider关系不猜测；typed RPC生成payload hash；共享quota claim/refund实际入口 |
| D4 | 更简单的适用实现 | 未采纳另加Web deployment secret/header作为强制门槛。已收敛总体方案允许直接RPC接受完整同等鉴权；环境隔离由独立project/DB identity，build断言由登记manifest与producer report。用户JWT不能证明Vercel instance，此限制写清；service_role-only producer grant满足DB角色可区分，不能冒充code/legal importer |
| D5 | 代理独立发现，已纳入 | 前端known bundle/annex以及runtime/legal exact target也是配置化模型接入的阻塞，I05交付完整新schema、sealed display与consent链，保留旧文本/向量 |
| D6 | 事实纠正 | discovery prompt把现有Playwright称为静态流程不准确；它使用server build+fake后台、空Supabase配置。实施计划明确纠正，新Admin测试需本地真实Auth，不宣称旧suite覆盖Admin |

本轮官方资料核对支持Supabase TOTP/aal/amr能力；实施中仍要求当前本地Auth版本真实验证近期challenge、refresh与撤销语义，不将文档当作已经通过集成测试。

**正式评审 finding ledger（先建立问题模型，再修正文稿）**

| ID | Applicability / 分类 | 不变量、根因与完整影响面 | 最小修正与验证 |
| --- | --- | --- | --- |
| IP-R1 | required-now / blocker | I01误列冻结evidence原文件为编辑目标，违反字节/旧schema身份；当前operations:123和runtime contract:7证实。影响I01/I05 source producer、旧hash/vector，以及runbook生效时机 | 新建provider/runtime successor文件，旧文件字节保留；未来runbook先独立草拟、I07生效。核对全计划的文档编辑和重签要求 |
| IP-R2 | required-now / blocker | I01锁矩阵可能在幂等命中前检查target/control状态，与I06重放保证冲突。影响grant/revoke、pointer、quota、retire/reopen及HTTP丢响应后的重试 | 将当前actor/环境授权与target业务状态分开；全局锁+actor检查后operation查找，未命中才锁/验证target；增加目标后续变化、过期报告/step-up后的已提交重放矩阵 |
| IP-R3 | required-now / blocker | DB事务不能证明Vercel/CLI已实际部署，回滚构建只要求execution双读不足；且实际控制表为ai_feature_config。影响I07 cutover、I10运维和I12恢复 | 事务外精确build就绪+受信登记，事务内只验证DB事实及真实对象/grants；cutover后回退构建必须同时兼容execution、Admin authority/report/readback；精确旧签名与3列撤权测试 |
| IP-R4 | required-now / blocker | current_ai_terms_version、policy/pointer validator和acceptance形成单current gate，计划缺切换/回退协议。本地20260823231000:376/401、20260823233000:1000及foundation:470证实。影响future候选创建、I05显示/consent、I07 current/pointer/readback、I10 rollback、I12升级与在途请求 | 保留单current；先双读renderer+封存future bundle+前向/回退successor候选；gate-off下受控clear/current切换后激活/pointer/readback/reopen；future候选validator不赋实时执行资格；当前/旧consent与frozen请求分开测试 |

四项均在已授权计划范围内，非新增产品选择；没有采纳额外Web来源secret要求。修正前状态均OPEN，完成本地文稿核验后提交同一周期round 2，只有Relay对完整修订版复核后才记最终闭合。

Round 2修订核验：IP-R1–IP-R4均为CORRECTED_PENDING_REVIEW。已在I01/I05/I06/I07/I10/I12及测试节一致修改；特别覆盖future-bundle candidate与live admission分离、旧v1 exact-target无法直接挂新bundle时用等价v2 rollback successors、current切换与旧在途结算分离、local集成证明与Preview gate-off检查/首次受限reopen后smoke分离。I07撤权目标改为实际`public.ai_feature_config`及三个已授权列。原总体方案SHA、tracked业务文件和冻结证据均未改变；新计划`git diff --no-index --check`通过。可选项中的active-v1升级fixture、actual binding revision诊断与MFA trace/video保护一并纳入相关验证，没有新增产品功能。

**最终收敛**

正式round 2已返回终态READY，精确对应计划SHA-256 `ecba8af39b47f5c84c9486684ed4c106bc4b5f0ab74df76cf5a297a327bcba4f`。IP-R1、IP-R2、IP-R3、IP-R4全部CLOSED；revision-regression、new authoritative evidence、critical-late-finding、user-decision、out-of-scope均无新增项。共一次独立讨论、两轮正式实质评审，未消耗第三轮。

两项late-nonblocking随实现交付，不修改已经READY的正文身份：

- I01/I06列清首次TOTP enrollment、factor replacement及撤销后的step-up状态与本地Auth测试；未知claims保持高风险动作关闭，恢复仍按明确DB-owner边界处理。
- 新bundle等价v2 rollback successor用于Provider/model/route回退，不承诺修复v2 runtime代码缺陷；代码缺陷仍按gate-off、兼容build回退下限与forward-fix处理。

本轮产物为12个工作包的实施计划及本评审记录。没有实现业务代码、执行迁移、启动付费调用、改变部署、发布GitHub或提交/合并。READY只表示实施计划收敛，不是任何线上状态或测试结果。

原始prompt、独立草稿、各轮精确计划快照、task JSON和终态reply保存在本地忽略目录`tmp/admin-implementation-relay-6a994932/`。最终文档格式/身份核对通过；总体方案与代码基线保持不变。

最终状态：READY。
