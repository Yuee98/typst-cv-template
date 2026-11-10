# Test 环境补充验收

状态：`REQUESTED_THREE_PHASES_PASS`。本次按顺序完成的身份核心回归、真实四格式导出/JSON 回导和 Admin 性能采样均 PASS，最终 DB 31 项核对通过：13:50:17 UTC 为 OFF/ALLOWLIST、20/2000/3、revision 35，AI 仍 11 请求/7 attempt、reserved=0，没有新付费；四份云文档与各自基线的 hash/time 不变。test 域名已恢复 main，映射回原 Preview `7KV…` / `bc9d9ce`，并不包含本轮 PR 修复。Auth/Export 的 hosted 验收源为 `bfd461e`；显示错误修复 `bf44429` 及最终 93 文件/1612 项、TypeScript/lint 只按本地证据记，未声称新的 hosted 错误复验或已解决底层瞬时同步失败。最终 push 的 CI 终态见本轮证据目录的 `final-publication-status.json`。旧快照和封存证据保留，prod 不动；手机、真实取消/同 ID 重放及下一次自然保活等范围外缺口继续单列。

## 范围与现场基线

- 目标为共享 test 域名 `https://cvmaker-preview.dyue.org` 及同一 test 项目的独立 Preview；Supabase test 项目 `uvitgcfqnciahvakqhnv`，实例 `842d36df-6969-4c86-abcc-6dc956dd6318`。
- 本轮开始的 hosted 应用源为 `bc9d9ce827a8bd4727d866e930253452302c48e5`，数据库已完成重建。不得再次 rebuild/resume。
- prod 数据库、Auth、环境变量、部署和 release promotion 不在范围。
- 首轮独立证据目录为 ignored 的 `output/test-acceptance-20261110/`，授权重试另用 `output/test-provider-retry-20261110/`，当前版本本地对照及 HTTP 诊断另用 `output/mimo-diagnosis-20261110/`，Gemini 小额验收另用 `output/gemini-acceptance-20261110/`，身份/导出/性能新阶段另用 `output/identity-export-performance-20261110/`。私有凭据文件单独存放，文档不记录凭据内容；工具回显事件及本地扫描边界见对应轮次。
- 开始时 AI 总开关关闭，ALLOWLIST 为空，配置、规则、AI 请求和 attempt 均为 0；额度为每用户每日 20、全局每日 2000、每用户每分钟 3。后续仅将指定测试账号加入 AI 允许名单，没有追加管理员权限。
- 首轮为小额验收临时开启 AI，使用 ALLOWLIST，并将每日限额暂设为用户 4、全局 4；门禁测试还短暂使用了 0 或 1 的限制。后续授权重试及诊断/修复窗口分别按各节记录，不沿用该首轮限制。恢复目标为 AI 关闭、每用户每日 20、全局每日 2000、每用户每分钟 3，且共享 test 域名重新跟踪 `main`。最终状态必须由相应轮次结束后的新回读证明，不能沿用调用前的关闭快照。

## 当前结果

