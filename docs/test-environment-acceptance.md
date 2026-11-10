# Test 环境补充验收

状态：`RESTORED_WITH_ACCEPTANCE_GAPS`。HTTP 401 诊断后，仅 Preview 的 MiMo Secret 覆盖及同源 `9054c0a` 新部署已完成；2026-11-10 10:15:51.626 UTC 唯一一次复验生成成功，未应用到 CV，独立 DB 的 29 项调用核对及 26 项恢复核对全部 PASS。最终 10:18:21 UTC 回读确认 runtime 关闭、ALLOWLIST、20/2000/3、revision 29、10 请求/6 attempt、reserved=0、charged=3、global admission=6；域名已恢复 `main`，默认 Preview AI flags=false。MiMo 成功调用完整应用估算为 CNY 0.00011724，不是供应商发票；前三次失败费用仍未知。当前证据在 `output/mimo-diagnosis-20261110/`，前两轮独立目录及 7/3、8/4、诊断 9/5 快照按原时间保留。恢复及 MiMo 修复通过不代表剩余全部验收通过，prod 不动。

## 范围与现场基线

- 目标为共享 test 域名 `https://cvmaker-preview.dyue.org` 及同一 test 项目的独立 Preview；Supabase test 项目 `uvitgcfqnciahvakqhnv`，实例 `842d36df-6969-4c86-abcc-6dc956dd6318`。
- 本轮开始的 hosted 应用源为 `bc9d9ce827a8bd4727d866e930253452302c48e5`，数据库已完成重建。不得再次 rebuild/resume。
- prod 数据库、Auth、环境变量、部署和 release promotion 不在范围。
- 首轮独立证据目录为 ignored 的 `output/test-acceptance-20261110/`，授权重试另用 `output/test-provider-retry-20261110/`，当前版本本地对照及 HTTP 诊断另用 `output/mimo-diagnosis-20261110/`。私有凭据文件单独存放，文档不记录凭据内容；工具回显事件及本地扫描边界见对应轮次。
- 开始时 AI 总开关关闭，ALLOWLIST 为空，配置、规则、AI 请求和 attempt 均为 0；额度为每用户每日 20、全局每日 2000、每用户每分钟 3。后续仅将指定测试账号加入 AI 允许名单，没有追加管理员权限。
- 首轮为小额验收临时开启 AI，使用 ALLOWLIST，并将每日限额暂设为用户 4、全局 4；门禁测试还短暂使用了 0 或 1 的限制。后续授权重试及诊断/修复窗口分别按各节记录，不沿用该首轮限制。恢复目标为 AI 关闭、每用户每日 20、全局每日 2000、每用户每分钟 3，且共享 test 域名重新跟踪 `main`。最终状态必须由相应轮次结束后的新回读证明，不能沿用调用前的关闭快照。

## 当前结果

| 检查 | 状态与已有结果 | 边界与后续 |
| --- | --- | --- |
| 本地补充回归 | **PASS**：17 个文件、196 项通过；覆盖导入导出、真实 WebCrypto、云写边界、身份隔离、Admin 缓存及响应式组件 | Node/jsdom 证据，不等于 hosted 浏览器全链路 |
| 当前版本本地 MiMo 付费对照 | **PASS（本地）**：`214d563` 基准的真实调用链、LOCAL `cv_app_db_2` 临时数据库、同一 15 字中文/Level 0/context 0，一次真实 POST 返回 HTTP 200、3810ms，input 569/output 24；夹具清理成功 | 不是 hosted 成功；live harness 仅增加预算上限和证据元数据，其余 11 个取证文件与 HEAD 匹配。617 nanos 是夹具合成费率的应用估算，不是供应商账单 |
| 安全诊断日志及回归 | **PASS**：固定九个 primitive 字段，不含 key/ref、CV、请求/响应正文、headers、error.message。helper 32 项 + runtime 28 项共 60 项通过，TypeScript 及 scoped lint 通过 | 保留真实 RED。throwing logger 的 HTTP 401/403 用例证明日志失败不影响终态结算；模拟数据库测试不冒充 hosted 调用 |
| Hosted 加密 CV | **PASS**：专用虚构文档由普通云文档启用加密，编辑后手动保存；新标签错误口令被拒绝，更正口令后读取准确的已保存内容；原标签刷新后重新选择也能读取 | 同浏览器独立新标签，不是跨物理设备；未勾记住设备 |
| 加密文档解密派生 | **PASS**：正常“复制”操作产生准确内容的普通本地副本，随后正常移到云端 | 产品没有原地关闭加密按钮，不编造不存在的操作 |
| Hosted 导出/导入 | **BLOCKED / NOT RUN**：首轮 JSON、PDF 已操作按钮，但下载事件未交付可验收文件；PDF 等待导致控制会话超时重置，JSON 导入也曾被扩展文件权限阻塞。新轮已开启 Allow file URLs，环境文件导入成功，但未重新验收 CV 文件路径 | CV 导出内容、Typst 包及 JSON 回环导入仍未验收；旧文件权限阻塞解除不等于 CV 导入已通过。当前格式接受、旧格式拒绝的本地校验均通过 |
| Hosted 视口 | **BLOCKED**：请求 390×844 后，DOM 实际仍为 1454×1019；已立即 reset | 窄屏 override 无效；真实手机 Safari、软键盘及触摸滚动为 **NOT RUN** |
| AI 配置与条款 | **PASS**：Admin 保存 DeepSeek、MiMo 专用验收配置及 enabled fallback，默认 DeepSeek；结构、冻结价格及指定账号 ALLOWLIST 核对通过。真实请求的当前通用及供应商同意记录精确匹配 | 配置/条款通过不表示每个供应商调用成功；最终运行开关恢复另列 |
| Preview 构建与域名切换 | **PASS（新修复部署及恢复）**：凭据覆盖后的 `AvUcY9U…` 同源 `9054c0a`，Preview、latest Project Settings、build cache 未勾选，于上海 18:07:52 Ready；一次复验 UI 与独立 DB 均通过 | 默认 Preview flags=false，`AvUcY9U…` 构建快照仍 true；runtime 已关闭、域名恢复 `main`。域名恢复没有重新部署 main，不能声称其旧快照已采用新 Secret；Production 未改 |
| Hosted Admin 长编辑 | **PASS**：`214d563` 部署上，编辑框打开 524 秒后修改展示名称并保存，列表自动显示新值，没有手动刷新 | 仅确认实际执行的配置路径；三类页面及身份隔离的更广回归来自本地测试 |
| DeepSeek 真实调用与写回 | **PASS**：request 1 成功、单 attempt；生成结果应用、撤销、再次应用及保存已操作，DB 精确回读确认保存内容；冻结配置、条款、额度、CNY 估算逐项核对通过 | 估算 CNY 0.00134，不等于供应商发票对账。未把 DB 回读写成浏览器刷新回读 |
| MiMo hosted 调用 | **PASS（UI + DB）；前三次 FAILED 保留**：request 10 为唯一新增逻辑请求、单 attempt、`FINALIZED/SUCCEEDED`，input 569=57 standard+512 cache、output 25、reasoning 0；冻结配置/价格 audit 5、当前 common 2/provider 4 条款不变，29 项核对通过 | 成功完整估算 117240 CNY nanos=0.00011724 元，不是 invoice；未应用到 CV。旧 request 6、8、9 的未知费用仍未知，不能因新成功而改写；旧 Secret 被拒绝的具体原因不猜测 |
| 取消观察 | **完成抢先，非取消 PASS**：request 7 为 `SUCCEEDED`、已扣额度、`time_canceled=null`，单 attempt，CNY 估算 0.00060336；UI 返回配置，未应用第二次结果 | 真正持久化 `CANCELED` 终态为 **NOT RUN**；未为了抢到取消而重复付费 |
| 额度与分钟门禁 | **PASS**：用户额度为 0/已耗尽时 UI 禁用；全局额度拒绝及分钟限流由 UI 与 DB 联合核对。四条 `RELEASED` 请求没有 attempt，拒绝未产生额外发送 | 依据门禁阶段的水位隔离 MiMo/取消阶段；恢复 4/4/3 是测试窗口内部恢复，不是最终恢复 |
| Hosted 同 ID 重放 | **NOT RUN**：正常 UI 每次确认或手动重试都会生成新 UUID，没有可用的同 ID 重放入口 | 不以重新点击确认冒充重放，不为重放额外发送付费请求；真实隔离 DB 与并发 CI 覆盖见下文 |
| Gemini 凭据与调用 | **PASS（凭据）/ NOT RUN（调用）**：授权上传轮保存并回读唯一 `AI_PROVIDER_KEY_GEMINI_PRIMARY` 为 Secret / Preview，没有 Production 条目 | 上传轮未 Redeploy；后续已构建新的诊断 Preview，但没有执行 Gemini 调用，不据此宣称 Gemini 可用或 USD 结算通过。工具回读脱敏事件按旧轮记录，不在文档中记录密钥 |
| Hosted 身份与退出 | **NOT RUN**：实际管理员登录态下的配置、条款、AI 路径已验证；本轮未执行 hosted 退出修复及普通账号隔离验收 | 本地身份与退出测试单列，不据此声称 hosted 通过 |
| Admin 性能 | **PASS（基线及区域观察）/ NOT RUN（正常 Admin 对比）**：旧部署 GET execution 1.09s / response 1.1s；POST 2.11s / 2.2s。函数 iad1、数据库东京，分别经过 Auth→RPC、Auth→context→save。独立 Preview 的 availability 401 日志已确认 hnd1/Tokyo，execution 587ms / response 901ms | 401 样本没有 Supabase 外调，不能与正常登录态 Admin 请求比较，不能据此宣称加速；旧部署两个样本也不是 p95、冷启动或慢网基准。外部 API 分项耗时受 Pro 功能限制，未升级套餐 |
| 时间规则边界 | **PASS（UI + DB）**：rule 2 在周二 Asia/Shanghai 16:05–16:06 仅允许 MiMo；窗口前显示 DeepSeek+MiMo，窗口内仅 MiMo，窗口后恢复 DeepSeek+MiMo。三次仅查询 availability，没有确认生成或模型调用 | 首轮最终 DB 回读确认临时规则 disabled、revision 2，水位仍为 7/3，没有因规则检查增加调用。后续独立尝试分别使水位增为 8/4、9/5，不回写旧快照 |
| 环境恢复与凭据修复 | **PASS**：最终 10:18:21 UTC 独立回读 26 项通过：revision 29、runtime 关闭、ALLOWLIST、20/2000/3、10/6、reserved=0、charged=3、global admission=6、单一允许账号保留且水位未再增长；域名 `main` fresh reload、默认 flags=false | `RESTORED_WITH_ACCEPTANCE_GAPS`：经授权的 MiMo Preview Secret 保留，Production、main/release 未改，PR #44 未合并；其余功能缺口单列 |
| 自然保活 | **NOT RUN（等待自然调度）**：重建后尚无新 schedule run；最新成功自然 run 早于重建 | 下次配置时间为 2026-11-12 02:17 UTC，即上海 10:17；实际启动可能延迟。未手动 dispatch 共享 workflow |
| 自动部署/CI | **PASS**：`214d563` 的既有检查保留；新 live harness `280eece`、诊断日志 `9054c0a` 分批提交并 push 同一草稿 PR #44，`9054c0a` 的 Web/工具、DB、CodeQL 全部 SUCCESS，新诊断 Preview Ready | main/release 未推进、PR 未合并；Supabase Preview check 仍为 SKIPPED，不冒充 Supabase main 同步或下一次 main push 已验证 |