| 检查 | 状态与已有结果 | 边界与后续 |
| --- | --- | --- |
| 本地补充回归 | **PASS**：17 个文件、196 项通过；覆盖导入导出、真实 WebCrypto、云写边界、身份隔离、Admin 缓存及响应式组件 | Node/jsdom 证据，不等于 hosted 浏览器全链路 |
| 本阶段本地修复 | **PASS**：Auth 129 项、导出 25 项及各自 TypeScript/lint、独立审查通过；`bfd461e` 全套为 92 文件/1596 项。加入显示修复 `bf44429` 后，最终全套 93 文件/1612 项及 full TypeScript 通过，显示修复 25 项 scoped/lint 通过 | `readiness/joint/final-root-summary.json` 区分本地最终源码与 hosted 验收源；pnpm 入口在启动测试前因 SQLite 权限失败，改用已安装 Node binaries 成功，无安装。显示修复未称 hosted 复验通过 |
| 当前版本本地 MiMo 付费对照 | **PASS（本地）**：`214d563` 基准的真实调用链、LOCAL `cv_app_db_2` 临时数据库、同一 15 字中文/Level 0/context 0，一次真实 POST 返回 HTTP 200、3810ms，input 569/output 24；夹具清理成功 | 不是 hosted 成功；live harness 仅增加预算上限和证据元数据，其余 11 个取证文件与 HEAD 匹配。617 nanos 是夹具合成费率的应用估算，不是供应商账单 |
| 安全诊断日志及回归 | **PASS**：固定九个 primitive 字段，不含 key/ref、CV、请求/响应正文、headers、error.message。helper 32 项 + runtime 28 项共 60 项通过，TypeScript 及 scoped lint 通过 | 保留真实 RED。throwing logger 的 HTTP 401/403 用例证明日志失败不影响终态结算；模拟数据库测试不冒充 hosted 调用 |
| Hosted 加密 CV | **PASS**：专用虚构文档由普通云文档启用加密，编辑后手动保存；新标签错误口令被拒绝，更正口令后读取准确的已保存内容；原标签刷新后重新选择也能读取 | 同浏览器独立新标签，不是跨物理设备；未勾记住设备 |
| 加密文档解密派生 | **PASS**：正常“复制”操作产生准确内容的普通本地副本，随后正常移到云端 | 产品没有原地关闭加密按钮，不编造不存在的操作 |
| Hosted 导出/导入 | **PASS（四格式 77/77 + 严格回导 20/20）**：真实 JSON、`.typ`、ZIP、PDF 已按 `bfd461e` 源验证；PDF 一页且中英文完整，ZIP 可独立编译且 PNG 与实际 PDF 相同。实际下载 JSON 正常回导后新增第二个同名本地 CV，重导 JSON 与首下载字节/hash 相同 | 真实回环与早先参考 JSON 导入分开记录，不把工具 1181.217/938 秒当网站速度。filechooser stale ID 是工具错误，未造成 mutation，正常系统 Open 已完成回导 |
| Hosted 视口 | **BLOCKED**：请求 390×844 后，DOM 实际仍为 1454×1019；已立即 reset | 窄屏 override 无效；真实手机 Safari、软键盘及触摸滚动为 **NOT RUN** |
| AI 配置与条款 | **PASS**：Gemini config 4/revision 1 的配置及价格 audit 7 精确匹配，common 2/provider 5、provider acceptance audit 5 有效；fallback 保留 DeepSeek 默认和 MiMo，追加 Gemini | 30 项独立调用核对包含冻结配置、价格及精确同意；不沿用 MiMo provider 4 同意，不把通过扩大为 Google 账户实际计费层级证明 |
| Preview 构建与域名切换 | **PASS（Gemini 调用及恢复）**：仅文档变更源 `a2b7ce8` 的 `8MSDqms…` 于上海 18:50:37 Ready，部署 snapshot=true；两个项目默认 Preview flags=false，调用后域名 Save 及 fresh reload 确认 `Valid Configuration · main` | 项目默认变量不回填历史部署；恢复 main 域名不是重新部署 main。Production 未改，正式重新启用 test AI 前仍须确认 main 已采用新环境变量构建 |
| Hosted Admin 长编辑 | **PASS**：`214d563` 部署上，编辑框打开 524 秒后修改展示名称并保存，列表自动显示新值，没有手动刷新 | 仅确认实际执行的配置路径；三类页面及身份隔离的更广回归来自本地测试 |
| DeepSeek 真实调用与写回 | **PASS**：request 1 成功、单 attempt；生成结果应用、撤销、再次应用及保存已操作，DB 精确回读确认保存内容；冻结配置、条款、额度、CNY 估算逐项核对通过 | 估算 CNY 0.00134，不等于供应商发票对账。未把 DB 回读写成浏览器刷新回读 |
| MiMo hosted 调用 | **PASS（UI + DB）；前三次 FAILED 保留**：request 10 为唯一新增逻辑请求、单 attempt、`FINALIZED/SUCCEEDED`，input 569=57 standard+512 cache、output 25、reasoning 0；冻结配置/价格 audit 5、当前 common 2/provider 4 条款不变，29 项核对通过 | 成功完整估算 117240 CNY nanos=0.00011724 元，不是 invoice；未应用到 CV。旧 request 6、8、9 的未知费用仍未知，不能因新成功而改写；旧 Secret 被拒绝的具体原因不猜测 |
| 取消观察 | **完成抢先，非取消 PASS**：request 7 为 `SUCCEEDED`、已扣额度、`time_canceled=null`，单 attempt，CNY 估算 0.00060336；UI 返回配置，未应用第二次结果 | 真正持久化 `CANCELED` 终态为 **NOT RUN**；未为了抢到取消而重复付费 |
| 额度与分钟门禁 | **PASS**：用户额度为 0/已耗尽时 UI 禁用；全局额度拒绝及分钟限流由 UI 与 DB 联合核对。四条 `RELEASED` 请求没有 attempt，拒绝未产生额外发送 | 依据门禁阶段的水位隔离 MiMo/取消阶段；恢复 4/4/3 是测试窗口内部恢复，不是最终恢复 |
| Hosted 同 ID 重放 | **NOT RUN**：正常 UI 每次确认或手动重试都会生成新 UUID，没有可用的同 ID 重放入口 | 不以重新点击确认冒充重放，不为重放额外发送付费请求；真实隔离 DB 与并发 CI 覆盖见下文 |
| Gemini 凭据与调用 | **PASS（UI + 30 项调用/30 项恢复核对）**：request 11 成功、唯一一个 attempt；input 571 standard/cache 0，output 156=visible 21+reasoning 135，完整应用估算 1013250 USD nanos=0.00101325 USD；Admin 用量页及详情实际显示 USD 0.00101325、1 已结算/1 成功/1 attempt、input 571/output 156、不完整用量及成本均 0 | reasoning 仅计一次；CNY 分行且原十条/CNY 两桶精确不变，USD 独立完整成功桶，无 FX 或跨币种总和。未应用到 CV、未手动重试；不是 Google 发票或账户 Paid tier 核查 |
| Hosted 身份与退出 | **核心回归 PASS**：新源双页先解锁同一 fixture，logout 清 UI；A 正常重登后无 reload 重选，两页均空口令框、remember=false，13:08:27.670 UTC 闭环。双向云列表、B 的 Admin 拒绝及普通 fallback 均有实际证据 | peer 首次列表的 `[object Object]` 已在 `bf44429` 本地修正显示，尚无该补丁的 hosted 错误复验；底层瞬时失败原因仍未知，不把正常 Sync 恢复称为根因解决 |
| Admin 性能 | **PASS（限定样本）**：每区域 3 次 GET、1 次 POST，均 HTTP 200；hnd1 GET execution 中位数 100ms（87–349），iad1 1370ms（950–1470）；response 中位数 259/1400ms。POST execution 285/1980ms，response 457/2000ms。13:40:58 缓存回访无 loading 且日志无匹配 API | 仅 8 个实际样本，不是 p95、整页/点击延迟或慢网基准；Hobby 无外部调用细分，不能断言 Auth/DB 谁慢。旧 401 和工具 938/1181 秒不用于比较 |
| 时间规则边界 | **PASS（UI + DB）**：rule 2 在周二 Asia/Shanghai 16:05–16:06 仅允许 MiMo；窗口前显示 DeepSeek+MiMo，窗口内仅 MiMo，窗口后恢复 DeepSeek+MiMo。三次仅查询 availability，没有确认生成或模型调用 | 首轮最终 DB 回读确认临时规则 disabled、revision 2，水位仍为 7/3，没有因规则检查增加调用。后续独立尝试分别使水位增为 8/4、9/5，不回写旧快照 |
| 环境恢复与凭据修复 | **PASS（最终 31 项）**：13:50:17 UTC 为 OFF/35、20/2000/3、11/7、reserved=0；Auth 3/Admin 2，B 无 Admin/AI allowlist，云文档 A3/B1 各自 hash/time 不变；配置 3、价格 3、legal 5 未变，域名 main fresh reload | 两次测量 Save 使禁用 rule revision 2→4、control 33→35，business hash 不变；不是“数据库零写入”。main 映射原 `7KV…/bc9d9ce`，未采用 PR 修复；prod、env、main/release refs 未改 |
| 自然保活 | **NOT RUN（等待自然调度）**：重建后尚无新 schedule run；最新成功自然 run 早于重建 | 下次配置时间为 2026-11-12 02:17 UTC，即上海 10:17；实际启动可能延迟。未手动 dispatch 共享 workflow |
| 自动部署/CI | **PASS（已验收 `bfd461e`）**：db-tests、static/server、E2E、CodeQL 等实际运行检查 SUCCESS，Vercel `Fgm8bx…` SUCCESS/Ready，Supabase Preview SKIPPED | 显示修复 `bf44429` 与文档提交的最新 CI 以 `final-publication-status.json` 为准；文档提交不改变既有 hosted `bfd461e` 证据。main/release/env/prod 未改、PR #44 未合并 |

首轮证据位于 `output/test-acceptance-20261110/`，以上首轮结果以 `hosted-long-edit-and-deepseek-ui.json`、`after-deepseek-live-summary.json`、`after-mimo-live-attempt-summary.json`、`after-cancel-live-summary.json`、`quota-gates-final-summary.json` 及 `branch-214d563-ci-final.json` 为准；首轮 DB 关闭状态以 `final-runtime-restore-summary.json` 为准，域名和环境变量恢复汇总在该目录的 `final-restoration.json`。这些快照的 7/3 水位按原观察时间保留，不改成后续的 8/4。新轮采用独立目录及文末证据，不能用首轮的 final 文件冒充第二轮回读。较早“尚无调用”“域名仍临时分支”“flags 仍为 true”或“等待验证”等状态均只是当时观察，不代表当前结论。

时间规则的正常 UI 观察时间分别为 2026-11-10 08:03:37.705 UTC（窗口前，两项）、08:05:22.345 UTC（窗口内，仅 MiMo）、08:06:16.692 UTC（窗口后，两项），对应上海周二 16:05–16:06 的一分钟规则。此项依据本轮浏览器现场观察，未把 availability 查询当成付费生成。

## 补测发现的代码缺陷

1. Admin 已验证的 owner/instance scope 默认在五分钟后被普通 Query GC 回收。页面本地状态仍显示旧列表，而 mutation 完成回调因 scope 缺失跳过刷新。最小修复仅保留该 scope 至身份清理，普通读取缓存继续回收。原实现三类页面的长编辑回归失败；修复后 80 项相关测试与 TypeScript 检查通过。退出、换号、返回原账号后的旧回调隔离保留。
2. CV 编辑器退出登录时，会把正在编辑的加密文档作为明文本地 fallback 保存。已修复：加密文档退出时清口令，切换已有本地文档或新空白文档，不复制加密标题、正文或未保存内容。并复现、修复了等待 Auth 期间从普通云文档切到加密文档的竞态：普通明文 fallback 在首次 await 前只捕获原数据，退出成功后才保存，失败不改存储。普通云文档的既有 fallback 行为保持。
3. 新身份阶段复现：一个标签正常退出后，旧 peer 标签虽清除 A 的云端 UI，仍保留 remember=false 的 session 解密口令；A 正常重登再选该文档会自动解密。Auth `771a60f` 的 129 项定向、TypeScript/lint、独立审查及最终 `bfd461e` CI 通过。13:08:27.670 UTC 新部署复验中，A 重登后两页无 reload 重选均出现空口令框、remember=false，hosted 核心回归 PASS。旧场景没有观察到 B 获得 A 正文，不能表述为已发生跨账号正文泄漏。
4. 本地真实 RED 确认导出 source-path 缺陷：远端 summary 恢复但对应 body 未 adopted 时，可下载默认表单；异步 PDF/ZIP 完成前若身份或采用的文档切换，也需要撤销旧下载。v2 已加入最小 ready/菜单门禁和下载前 owner/adoption guard；定向 25 项、TypeScript/lint 通过。审查捕获 baseline 对象引用会误取消同文档正常 autosave，两个真实 RED 后改为 adoption/reset epoch。修复源 `bfd461e` 的正常 hosted 四格式 77/77、实际 JSON 回导 20/20 通过；各异步竞争边界的细分覆盖来自定向本地测试，不扩大成所有竞争场景都已手工 hosted 复现。
5. 新修复版 peer 首次云列表显示 `[object Object]`，正常账户 Sync 后恢复。最小两文件修复已提交 `bf44429`，plain Supabase 错误显示的 25 项 scoped、TypeScript/lint 及最终 93 文件/1612 项通过；保留原 native Error.message 语义，不宣称任意自定义 Error getter 无副作用。只读 peer dev.logs 的 20 条 warning 没有 error、可用 HTTP status 或已知 Supabase 请求路径，未定位底层瞬时失败；显示修复不代表根因解决，也未声称 hosted 补验通过。