首轮证据位于 `output/test-acceptance-20261110/`，以上首轮结果以 `hosted-long-edit-and-deepseek-ui.json`、`after-deepseek-live-summary.json`、`after-mimo-live-attempt-summary.json`、`after-cancel-live-summary.json`、`quota-gates-final-summary.json` 及 `branch-214d563-ci-final.json` 为准；首轮 DB 关闭状态以 `final-runtime-restore-summary.json` 为准，域名和环境变量恢复汇总在该目录的 `final-restoration.json`。这些快照的 7/3 水位按原观察时间保留，不改成后续的 8/4。新轮采用独立目录及文末证据，不能用首轮的 final 文件冒充第二轮回读。较早“尚无调用”“域名仍临时分支”“flags 仍为 true”或“等待验证”等状态均只是当时观察，不代表当前结论。

时间规则的正常 UI 观察时间分别为 2026-11-10 08:03:37.705 UTC（窗口前，两项）、08:05:22.345 UTC（窗口内，仅 MiMo）、08:06:16.692 UTC（窗口后，两项），对应上海周二 16:05–16:06 的一分钟规则。此项依据本轮浏览器现场观察，未把 availability 查询当成付费生成。

## 补测发现的代码缺陷

1. Admin 已验证的 owner/instance scope 默认在五分钟后被普通 Query GC 回收。页面本地状态仍显示旧列表，而 mutation 完成回调因 scope 缺失跳过刷新。最小修复仅保留该 scope 至身份清理，普通读取缓存继续回收。原实现三类页面的长编辑回归失败；修复后 80 项相关测试与 TypeScript 检查通过。退出、换号、返回原账号后的旧回调隔离保留。
2. CV 编辑器退出登录时，会把正在编辑的加密文档作为明文本地 fallback 保存。已修复：加密文档退出时清口令，切换已有本地文档或新空白文档，不复制加密标题、正文或未保存内容。并复现、修复了等待 Auth 期间从普通云文档切到加密文档的竞态：普通明文 fallback 在首次 await 前只捕获原数据，退出成功后才保存，失败不改存储。普通云文档的既有 fallback 行为保持。

两处修复经独立审查，联合覆盖 5 个测试文件、93 项全部通过。最初联合命令误列一个不存在的测试文件名，Vitest 实际只运行 4 个文件、71 项；随后准确运行身份测试文件的 22 项通过，按实际输出合计 93，不把不存在的文件计入覆盖。