第 1、2 处既有修复经独立审查，联合覆盖 5 个测试文件、93 项全部通过；该历史结果只覆盖第 1、2 项，第 3、4 项各自的新回归另列。最初联合命令误列一个不存在的测试文件名，Vitest 实际只运行 4 个文件、71 项；随后准确运行身份测试文件的 22 项通过，按实际输出合计 93，不把不存在的文件计入覆盖。

修复分支为 `codex/test-acceptance-fixes`，草稿 [PR #44](https://github.com/Yuee98/typst-cv-template/pull/44)。前两轮源为 `214d5634964ca98af76447e73acceda77cb15f4e`，分批提交为 `aa56183`（Admin）、`0aaaf5c`（加密退出）、`214d563`（东京函数）；MiMo 诊断轮又提交并 push `280eece`（live harness）及 `9054c0a01b427e53db563678329e803dd2f0b604`（安全诊断日志）。后续 Gemini 采用仅文档变化的 `a2b7ce8`，部署边界见对应章节。同分支带入先前独立的数据库切换记录提交。PR 仍为草稿，未合并 main/release。

前两轮的 Vercel 自动 Preview deployment 为 `Daz5hKYbHGQ2g7FRXhk8Jtdr7Mzq`，源/项目/Preview 属性均核对，地址为 `https://typst-cv-template-psuk1tv6f-yuee98s-projects.vercel.app/zh`。对应 `214d563` 的 Web CI `42769605166`、DB CI `42769605272` 及 CodeQL `42769601894` 均成功；后续 `9054c0a` 的新部署与 CI 见诊断轮。当时只完成登录态长编辑及部分真实 AI 路径；性能对比、身份退出及导出回导已由文末新阶段补齐，其他缺口继续单列，不能因 Ready 或 CI 成功一并记 PASS。

本 PR 的修复尚未合入 `main`。共享 test 域名已恢复跟踪原 accepted `main`；临时部署验收通过不等于这些修复已经成为共享 test 的正式版本，更不表示 prod 已发布。

`web/vercel.json` 配置新部署的函数运行区域为 `hnd1`，官方配置 schema 的数据校验通过。项目 Root Directory 为 web，该文件生效；早先独立 Preview 的 availability 401 只证明运行区域，正常登录态 Admin 的八个可比样本另见文末新阶段。已有 prod 部署不会移动；以后若将含此配置的提交部署到 Production，也会使用东京，需在 prod 发布评审时明确核对。

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

该上传/重试轮结束时的缺口包括：MiMo 成功及未知上游原因、Gemini 调用与 hosted USD 结算、CV 导出文件内容及 JSON 回环导入、真实手机 Safari、hosted 退出与普通账号隔离、真正持久化取消、同 ID 重放、正常 Admin 性能对比，以及 11 月 12 日的重建后自然保活。当时扩展文件访问权限已解除，但这些功能不能因环境文件导入成功而自动通过；后续各轮结果另列。

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

MiMo 诊断轮结束时仍未通过的项目为：Gemini 调用及 hosted USD 结算、CV 导出文件内容及 JSON 回环导入、真实手机 Safari、hosted 退出和普通账号隔离、真正持久化取消、hosted 同 ID 重放、正常 Admin 性能对比，以及 11 月 12 日重建后的自然保活。当时 MiMo 成功已从待办中移除；供应商发票及前三条失败的实际费用仍超出该轮可证明范围。该轮临时操作已收尾，后续 Gemini 验收另获用户授权并记录于下节。

## Gemini 一次小额调用及 USD 结算验收

本轮为用户明确授权的新验收窗口，仅允许一次正常 UI 小额确认；该次提交的 UI、30 项独立结算核对及 30 项最终恢复核对均 PASS。新证据目录 `output/gemini-acceptance-20261110/` 与之前已封存目录分开，不回写 MiMo 的 10/6 基线或旧轮账务记录。`gemini-baseline-summary.json` 在 2026-11-10 10:39:18 UTC 独立确认调用前为 runtime OFF、revision 29、10 请求/6 attempt、reserved=0、charged=3、global admission=6；当时没有 Gemini 配置、USD 价格或 USD 聚合，common 当前同意有效，Gemini document 5 尚无有效同意。

**部署及配置准备完成。** 源 `a2b7ce8c84a98cb4f2e818eba5ac5316ea5bc46a` 相对 `9054c0a` 仅有文档变更。新 Preview `8MSDqmsTuThXkjRTaKP7SZbc4mMk` 于 2026-11-10 10:50:37 UTC（上海 18:50:37）Ready，地址为 `https://typst-cv-template-2lwexdkww-yuee98s-projects.vercel.app`；构建使用 latest Project Settings、build cache=false，未选择 Production。部署 AI flags 快照为 true，Ready 后两个项目默认 Preview flags 已通过正常 UI 保存回 false，不回填该部署快照。现场记录为 `preview-ready-ui.json`。

旧 main 部署最初保存 Gemini 配置时，因其环境快照缺少凭据引用被正常拒绝，没有创建记录或发起调用；没有把项目 Secret 的存在当作旧 deployment 已采用变量。随后在新 Preview 上正常 UI 创建 config 4/revision 1，启用、展示名“Gemini 验收”、adapter 3，endpoint 为 `https://generativelanguage.googleapis.com/v1/interactions`，model 为 `gemini-3.8-flash`，引用既有 `AI_PROVIDER_KEY_GEMINI_PRIMARY` Preview Secret，绑定数据处理说明 document 5。没有读取凭据值或新增 Secret 上传。fallback 追加 Gemini 后有三个选项，DeepSeek 默认及原 MiMo 成员保留。

**冻结 USD 费率的适用范围。** `gemini-pricing-reference.json` 记录本轮 Google 官网核查的 Gemini 3.8 Flash Standard Paid 费率：每百万 token，input standard USD 0.75、cache read USD 0.075、output（含 thought）USD 3.75，适用日期截至 2026-12-31。未使用 cache-write 组件映射为 0，仅表示本适配器的结构性未使用桶，不宣称官方独立写入价格免费。日期声明未指明转换时区，不臆造 UTC 切换时刻；配置费率不证明账户实际计费层级或发票。来源为 [Google 定价页](https://ai.google.dev/gemini-api/docs/pricing)及 [Gemini 3.8 Flash 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)，本轮记录也注明搜索结果与直接页面读取的取证边界。

`ci-a2b-final.json` 确认本次源提交的 Web 静态构建、服务器构建、E2E、数据库测试、工具检查及 CodeQL 均成功，Supabase Preview 仍为 SKIPPED。收尾仅修改此验收文档；其常规 CI/自动 Preview 构建不替代上述真实调用证据，也不切换 main 域名或发布 Production。

**调用 UI 与独立结算 PASS。** 提交时共享 test 域名临时跟踪 `codex/test-acceptance-fixes`，runtime 为 ALLOWLIST、用户每日 4/全局每日 7/每分钟 1。用户在操作时确认 common 2/provider 5；2026-11-10 10:57:49.213 UTC 唯一一次确认选择 Gemini，发送 15 字虚构正文、Level 0/context 0，成功进入逐条审阅，显示有效中文润色，未应用到 CV、没有手动重试。实际 attempt、token 和结算由独立回读核对，不从 UI 推算。

`after-gemini-live-summary.json` 以 2026-11-10 10:58:32 UTC 的 DB 回读及审计检查确认 30 项全部 PASS：只新增 request 11 和一个 attempt，`FINALIZED/SUCCEEDED`、transmitted/billable=true、无内部 retry、usage 完整，原十条请求事实不变。input 571 全为 standard、cache read 0，output 156 包含 visible 21+reasoning 135，thought 不另加一次。config 4/revision 1 的配置及价格 audit 7 相匹配，common 2/provider 5 及 provider acceptance audit 5 精确有效。

独立按冻结 USD 费率验算：`ceil((571×750000000 + 0×75000000 + 156×3750000000)/1000000)` 为 1013250 USD nanos，即 USD 0.00101325，full/known 一致、无 overflow。新建独立且完整的 USD 成功桶；原 CNY 两桶与调用前精确相同，CNY 已知估算下界仍为 0.0020606，三条失败造成的完整 CNY 总成本仍未知。USD 与 CNY 不相加、不换汇；这证明配置费率下的应用结算一致，不是 Google 账户计费层级或发票核对。调用后水位 11/7、reserved=0、charged=4、global admission=7。

**Admin 展示及最终恢复 PASS。** `live-ui-and-restoration.json` 记录正常 UI 生成及收尾：Admin 用量页与 Gemini 详情实际显示 USD 0.00101325、1 已结算/1 成功/1 attempt、input 571/output 156，不完整用量和不完整成本均为 0，CNY 数据分行显示。runtime 正常保存 OFF、20/2000/3，列表显示未启用；域名 Save 并 fresh reload 已确认 `Valid Configuration · main`，两个默认 Preview flags=false。

`gemini-final-readonly-summary.json` 的 2026-11-10 11:01:28 UTC 最终独立回读 30 项全部 PASS：runtime OFF/ALLOWLIST、唯一已授权账号、20/2000/3、revision 33；11 请求/7 attempt 全终态且水位未再增长，reserved=0、charged=4、global admission=7。USD audit 7 独立桶为 1 次成功/1 attempt，usage/cost 完整，估算 1013250 nanos；CNY 两桶和原十笔事实精确不变。config 4 仍 enabled/revision 1，fallback 1/revision 2 保留三成员及 DeepSeek 默认，common 2/provider 5 当前精确同意及原 Preview Secret 保留。这里的“配置/规则未变”比较的是完成正常 UI 准备后的 precall 到 postcall/final；10:39 最早基线到 precall 之间，Gemini 配置及 fallback 成员是本轮已授权新增，不能说整个窗口都没有配置改动。

独立 `independent-evidence-review.json` 结论为 NO_BLOCKERS。项目默认 flags=false 不回填 `8MSDqms…` 的 true 构建快照，域名恢复 main 也没有重新部署 main；正式重新开启 test AI 前须确认 main 已用新环境变量构建。本轮没有推进 main/release、合并 PR 或修改 Production；不为补全验收追加调用，旧快照和封存文件保持原样。

**Gemini 轮证明范围与当时缺口。** Gemini 真实调用、应用 USD 估算/结算及与 CNY 的隔离已通过；Google 账户是否属于 Paid tier、实际发票及历史失败的供应商费用没有独立核查，不能据此宣称实际支付金额。该轮结束时未完成项为 CV 导出文件内容及 JSON 回环导入、真实手机 Safari、hosted 退出和普通账号隔离、真正持久化取消、hosted 同 ID 重放、正常 Admin 性能对比，以及 11 月 12 日重建后的自然保活。后续身份/导出/性能结果在下节记录，不把这里的历史缺口误作当前全部待办。

## 身份退出、导出回导与 Admin 性能

本轮按用户指定顺序完成三个阶段，`completion-summary.json` 定义结果为 `REQUESTED_THREE_PHASES_PASS`，最终恢复及 DB 核对完成。证据目录为 `output/identity-export-performance-20261110/`；AI 全程 OFF，没有新 Provider 调用。基准源 `ea6aaf3`、修复后 hosted 验收源 `bfd461ed70e184c74d52965a090610348d9fcbda`、最终显示补丁 `bf44429e39983f352091fc99d8726778e6167d5e` 分开记录，旧封存文件不改写。

**基线与普通账号准备。** `identity-baseline-summary.json` 的 2026-11-10 11:19:28 UTC 基线为 Auth 2/Admin 2、没有普通账号，两份 A 云文档（加密 revision 4、普通 revision 3）；runtime OFF/revision 33、20/2000/3，11 请求/7 attempt、reserved=0、charged=4、global admission=7。11:25:03 UTC 通过 Supabase Test Auth 的正常 Create User UI 新建虚构普通账号 B，未发送 Invitation 邮件，随机密码仅留 CUA 内存、不输出；独立 27 项确认 Auth 3/Admin 2，B 无 Admin、AI allowlist 或云文档，原权限/密码未改。

为安全 reload，原普通 A 文档先正常 Save，revision 3→4、正文 hash 不变；这次有意保存不被误记成“原文档从未更新”。此前对未核实未保存内容的 reload 拒绝，通过先 Save 后 reload 解决，没有遗留批准阻塞。随后建立专用 `Identity encrypted fixture 20261110`，正常 local→cloud→encrypt；独立 26 项确认 revision 3、data=NULL、envelope 有效，原两份文档未变。

**身份边界与真实 RED。** 新标签真实输入口令解锁已保存标记，修改为未保存加密标记后，于 11:37:24.800 UTC 退出。当前页回到既有本地“周林”，另一页为空，两页均无云端、加密 card 或标记；真实 `downloaded/after-encrypted-logout.json` 为 schema 7，全部加密 fixture 标记不存在。这是当前导出内容的边界证据，不声称扫描了全部浏览器存储。

B 经用户操作时确认并正常接受产品 terms 后，云列表无 A 项，新配置页与旧 usage 页均 FORBIDDEN，无 A 数据或旧 modal。B 正常创建自有普通云 fixture，独立 26 项确认 owner B/revision 1/schema 7；仅修改未保存标记、不切文档，于 12:14:32.679 UTC 退出后得到明确本地副本，实际 `downloaded/after-ordinary-logout.json` 严格 schema 验证通过，保留 B 未保存标记、不含 A 加密标记。`after-ordinary-logout-summary.json` 的 27 项后验确认云端保存的正文/hash 不变。普通明文 fallback 属于既定行为，不视为云 ACL 泄漏。

A 由原用户正常重登，恢复 A 的三份云文档；B 项只为设备本地副本、没有 B 云文档，双向云列表隔离通过。但修复前 caller 146 重选加密 fixture 出现空口令框，旧 peer 104 在 remember=false、退出后未再次输入口令的情况下，A 重登后却自动解密。该现场证明 peer 的外部 Auth sign-out 缓存清理缺失；B 期间 UI 没有显示 A 正文，不能称已发生 B 读取 A 正文。

**修复、CI 与 hosted 回归。** Auth `771a60f` 覆盖 peer 同步清口令、异步 load/store、late select/duplicate/discard 的 owner/ABA 撤销，以及 Storage SecurityError 不阻断新 Auth 状态采纳；129 项定向、TypeScript/lint 及独立审查通过。导出 `bfd461e` 修复“远端 summary 恢复但 body 尚未采用时下载默认表单”，增加 ready/菜单和 PDF/ZIP 下载前 owner/adoption 门禁；25 项定向通过。root 审查另以两个真实 RED 捕获 baseline 对象变化会误取消同文档 autosave，v2 改为只比较 adoption/reset epoch。

两个提交一次 push 原 PR #44；`readiness/joint/summary.json` 的 92 文件/1596 项及 full TypeScript 通过，取证文件匹配提交源，Auth/Export 独立审查均 NO_BLOCKERS。`bfd461e` 的实际运行 CI 检查全部 SUCCESS，Supabase Preview SKIPPED；Preview `Fgm8bxLaqBTViHrsgMhVaPkWTM8n` 于 12:49:14 UTC Ready。此前 v1 的 1594 只保留为旧检查边界。

修复版两页先同时解锁同一 fixture，12:59:05.953 UTC initiator logout 后均 signed out、card 和三个标记 DOM absent。`after-patched-encrypted-logout-summary.json` 在 13:01:23 UTC 的 25 项检查确认四份云文档 revision/hash/time 与各自基线一致、AI OFF/33、11/7、reserved=0。A 在另一个标签正常重登，primary 的旧 login modal 取消关闭后显示 signed in；13:08:27.670 UTC，primary 与 peer **无 reload** 重选同一 fixture，均空 password modal、remember=false。`patched-identity-hosted-result.json` 记录核心回归 PASS；没有用 reload 清缓存制造假通过。

peer 首次列表曾显示 `[object Object]`，正常账户 Sync 后恢复。显示修复 `bf44429` 只处理 plain Supabase 错误 message，保留 native Error.message 语义，不宣称任意自定义 Error getter 无副作用；25 项 scoped/TypeScript/lint 通过。`readiness/joint/final-root-summary.json` 记录加入该补丁后的 **93 文件/1612 项及 full TypeScript PASS**。pnpm 入口因本机 Store SQLite 权限在测试启动前失败，日志保留；改用已安装 Node vitest/tsc binaries 成功，没有安装依赖。该显示补丁未冒称已有 hosted 错误复验。只读 peer dev.logs 的 20 条 warning 无 error、可用 HTTP status 或已知 Supabase 请求路径，底层瞬时失败原因仍 UNKNOWN，不把显示格式修复称为根因解决。

**真实四格式导出及回导 PASS。** 先通过正常 New→Import JSON 导入本地参考 `local-reference/data.json`，得到 Synthetic Export Acceptance。该步仅为当前格式导入；CUA filechooser 单调用墙钟 1181.217 秒、请求的 30 秒 timeout 未生效，不计为网站解析延迟。早先 download waiter 阻塞 938 秒也不作为性能样本；receipt 的 `export_command_started_at` 不称实际 click dispatch。

随后取得真实 JSON、单独 `.typ`、Typst ZIP、PDF。`export-validation/hosted-four-formats-bfd461e-pinned/visual-qa-summary.json` 的 **77/77 PASS**：PDF 一页、无加密/JavaScript、中英文完整；ZIP 四 member 的 CRC/data/body/style 正确，Typst 0.15.1 可独立编译一页，两份渲染 PNG 均无裁切、重叠或中文缺字，PNG hash 相同。正常实际文件 Open 回导首下载 JSON 后，UI 新增第二个同名本地 CV；再次导出的 1352-byte JSON 与首下载字节及 SHA256 相同，副本为 `downloaded/reimported-export.json`。`export-validation/hosted-json-roundtrip-bfd461e/roundtrip-summary.json` 的 **20/20 strict deep roundtrip PASS**。stale chooser Unknown ID 未产生 mutation，经正常系统 Open 完成，不列为产品 bug；没有以参考 PDF 或参考 JSON 替代真实下载/回导。

**Admin 性能采样 PASS，范围限定为八个请求。** `admin-performance-observed.json` 保存真实 UI 原始脱敏样本，`admin-performance-statistics.json` 给出描述统计；每区域三次 GET、一笔保持业务字段不变的禁用规则 Save，全部 HTTP 200。

| 实际 Vercel 指标 | hnd1 Tokyo | iad1 Washington, D.C. |
| --- | --- | --- |
| GET execution，三样本 | 349、100、87ms；中位数 100ms，范围 87–349ms | 1470、950、1370ms；中位数 1370ms，范围 950–1470ms |
| GET response finished | 513、259、244ms；中位数 259ms，范围 244–513ms | 1500、985、1400ms；中位数 1400ms，范围 985–1500ms |
| POST execution / response，单样本 | 285 / 457ms | 1980 / 2000ms |

两区域访问相同 test Supabase；GET 为 Auth→admin_read 两个外部调用，POST 为 Auth→context→rule_save 三个调用。指定 server/admin、lib/admin、migrations 的 Git diff 相同，区域配置变化为 `web/vercel.json` 的 hnd1；样本支持本次东京部署请求明显更快，不作精确因果分解。Hobby 没有外部调用细时，不能断言 Auth 或 DB 谁慢。这不是 p95、整页/点击延迟、慢网或完整冷/热启动基准。13:40:58 的一次正常缓存回访无 loading、日志没有匹配 `/api/admin` 请求；初次未等待路由完成的 attempt 已排除，不能推广为所有导航永远不请求。

**最终恢复及 DB 31/31 PASS。** test 域名 Save/fresh reload 已为 `Valid Configuration · main`，映射回原 Preview `7KV…` / `bc9d9ce`，不是重新部署 main，也不表示 main 已采用本轮 PR 的 Auth/Export 修复或东京区域。两个默认 Preview flags=false，环境变量没有为本阶段改动，Prod/main/release refs 均未改，PR #44 未合并。

`after-admin-performance-save-summary.json` 的 2026-11-10 13:50:17 UTC 回读确认：runtime OFF/ALLOWLIST、20/2000/3、revision 35，11 请求/7 attempt 全终态、reserved=0、charged=4、global admission=7；没有新 Provider 调用。两次测量 Save 使禁用 rule revision 2→4、control 33→35，business hash 和 membership 不变，属于已记录的有意审计写入，不是“整个阶段数据库零写入”。配置 3/价格 3/legal 文档 5 不变；四份云文档 A3/B1 的 hash/time 与各自确认后的基线精确相同。原普通 A 文档在基线准备时曾正常 Save 到 revision 4，另新增 A 加密/B 普通 fixture 均按创建后基线比较，不伪称从最初两文档状态起完全没变化。Auth 3/Admin 2、原管理员保留，B 无 Admin/AI allowlist，B 当前产品 terms 有效；新账号及两份新 fixture 保留。

**源码、证据封存及范围外缺口。** 本轮 hosted 核心验收固定源为 `bfd461e`；显示补丁代码 commit `bf44429` 及后续文档提交的单次 push/CI 终态，以同目录 `final-publication-status.json` 为准，不沿用旧检查，也不把文档构建或本地 1612 项称为新的 hosted 错误注入复验。后续正式重新开启 test AI 前，仍须确认 main 已用新环境变量及目标代码重新部署；本轮不额外开启 AI、调用模型或部署 Production。

本阶段采用选择性 curated 证据，文件为 `output/identity-export-performance-20261110/identity-export-performance-evidence-20261110.tar.gz`，相邻 `.sha256` 保存独立 seal，包内 `MANIFEST.json` 记录所选文件摘要；不将包摘要内嵌本文，以避免包包含文档时循环。包包含 77+20 验证、四格式真实文件/渲染 PNG、identity/最终 DB/performance/test 摘要，不含 raw SQL、连接串、Auth ID、keys；旧 archives 不动。

本次要求的三个阶段已完成。仍未覆盖的范围为真实手机 Safari/软键盘/触摸、真正持久化取消、hosted 同 ID 重放（正常 UI 无同 ID 入口，已有真实本地 DB/并发 CI 覆盖）、11 月 12 日重建后的自然保活。供应商发票、Google 实际 Paid tier、前三条 MiMo 失败费用及旧 Secret 被拒绝的具体原因继续保持各自未知/未核查边界。

## 工具与现场异常

- 浏览器下载事件两次失败，不再重复同一等待路径。浏览器安全策略拒绝内部下载管理页；没有绕过策略或使用其他浏览器内部接口。
- 视口 API 返回成功但页面实际尺寸没有变化；实际 DOM 尺寸为判断依据。
- 验收时误将既有本地“周林”示例移到 test 云端，内容未修改。随后经正常复制恢复同名、同内容本地副本；自动审批曾拒绝永久删除，取得当时明确确认后执行，`sample-cleanup-readonly.json` 核对云副本已移除，两个专用合成云文档保留。该快照早于付费窗口，其中 AI 关闭/无调用不代表窗口结束状态。
- 所有新建业务数据均为专用虚构验收内容。开关、限额及临时规则已有最终独立核验；域名恢复和 Preview flags=false 均已正常保存并重新载入确认。此处只确认恢复，不抬升其余未通过项目。
- 自动审批曾因缺少明确授权拒绝临时域名切换；之后用户明确授权切换并恢复，保存已成功、fresh reload 已核对。独立 Preview 地址与共享 test 域名的应用登录态不互通，实际已验证项目按其真实执行目标记录。
- 恢复 runtime 的首次保存因旧 revision 冲突失败，未把失败提交记成开关关闭。刷新载入最新表单时出现原生 JS 确认框“替换尚未保存的修改？”，`getJsDialog`、点击及聚焦均超时。尝试读取 native Edge 时，自动审批因可能暴露无关私人标签且缺少明确授权而拒绝；随后取得用户仅处理该确认框的明确授权，点击 OK 解除阻塞。正常 UI 载入 revision 22 后再次保存成功；最终 runtime 及限额以新的独立回读为准。
- Vercel 环境页曾出现 Security Checkpoint、域名页控件 disabled；reload 后确认会话过期，使用 Last Used 的 GitHub 既有 SSO 恢复。用户完成登录的 Verify Your Identity 后，域名恢复 `main` 保存及 fresh reload 成功。环境变量编辑另触发 `Verify to Reveal Environment Variable`；用户也已完成这次独立验证，随后两个 Preview flags=false 保存及 reload 回读成功，不再等待验证。不保存 token、OTP 或验证码 URL。