修复分支为 `codex/test-acceptance-fixes`，草稿 [PR #44](https://github.com/Yuee98/typst-cv-template/pull/44)。前两轮源为 `214d5634964ca98af76447e73acceda77cb15f4e`，分批提交为 `aa56183`（Admin）、`0aaaf5c`（加密退出）、`214d563`（东京函数）；诊断轮又提交并 push `280eece`（live harness）及 `9054c0a01b427e53db563678329e803dd2f0b604`（安全诊断日志），后者为当前诊断部署源。同分支带入先前独立的数据库切换记录提交。PR 仍为草稿，未合并 main/release。

前两轮的 Vercel 自动 Preview deployment 为 `Daz5hKYbHGQ2g7FRXhk8Jtdr7Mzq`，源/项目/Preview 属性均核对，地址为 `https://typst-cv-template-psuk1tv6f-yuee98s-projects.vercel.app/zh`。对应 `214d563` 的 Web CI `42769605166`、DB CI `42769605272` 及 CodeQL `42769601894` 均成功；后续 `9054c0a` 的新部署与 CI 见诊断轮。共享 test 域名临时切换后，实际登录态长编辑及部分真实 AI 路径已有上述结果；性能对比、退出等未完成项目继续单列，不能因 Ready 或 CI 成功一并记 PASS。

这些修复尚未合入 `main`。共享 test 域名已恢复跟踪原 accepted `main`；本轮临时部署通过不等于两个修复已经成为共享 test 的正式版本，更不表示 prod 已发布。

`web/vercel.json` 配置新部署的函数运行区域为 `hnd1`，官方配置 schema 的数据校验通过。项目 Root Directory 为 web，该文件生效；独立 Preview 的一次 availability 401 日志已观察到 hnd1/Tokyo，但正常登录态 Admin 的性能对比仍未完成。已有 prod 部署不会移动；以后若将含此配置的提交部署到 Production，也会使用东京，需在 prod 发布评审时明确核对。

## 计费验收约束

首轮原计划为三家各一个短文本逻辑请求，再单独观察一次取消；实际完成 DeepSeek 成功、MiMo 上游失败、一次 DeepSeek 完成抢先的取消观察，Gemini 当时被凭据传递阻塞。产品自身可产生每请求最多两次 attempt，首轮这三个已发送请求各只有一个 attempt。正常拒绝及额度检查优先在发送前完成；不为制造未知结果、供应商故障或抢到取消而反复付费。后续用户明确授权的一次 MiMo 重试及 Gemini 凭据上传单独记录在文末，没有追加 Gemini 调用。

截至取消阶段 2026-11-10 07:53:15 UTC 的只读快照，累计 7 个请求、3 个 attempt：DeepSeek 成功两条，MiMo 上游失败一条，另四条是无 attempt 的 `RELEASED`。额度 charged=2、reserved=0，全局 admission=3。两条 DeepSeek 的完整应用估算合计 CNY 0.00194336；MiMo 完整成本未知，因此不能把该数写成全部上游实际费用，也不能把未知费用当零。2026-11-10 08:15:12 UTC 的最终只读回读再次确认水位仍为 7/3、全部请求终结、reserved=0；时间规则检查没有新增模型调用。

费率保留原币种，按冻结配置逐 attempt 验算，再核对请求、额度桶和按币种汇总。DeepSeek 采用已声明的峰值配置费率；其峰谷变化不能由当前单行价格自动追踪。官方没有独立列出的缓存写价不能宣称为已证实免费；未使用的组件零值映射须明确记录。应用估算通过不等于供应商发票对账通过。官方来源与适用条件保存在独立价格研究证据中。

## 重放、并发及 MiMo 可观测性边界

`web/src/components/cv-builder/polish/use-polish-flow.ts` 的确认逻辑调用 `crypto.randomUUID()`；取消后重新确认或错误页手动重试均是新请求。正常 hosted UI 没有保留旧 ID 并再次发送的入口，本轮不注入脚本重放、不把新 UUID 当幂等验收，也不为同 ID 重放额外发送付费请求。后续另行授权的一次 MiMo 尝试是新的逻辑请求，不是幂等重放测试。

现有覆盖分别是：`web/src/server/ai/runtime.test.ts` 验证同 ID 不重发、并发相同请求只有一个 executor、换配置冲突以及持久化失败不重试；`web/test/db/ai-lifecycle.test.ts` 使用真实隔离数据库，核对终态重放不增加请求或发送；`scripts/db-ai-concurrency.ts` 使用独立双连接，核对 reserve、发送授权、终态写入和结算各只有一次生效。DB CI `42769605272` 在 `214d563` 上成功，工作流包含真实 DB 集成及双连接检查。它们不接触本次 hosted test 或真实 Provider，不能替代本次 hosted 同 ID 重放证据。

前两轮 MiMo 失败的具体原因在当时为 **UNKNOWN**：持久化记录及通用 UI 错误没有上游 HTTP 状态或错误码，当时也未增加诊断日志。后续诊断轮加入严格字段日志，最新 request 9 已从 Vercel Runtime Log 确认 HTTP 401，定位 hosted 凭据认证被拒绝；数据库仍没有持久化 HTTP 状态，旧 request 6、8 也没有可回填的 HTTP 证据。旧 Secret 不可读取，不能进一步猜测其字节、是否失效、抄错、所属 key family 或 plan。账务中的未知 usage/cost 继续保留，诊断证据见新轮章节。

## 首轮恢复收尾（08:32:24 UTC）

首轮最终为 `RESTORED_WITH_ACCEPTANCE_GAPS`：`output/test-acceptance-20261110/final-restoration.json` 汇总了 2026-11-10 08:32:24 UTC 的 Vercel 恢复结果及此前 08:15:12 UTC 的独立 DB 回读；以下为首轮收尾事实，后续授权重试另记，不覆写这里的时间和水位。本地补充文档尚未提交。

- **域名已恢复**：用户完成 Vercel 登录验证后，经正常域名设置 UI 保存，fresh reload 确认 `cvmaker-preview.dyue.org · Valid Configuration · main`。该绑定为 Preview；没有提升或修改 Production，也没有合并修复 PR。
- **runtime 已恢复**：2026-11-10 08:15:12 UTC 独立只读确认 revision 23、enabled=false、ALLOWLIST，限额精确为用户每日 20、全局每日 2000、用户每分钟 3。`final-runtime-restore.json` 确认累计 7 请求、3 attempt，全部请求已终结、reserved=0、charged=2；没有因路由测试新增调用。较早 `quota-gates-final-summary.json` 的 enabled=true、4/4/3 只是验收窗口内的恢复。
- **Preview flags 已恢复**：用户完成环境变量编辑的独立验证后，仅编辑 Preview `AI_POLISH_ENABLED=false` 和 `NEXT_PUBLIC_AI_POLISH_ENABLED=false`；两次 Save 均出现 `Updated Environment Variable successfully`。reload 后按精确 DOM 行限定 Preview，两个值均为 false。Production 的两个对应条目仍显示原有 Updated Aug 11，未操作。Vercel 提醒仅新部署采用变量修改；本轮未点击 Redeploy，既有独立 Preview bundle 没有 rebuild，不能宣称其已重新编译或入口已随变量修改消失。
- 时间窗口检查后，rule 2 已通过 UI 停用；`final-runtime-restore.json` 独立确认 disabled、revision 2。fallback、验收配置及其审计记录保留，但 AI 总开关关闭；指定测试账号的 AI 允许名单项仍保留，不新增管理员权限。保留失败和审计证据，不把删除数据作为“通过”的条件。
- 已核对误移的旧示例云副本删除、同内容本地副本保留；最终 fixtures 回读确认保留两个专用云端测试文档，一份加密、一份普通派生文档，没有其他用户云文档。
- 首轮结束时 Hosted 退出/普通账号隔离、下载导入、手机、Gemini、MiMo 成功、真正取消、同 ID 重放、性能对比及自然保活均未通过；后续 Gemini 凭据上传通过，但调用仍未执行，不以恢复成功覆盖其余缺口。

## Gemini 凭据上传与 MiMo 授权重试

用户在首轮恢复后明确授权上传 Gemini 凭据并让 MiMo 再试一次。该轮独立证据目录为 `output/test-provider-retry-20261110/`，UI 记录分别为 `gemini-upload-ui.json`、`mimo-retry-ui.json`，恢复汇总为该目录 2026-11-10 09:02:59.908 UTC 的 `final-restoration.json`，DB 一致性与恢复结论见 `after-mimo-authorized-retry-summary.json`。原 `output/test-acceptance-20261110/` 的快照及已封存记录不改写。

**Gemini 凭据上传 PASS，调用 NOT RUN。** 用户开启扩展 Allow file URLs 后重连成功，正常 Import .env 完成文件读取。导入 UI 曾自动重置为 Config 并同时选中 Preview/Production；保存前改为 Secret 后仅剩 Preview。只有 `expectedKey`、`secretNonempty`、`secretType`、`previewOnly` 四个 guard 全部为 true 才执行 Save。保存并 reload 后，全环境搜索只找到一条 `AI_PROVIDER_KEY_GEMINI_PRIMARY`，类型 Secret、环境 Preview，没有 Production 条目。没有点击 Redeploy 或执行 Gemini 调用；新 key 仅由未来构建采用，不能据此宣称现有独立 Preview 已具备该 key 或 Gemini 已可用。

导入后一次工具回读的脱敏范围不完整，输出曾带出凭据明文；后续修正为 allValue 全值脱敏。此处只记录事件，绝不记录密钥内容。2026-11-10 09:04:08 UTC 的 `credential-storage-check.json` 记录本地扫描：tracked 代码、当前文档及新轮非 private 证据共 430 个文件，明文匹配为 0；未扫描私有凭据源，不记录 key 或 fingerprint。该结论只适用于实际扫描范围，不表示聊天/工具记录从未出现明文，也不声称已经删除该次回显。

**MiMo 再试一次，仍 FAILED。** 复用原 `Daz5hKYbHGQ2g7FRXhk8Jtdr7Mzq` 部署，临时将共享 test 域名指向同一修复分支，runtime 临时开启，限额按用户每日 3、全局每日 4、用户每分钟 1。2026-11-10 08:59:18.153 UTC 仅确认一次，发送 15 字虚构正文，Level 0、context 0；现存的当前同意有效，没有新条款接受。UI 返回通用失败，trace 为 `03fa9141-1850-4401-9332-36abbdb279f8`，没有再次点击 retry。

2026-11-10 09:00:00 UTC 的独立 DB 回读及 09:01:44 UTC 的恢复回读确认只新增 request 8 和一个 attempt，总水位从首轮 7/3 增为 8/4。新 attempt 为 `FAILED_UPSTREAM`、transmitted=true、provider_billable=NULL、usage=NULL、完整成本=NULL、known cost=0、charged=false；精确同意、冻结配置、价格及额度桶等 27 项一致性检查全部 PASS。known cost=0 只是已知下界，实际费用和失败原因仍为 UNKNOWN，不猜测 key、区域、endpoint 或额度问题，不称免费，也不把一致性检查写成功能通过。两轮 MiMo 均各发送一次后失败；两条 DeepSeek 的完整应用估算仍合计 CNY 0.00194336，两条 MiMo 的未知成本使全部请求的完整成本依然未知。

**新轮恢复 PASS，验收仍有缺口。** 正常 UI 已重新保存域名 `main` 并 fresh reload，runtime 保存为关闭、20/2000/3；最终 DB 回读确认 revision 25、pending=0、charged=2、global admission=4，总请求/attempt 为 8/4。临时 rule 2 继续禁用。两个 Preview AI flags 保持 false，没有修改 Production、触发新部署、push 或合并 PR #44；原独立 Preview bundle 没有 rebuild。Gemini Secret 是本轮授权保留的新配置项，不应将它当作要恢复删除的临时数据。

剩余缺口仍包括：MiMo 成功及未知上游原因、Gemini 调用与 hosted USD 结算、CV 导出文件内容及 JSON 回环导入、真实手机 Safari、hosted 退出与普通账号隔离、真正持久化取消、同 ID 重放、正常 Admin 性能对比，以及 11 月 12 日的重建后自然保活。扩展文件访问权限已解除，但这些功能未因环境文件导入成功而自动通过。

## 当前版本本地付费对照与 hosted HTTP 诊断

本轮目标为用当前版本的本地成功对照查清 test MiMo 失败，不操作 prod。证据目录为 `output/mimo-diagnosis-20261110/`；前两轮的事实和封存文件继续按原观察时间保留。

**当前版本本地付费验收 PASS。** 基准为 `214d5634964ca98af76447e73acceda77cb15f4e`；生产调用链及 fixture 的 11 个取证文件与该 HEAD 匹配，工作区只在 live harness 增加预算上限和证据元数据。不是通过更改生产适配器来让测试成功。执行范围为 CURRENT、本地真实 `cv_app_db_2` 的可清理夹具，同一 15 字虚构中文、Level 0/context 0，使用相同 endpoint/model：`https://api.xiaomimimo.com/v1/responses`、`mimo-v2.6-flash`。只发送一次真实 POST，HTTP 200、3810ms，input 569/output 24，结果格式、终态、一次结算、重放不再发送及夹具 cleanup 均通过。证据为 `local-paid-current.json`、`local-paid-summary.json`。ledger 的 617 nanos 来自本地合成费率，不能当实际供应商收费或发票；本地成功不等于 hosted 已成功。

**新增诊断日志，60 项回归 PASS。** `provider-diagnostics` 只允许九个 primitive 字段：event、config_id、adapter_id、request_id、attempt_no、transmitted、http_status、retryable、class。不记录 key、secret ref、CV、请求/响应正文、headers 或 error.message，也不序列化原始错误。helper 32 项、runtime 28 项共 60 项通过，TypeScript 与 scoped lint 通过；HTTP 401/403 的 throwing logger 回归确认日志异常不阻断 attempt completion 和 finalize。实际 RED 与最终 GREEN 保留在 `readiness/provider-diagnostics/`，不把模拟数据库单测当 hosted 结算证据。

代码分批提交 `280eece`（live harness）及 `9054c0a01b427e53db563678329e803dd2f0b604`（安全诊断），已 push 同一草稿 PR #44。`9054c0a` 的 Web/工具 CI `42793150086`、DB CI `42793150100`、CodeQL `42793143704` 全部 SUCCESS；Supabase Preview 仍 SKIPPED。新 Preview `3G1wLdi52epY3SC57FiF6L5ZyeqR` 已 Ready。构建时临时打开的两个 Preview AI flags 在 Ready 后保存回 false；旧 `Daz…` 部署未原地改写。没有合并 PR 或推进 main/release。

**第三次 hosted MiMo 仍 FAILED，认证失败已定位。** 临时将 test 域名切到诊断分支，runtime 开启为用户每日 3、全局每日 5、每分钟 1。2026-11-10 09:49:52.849 UTC 只确认一次，UI 返回通用失败，trace `957f252b-8b21-4777-a27a-a18d01e7c2a6`。`hosted-http-diagnostic.json` 记录 Vercel Runtime Log：request `req_R0TGPY71A6R4`、attempt 1、config 3、adapter 2、transmitted=true、http_status=401、retryable=false、class=HTTP_TERMINAL。

这次证据把失败位置从“通用上游错误”定位到 hosted 凭据认证被配置的 MiMo endpoint 拒绝；同 endpoint/model 的当前版本本地调用支持正常工作。旧 Vercel Secret 为 write-only，不能确认其具体字节，也不能据此断言旧值已撤销、过期、抄错、属于其他 key family 或账户 plan 有问题；旧 request 6、8 的 HTTP 状态仍未知，不回填猜测。

`hosted-diagnostic-result-summary.json` 确认只新增 request 9 及一个 attempt，原八条请求事实不变，总水位 9/5、charged=2、global admission=5、pending=0。新请求为 `FAILED_UPSTREAM`，单次已发送 attempt，无内部重试，usage、provider billability、完整成本均为 NULL；known cost=0 只是下界，不能称免费。冻结配置、精确同意、价格及九条请求的额度/聚合独立验算通过，功能仍 FAILED。

**诊断轮临时设置恢复 PASS。** 正常 UI 已保存 runtime 关闭、20/2000/3，域名保存并 fresh reload 确认 `main`，两个 Preview flags=false。`after-http-diagnostic-restored-summary.json` 的 2026-11-10 09:56:21 UTC 最终回读确认 runtime revision 27、关闭、20/2000/3、9 请求/5 attempt、pending=0、charged=2、global admission=5。该新水位不覆盖旧轮 7/3、8/4 快照；Production 未变。

**Preview 凭据覆盖保存 PASS。** 用户明确允许覆盖 Vercel 现有仅 Preview 的 `AI_PROVIDER_KEY_MIMO_PRIMARY` Secret 并部署复验后，通过正常 Add / Import .env 将已授权本地文件读入工具内存，取消未保存的 Add 草稿并确认 Discard Changes，再回到原有 write-only Secret editor。变量名、Secret 类型、仅 Preview、内存凭据有效四个 guard 全部为 true 后填入并 Save；Vercel 显示 `Updated Environment Variable successfully`，回读唯一 PRIMARY 条目为 Secret / Preview、Updated just now。没有创建新变量或 Production 条目。finally 清空工具内存；AX Value 全部省略，没有新增凭据回显，不读取浏览器隐藏状态或 clipboard helpers，不在文档/证据中记录实际值。过程记录在本轮 `secret-update-ui.json`，随后 UI 复验与核账边界另列。

**同源修复部署 Ready。** 构建前临时打开两个默认 Preview AI flags，以旧诊断部署 `3G1w…` 提交 Redeploy，对话框明确为 Preview、同一 `9054c0a` 源码、使用 latest Project Settings，build cache 未勾选。新 Preview ID 为 `AvUcY9U6373EzCQVFvF9cJDLS47i`，地址 `https://typst-cv-template-2q1pil52x-yuee98s-projects.vercel.app`；先前 Building（TypeScript）状态已于 2026-11-10 上海 18:07:52（10:07:52 UTC）变为 Ready。两个默认 Preview flags 已保存回 false，新部署的构建快照仍为 true。

**修复后唯一一次调用 UI + DB PASS。** 复验时 test 域名临时跟踪 `codex/test-acceptance-fixes`，runtime 为用户每日 3、全局每日 6、每分钟 1。2026-11-10 10:15:51.626 UTC 唯一一次确认发送 15 字虚构正文、context 0、选择 MiMo，成功进入逐条审阅并显示有效中文润色，未应用到 CV，没有为展示成功再发请求。`corrected-secret-hosted-ui.json` 记录操作及 Preview 范围，`hosted-request-log-receipt.json` 记录 Vercel 平台观察：新部署的唯一 POST `/api/polish` 于 10:15:51.855 UTC 返回 HTTP 200。这是应用接口状态，不是直接捕获的上游 HTTP 状态。Runtime Logs 的 warning、error、fatal 均为 0。

`after-key-correction-live-summary.json` 的 29 项独立核对全部 PASS：只新增 request 10 和一个 attempt，原九条事实不变，request/attempt 均成功终结、transmitted=true、provider_billable=true、无内部重试。input 569 分为 standard 57、cache read 512，output 25、reasoning 0、cache write NULL，usage 完整；config 3 的 revision 1、配置和价格 audit 5、common audit 2、provider audit 4 均未变，精确同意仍有效。按冻结 CNY 费率计算，`ceil((57×1000000000 + 512×20000000 + 25×2000000000)/1000000)` 得 117240 nanos，即 CNY 0.00011724；这是应用估算，不是上游发票。前三条 MiMo 失败的 usage/billability/完整费用仍未知；全部请求已知估算下界为 CNY 0.0020606，完整总成本仍为 NULL，不能将未知失败成本记零。

**最终恢复 PASS，保留其余验收缺口。** `key-correction-final-readonly-summary.json` 的 2026-11-10 10:18:21 UTC 回读及随后身份布尔核对共 26 项 PASS：runtime 关闭、ALLOWLIST、用户每日 20/全局每日 2000/每分钟 3、revision 29，10 请求/6 attempt 全部终结，reserved=0、charged=3、global admission=6，允许名单仍只有已授权账号，配置、规则、聚合及最后水位未再变化。正常 UI 已 Save 并 fresh reload 确认 test 域名恢复 `main`；默认 Preview flags=false，部署快照仍 true，已授权替换的 MiMo Secret 保留。没有修改 Production、推进 main/release 或合并 PR #44。

**部署环境快照边界。** Vercel 项目默认 flags=false、Preview Secret 已更新，不会回填历史 deployment。`AvUcY9U…` 修复部署使用新 Secret，其 AI 构建快照仍为 true；当前 runtime OFF 和域名恢复 `main` 是本轮收尾状态。恢复域名不是重新部署 main，不能宣称 main 旧部署的环境快照也换用了新 key。今后的 main Preview 部署会继承已更新的 Secret；重新开启 test AI 前，须确认承载该域名的 main 已使用新环境变量重新部署。本轮不再手动部署、开启 AI 或调用模型。

**文档收尾。** 验收记录提交并 push 到原草稿 PR 后，会触发常规 CI 与该分支的自动 Preview 构建，采用已恢复的项目默认环境变量；不切换共享 test 域名，不推进 main/release，也不部署 Production。这些仅文档提交的构建不冒充 `9054c0a` 的付费复验证据。10:24 UTC 封存的 `mimo-diagnosis-evidence.tar.gz` 保留当时的文档副本及 19 项脱敏证据，后续文档收尾说明不回写旧封存文件。

日志记录的认证拒绝、同 endpoint/model 的本地成功、仅替换 Preview 凭据并同源部署后的 hosted 成功，共同支持已解决 test 的凭据认证问题；它们不揭示旧 Secret 的具体内容或为何被拒绝。旧轮快照及封存文件保持原样，7/3、8/4、9/5、10/6 分别对应各自观察阶段，不回写历史。

当前仍未通过的项目为：Gemini 调用及 hosted USD 结算、CV 导出文件内容及 JSON 回环导入、真实手机 Safari、hosted 退出和普通账号隔离、真正持久化取消、hosted 同 ID 重放、正常 Admin 性能对比，以及 11 月 12 日重建后的自然保活。MiMo 成功已从待办中移除；供应商发票及前三条失败的实际费用仍超出本轮可证明范围。临时操作已收尾，本轮不为补全验收继续追加 Provider 调用。

## 工具与现场异常

- 浏览器下载事件两次失败，不再重复同一等待路径。浏览器安全策略拒绝内部下载管理页；没有绕过策略或使用其他浏览器内部接口。
- 视口 API 返回成功但页面实际尺寸没有变化；实际 DOM 尺寸为判断依据。
- 验收时误将既有本地“周林”示例移到 test 云端，内容未修改。随后经正常复制恢复同名、同内容本地副本；自动审批曾拒绝永久删除，取得当时明确确认后执行，`sample-cleanup-readonly.json` 核对云副本已移除，两个专用合成云文档保留。该快照早于付费窗口，其中 AI 关闭/无调用不代表窗口结束状态。
- 所有新建业务数据均为专用虚构验收内容。开关、限额及临时规则已有最终独立核验；域名恢复和 Preview flags=false 均已正常保存并重新载入确认。此处只确认恢复，不抬升其余未通过项目。
- 自动审批曾因缺少明确授权拒绝临时域名切换；之后用户明确授权切换并恢复，保存已成功、fresh reload 已核对。独立 Preview 地址与共享 test 域名的应用登录态不互通，实际已验证项目按其真实执行目标记录。
- 恢复 runtime 的首次保存因旧 revision 冲突失败，未把失败提交记成开关关闭。刷新载入最新表单时出现原生 JS 确认框“替换尚未保存的修改？”，`getJsDialog`、点击及聚焦均超时。尝试读取 native Edge 时，自动审批因可能暴露无关私人标签且缺少明确授权而拒绝；随后取得用户仅处理该确认框的明确授权，点击 OK 解除阻塞。正常 UI 载入 revision 22 后再次保存成功；最终 runtime 及限额以新的独立回读为准。
- Vercel 环境页曾出现 Security Checkpoint、域名页控件 disabled；reload 后确认会话过期，使用 Last Used 的 GitHub 既有 SSO 恢复。用户完成登录的 Verify Your Identity 后，域名恢复 `main` 保存及 fresh reload 成功。环境变量编辑另触发 `Verify to Reveal Environment Variable`；用户也已完成这次独立验证，随后两个 Preview flags=false 保存及 reload 回读成功，不再等待验证。不保存 token、OTP 或验证码 URL。
