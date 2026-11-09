# Test 数据库重建执行记录

总体状态：`PASS`（现场切换完成）。用户于 2026-11-09T13:45:36.701Z 授权按本地方案重建 test、完整记录，prod 先不动。实际 main 的 DB CI/G3、数据库重建/复核、精确 Preview 部署及明确 AI-off 范围验收均通过，检查点保持 accepted / maintenance=false。两项 cron 已实跑并恢复原 schedule，test 自动集成已恢复并刷新核验；最终只读 verify、source/domain/release 校对和现场归档完成。窗口于 2026-11-09T16:40:55.241363Z 关闭，无待执行云端操作，不再 rebuild/resume。prod 仅三次只读保活 RPC，数据/配置/Auth/部署/release 未改。记录文档独立本地提交，发布源 SHA 仍为 bc9d9ce…，不 push 触发部署。流程见 [重建与发布手册](database-rebuild-runbook.md)。

当前维护已跨北京时间 2026-11-10；下文操作时间统一使用 2026-11-09 的 UTC，证据目录仍按窗口开始日期命名。

执行证据根目录为本机 ignored 的 `output/test-cutover-20261109/`，下文使用相对路径引用；这些不是已发布的公开下载链接。原始私有记录与本仓库脱敏实录分开保存，不把密码、key、用户 UUID、邮箱或会话写入文档。本次不申请额外 GitHub 状态令牌，不创建重建 Environment。

## 目标与范围

| 项目 | 实际值或当前边界 |
| --- | --- |
| 仓库与候选 PR | Yuee98/typst-cv-template，[PR 43](https://github.com/Yuee98/typst-cv-template/pull/43) |
| 最终批准 PR head | `df9282af4dd637919f767439715799ba14fc365b` |
| 合并前 main | `ccbeb1a4fc2baba9dbc2c15a4ba183a1be3558aa` |
| 实际合并 main | `bc9d9ce827a8bd4727d866e930253452302c48e5`，squash merge |
| 保持不动的 release | `4d4dfa5fe70d0af0fece00d5a916cb2f658bbe70`；本次未 promotion |
| Test Supabase | typst-cv-template-test，`uvitgcfqnciahvakqhnv`，Tokyo / ap-northeast-1 |
| Test API | `https://uvitgcfqnciahvakqhnv.supabase.co` |
| Test 监听分支与初始化环境 | main / PREVIEW；自动同步在维护中暂停，T13 已恢复并刷新确认，未删除分支或断开整个集成 |
| Test 应用 | Vercel `yuee98s-projects/typst-cv-template-web`，`https://cvmaker-preview.dyue.org` |
| 执行位置 | 操作员电脑；候选在 ignored `output/test-cutover-20261109/checkout/` 独立、干净 checkout；本地 `--state-dir` 为受控绝对目录 |
| 本次不改动的 prod | 项目 `cspdbjusfbaobvyqxvag`；应用 `https://cvmaker.dyue.org`，监听 release；收尾仅三次只读保活 RPC |
| 清理方法 | application_allowlist；保留既有 Auth、Storage 与平台配置 |
| 管理员 | 初始化保留唯一有效旧管理员；用户实际登录的是另一个原有 Auth 账号，经明确 test-only 授权追加 membership，原管理员与 Auth 记录均保留。身份关联只在私有引用中保存 |
| 授权开始 | 2026-11-09T13:45:36.701Z（北京时间 21:45:36.701） |
| 维护窗口 | 2026-11-09T14:15:32.962Z 至 16:40:55.241363Z；北京时间 2026-11-09 22:15:32.962 至 2026-11-10 00:40:55.241363；这是操作 intent 到关窗，不是全程停写/宕机 |
| 执行与验收 | Agent 在用户授权范围内完成明确 AI-off 范围；用户亲自条款同意已核验，全部 required checks 与收尾通过，条件性边界保留 |

Supabase 控制台中的 `main Production` 是该 test 项目的主数据库分支标签，不能据此把目标改为 prod。各步骤 PASS 绑定本次明确的 AI-off 范围，不扩展为条件性未执行项通过，也不构成 prod 重建授权。

Data API 在约 14:28Z 后关闭，14:29:18Z 保存/刷新和 503 证据确认，14:51:42Z 受控恢复供新应用验收；其后应用可访问。整个约 2 小时 25 分钟的窗口还包含用户阅读、截图工具长阻塞、验收及后置任务，不能当作实际业务停写或网站不可用时长。prod 重建仍需独立授权。

## 用户操作与代办范围

| 事项 | 分工与实际结果 |
| --- | --- |
| 登录、个人验证、组织审批 | 复用用户已有登录；需要本人验证时才交接，未新增一次性审批平台 |
| Test 数据库密码 | 用户通过受控本地输入提供最小连接资料；未写入聊天、实录或 GitHub Secret，不是 Supabase API key/access token |
| GitHub 状态 token / 重建 Environment | 已从代码与方案移除，无需创建 |
| 客户端、连接与 CA | 已准备 PostgreSQL 17 客户端、目标 session pooler 连接及官方 CA；只读 plan 已通过身份/TLS/版本检查 |
| Vercel Preview 原生变量 | 精确搜索确认既有原生 test 集成的公开 key alias；没有因部分列表未显示而替换集成密钥，重复创建草稿已丢弃 |
| 管理员账号核对 | 已发现旧管理员与实际登录账号不同；普通账号 FORBIDDEN 正确。用户明确授权后补充 test 管理权限并 SYSTEM 审计，不修改 Auth 用户或密码；未来先真实登录核对预期账号，不能仅依赖旧管理员唯一性 |
| 合并、维护、重建与部署 | 用户已授权 test 切换，由执行者完成；prod 写入/重建/发布与 release promotion 不在范围，收尾仅三次只读保活探测 |
| 记录与验收 | 本地 checkpoint/events 和脱敏证据持续归档；部署完成前不填写应用通过或 all_gates_passed |

## 现场盘点与维护屏障

| 项目 | 原值 / 盘点结果 | 已发生结果 |
| --- | --- | --- |
| Supabase test Git | main；Deploy to production 开启 | 14:26:33Z 保存为关闭；T13 已恢复 ON/main，并 save + reload 核验；main 和集成本身保留 |
| Vercel Preview | Branch Tracking 开启；All unassigned branches；域名绑定 main | 14:19:39Z 保存为关闭；T13 已恢复 ON / All unassigned branches，并 save + reload 核验 |
| Test Data API | 开启，可调用只读 RPC | 14:29:18Z 关闭并刷新确认，独立 RPC 得到 HTTP 503 / PGRST002；14:51:42Z 受控恢复供 T10 验收，不表示全部维护已结束 |
| 旧应用任务 | 只读盘点精确旧项目 cron 与在途状态 | 旧项目 cron 已停用；屏障后 running jobs、在途 request/attempt 和其他开放事务均为 0 |
| 旧 main 写路径 | 静态检查 205 个生产 web/src 文件 | 未发现直连 PostgreSQL 或 Edge Function 写入；已识别业务写经 Supabase Data API。Auth API、外部 writer 和 DB cron 另行盘点，不把 Data API off 当作所有服务停写 |
| Vercel Production | release，连接 prod 原生集成 | 本次未改动，未 Disconnect 整个项目或集成 |
| Auth/OAuth | Email enabled；GitHub provider disabled | Auth 配置未改，37 张 hosted 平台表计数与基准相同、2 个 Auth 用户保留；实际 Email 登录与 current Terms 通过。GitHub provider 原本 disabled，OAuth 回调链 NOT_RUN |
| Auth Site URL | `https://cvmaker-preview.dyue.org` | 原配置未改，实际 Email 登录与当前条款通过；未启用的 GitHub OAuth 回调链不计通过 |
| Auth redirects | `https://cvmaker-preview.dyue.org/**`、`http://localhost:3000/**` | 原配置未改，实际 Email 登录验收通过；GitHub provider disabled，对应 OAuth 回调链 NOT_RUN |
| Preview 非敏感运行 flags | 原 AI server/client flags 为 true | 关闭 AI 并设 Admin environment=preview 的保存事件当时 fresh-reload=PENDING，历史原样保留；后续同 SHA server availability=UNAVAILABLE、runtime off 保存和真实应用/最终环境复核已通过本次关闭态范围 |
| Keepalive | Action 包含 production/preview matrix；旧 RPC 返回非空字符串 | HTTP 2xx 健康判断已随 squash 进入 main；T13 本地独立探测 test/prod 各三次均 200，分别 boolean/string；未 dispatch 共享 Action，无本次 Action run/job，prod 保活未禁用 |

屏障完成后的只读排空证据为 [request-drain-post-barrier.json](../output/test-cutover-20261109/preparation/request-drain-post-barrier.json)。Data API 维护、旧 cron 停用和排空同时成立后，才进入一次性清理。keepalive 没有 preview-only 暂停开关；未为本次窗口禁用包含 prod 的整个 workflow。

## 本地参数与敏感资料

凭据只提供给当次执行进程，不建立 GitHub 重建 Secret/Variable。下表记录存在和使用状态，不记录秘密值。

| 名称 | 目标或要求 | 当前记录 |
| --- | --- | --- |
| REBUILD_PROJECT_REF | `uvitgcfqnciahvakqhnv` | 已经两次 plan 和实际 rebuild 绑定 |
| REBUILD_OTHER_PROJECT_REF | `cspdbjusfbaobvyqxvag` | 用于目标排除检查，未建立 prod PostgreSQL 连接、未修改 prod；T13 仅三次 HTTP 只读保活 RPC |
| REBUILD_SUPABASE_URL | test 项目 HTTPS URL | 与目标 ref 核对一致 |
| REBUILD_DATABASE_URL | test session pooler / postgres | 用户最小资料本地受控保存；非敏感身份为 Tokyo pooler、5432、postgres；完整连接不入文档 |
| REBUILD_CA_CERT_FILE | 官方目标 CA 的绝对路径 | 已验证 PEM CA 与 verify-full TLS；公开指纹见下节 |
| --state-dir | 本次目标私有绝对目录 | 本地 0700 目录，checkpoint/events 0600；同一操作保持同一目录，不临时换空目录重清 |
| REBUILD_EXECUTION_AUTHORIZED | 当次已授权执行进程 | 已用于 T07；不作为长期部署变量保存 |
| REBUILD_MAINTENANCE_VERIFIED | 真实屏障通过后当次设置 | 屏障证据已归档；布尔值本身不是停写措施 |
| 本地 checkpoint/events | `test-uvitgcfqnciahvakqhnv.json` 及 `.events.jsonl` | T07 至 DB-ready，T11 已推进 accepted / maintenance=false；终态不再 rebuild/resume，不手工改写状态 |
| Keepalive publishable 配置 | 公开配置最小按需处理 | 公共文档不保存值；T13 从既有 GitHub 目标公开变量读取 test/prod 公钥做只读 RPC，未为此读取 secret/service-role；受控文件 0600 |

## 候选提交与证明

| 字段 | 实际结果 |
| --- | --- |
| 审批 head 与 Relay | `df9282af4dd637919f767439715799ba14fc365b`；本轮 Relay 1/3，READY_FOR_HUMAN_REVIEW；LOCAL-INSTANCE-01 resolved，无新 blockers |
| 合并方式 | 14:31:10Z merge-commit 尝试被仓库规则拒绝，无变更；14:32:08Z squash 成功 |
| 实际 main | `bc9d9ce827a8bd4727d866e930253452302c48e5`，父提交为合并前 main；不把旧 PR synthetic SHA 当作此提交 |
| 应用 deployment | `7KVkNMD6iyqohHMgUbfA2zaTunMG`，Ready / Preview / main；实际 source SHA 精确为 bc9d9ce…，域名 `https://cvmaker-preview.dyue.org` |
| 独立 checkout | 固定上述 actual main；缺 zod 的前置失败后，仅在 ignored node_modules 补齐已存在的本地依赖，源码仍干净 |
| DB CI | [run 42635680330](https://github.com/Yuee98/typst-cv-template/actions/runs/42635680330)，manual main，head_sha 精确等于 actual main；job 129223080751 成功 |
| G3 artifact | ID `13682618280`；原始 ZIP SHA-256 `29679c4def2e0b7754843ea9c1f187abd04d5fcc0121cd9a0374f970cc87cbb8` |
| Proof | source_sha 精确等于 actual main；原始 proof SHA-256 `54e9faf05765e742070d2b091cc6684bbe4230f5ec6ad5cf22f8ccfa06e81155` |
| 基线 / 完整迁移摘要 | 均为 `74138cc9c03c706e41a2d4c75968c71bff2ba4a10dd14e2758964d853adde1ad`；15 个原始 Git blob hash 已逐个核对 |
| cleanup SQL | SHA-256 `2830f6c075dc6bf94d09906fa2ee09a005c48f8249c1b4bcff51e8bb026f48f5` |
| retired inventory | SHA-256 `f657ea9cc89c0407737579510fa2ac3c718a13c07d80efcba5a4e89dc8c3c6a6` |
| 工具与目标版本 | Supabase CLI 2.109.0；本机 psql 17.11；Node 24 系列；实际 test PG 17.6，数据库 postgres |
| CA | 官方 Supabase Root 2021 CA；有效期 2021-04-28 至 2031-04-26；文件 SHA-256 `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7` |
| CA 证书 SHA-256 指纹 | `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`，与文件 hash 是不同表示 |
| 后续实录 commit | 本记录独立 docs 提交（见 Git 历史；源发布 SHA 仍为 `bc9d9ce827a8bd4727d866e930253452302c48e5`）；本地记录分支不 push，不触发部署，不改绑接受状态 |
| 长期证据 | 本次现场结束快照已封存：141 个文件索引 execution-artifact-index.json；test-cutover-evidence.tar.gz 为 546091 bytes，SHA-256 `88ebfab792ba83200c8af7955b44e64f2c515dff7bdc48559122b66c86268318`；原始私有资料另以 0600 保管 |
| Accepted checkpoint 交接 | accepted-test-checkpoint.json，0600；phase=accepted，maintenance=false，同 source/instance/15 history；SHA-256 `2821ff099c9ab5b58b1492168f9d35e875528ab131d7a0d41e06b163e89b0427`，供未来获授权 prod --test-state 读取 |

独立 G3 核验见 [verification.json](../output/test-cutover-20261109/actual-main-g3/verification.json)、[test-counts.json](../output/test-cutover-20261109/actual-main-g3/test-counts.json)、[archive-index.json](../output/test-cutover-20261109/actual-main-g3/archive-index.json)。实际 main CI 通过工具 55、loopback guard 8、8 份 SQL/173 断言、6 份真实 DB/API/21 测试、8 个两连接边界和 10 项真实 Auth/Admin 浏览器测试。G3 的 12 类平台指纹相等；演练中断后 resume/重复 resume 与缺检查点拒绝通过。构造的 reset_started 恢复与真实断电/kill 不同，checkpoint-loss 标志仍为 false，不补写为通过。这些 CI 证据不能替代本次 hosted test 的重建后平台对比与应用验收。

实际 main 的自动 CI 已独立只读核对，见 [actual-main-ci-summary.json](../output/test-cutover-20261109/actual-main-ci-summary.json)：8 个 check-run 全终态，7 success（含手动 DB/G3）及预期的 Supabase Preview skipped；另有 Vercel commit status success。自动 CI run `42635636113` 的 4 项工作全部成功，CodeQL dynamic run `42635635547` 的 2 项 Analyze 成功。其真实 Linux/Chromium 日志为普通浏览器 27 passed，包含 responsive-workspace 的 25 项（9 种 viewport、双语 header、coarse pointer），另有 paired-fake Provider 选择 1 passed。同 SHA 的本地 Auth/Admin CI 还实际执行了 Sign out 后普通账号 FORBIDDEN 测试。这些是 CI 本地范围，不替代本次 hosted 窄屏或真实退出验收。

## 执行步骤状态

| 步骤 | 工作 | 当前状态 | 已观察事实与证据 |
| --- | --- | --- | --- |
| T01 | 确认目标、保留项、执行位置和授权 | PASS | 用户最小连接已安全提供；PG17/TLS/旧对象、管理员和 allowlist 只读核验通过；见 execution.json 与 preparation/platform-readonly-summary.json |
| T02 | 交付 keepalive 的 HTTP 成功检查，保留 prod 防回收能力 | PASS | 代码已合并 main，原同一只读 RPC 和 matrix 保留；真实 test 基线三次 200；未把最终 prod/test 健康验收提前计入 |
| T03 | 保存平台/集成原值，暂停 test 自动同步与部署，验证停写和排空 | PASS | Preview tracking、test Git autodeploy 和 Data API 已关闭；旧 cron 停用；屏障后在途 request/attempt、其他开放事务和运行 jobs 均 0 |
| T04 | 合并候选，固定实际 main SHA | PASS | merge-commit 拒绝后 squash 成功；actual main 为 bc9d9ce…，release 未推进 |
| T05 | 实际 SHA 的 DB CI、完整 G3 核验与本地归档 | PASS | 指定 run/job 成功，原 ZIP digest、strict source、15 hashes、12 指纹及恢复边界均核验 |
| T06 | 本地只读 plan 与真实 hosted 保留基准 | PASS | zod 前置失败修正后 actual-main plan attempt2 通过；旧历史 60、新清单 15、当前新环境/instance 不存在；canonical allowlist 无未知依赖/owner；hosted 平台保留基准已另存 |
| T07 | 一次 application_allowlist rebuild，保存 operation/state | PASS | 14:41:17.299Z–14:46:26.141Z，exit 0；checkpoint=DB-ready、maintenance=true、15 history，见 hosted-test-rebuild.json |
| T08 | 重建后核验 contract、PREVIEW、首管理员、instance、AI/jobs 与保留项 | PASS | 14:48:44Z post-rebuild-verification 全项通过；37 张 hosted 平台表计数未变，2 个 Auth 用户保留，AI/cron 关闭；真实 UI 登录归 T10 |
| T09 | 部署同 SHA Preview，记录 deployment/环境映射并限验收访问 | PASS | 14:51:42Z deployment 7KVkNMD6iyqohHMgUbfA2zaTunMG=Ready / Preview / main / exact SHA，域名正确 |
| T10 | 应用、权限及本次 AI/付费范围验收 | PASS | AI-off 范围复核完成，10 项 required checks 全 PASS；条件性未执行项明确排除，不将 logout/mobile/paid 等改写为通过 |
| T11 | acceptance evidence 与最终 resume 至 accepted | PASS | 16:25:21Z–16:26:15.725Z，exit0；实际 checkpoint=accepted / maintenance=false，source/instance/operation 与本次一致 |
| T12 | 最终 resume 后启用任务并核验实际运行 | PASS | 首次 42501 诊断后保留 intent 续跑；16:31/16:32 两 job 均 succeeded，retention 临时计划实际成功 2 次；原 schedule 恢复并 active |
| T13 | 恢复 test 集成/写入口并核验 keepalive | PASS | test Git ON/main、Preview tracking ON/all unassigned 均 save+reload；Data API 已 ON；本地 test/prod 各三次只读 RPC 均 200，未改 prod |
| T14 | 现场最终校对、关闭窗口、证据归档及 prod 交接 | PASS | final only-verify exit0、source/domain/release 与保留项复核通过；16:40:55Z 关窗，141 文件现场索引/归档及 accepted checkpoint 已封存。独立 docs 记录提交见 Git 历史，不作为重新发布或 accepted 换绑 |

### 已发生操作与纠正轨迹

| UTC 时间 | 步骤 | 实际结果 |
| --- | --- | --- |
| 13:45:36Z | T01 | 用户授权 test 本地方案切换与完整记录，明确 prod 先不动。 |
| 13:58:43Z | T01 | 自动审批拒绝复制/读取包含额外 PostgreSQL/JWT/service-role 资料的完整 Vercel snippet；未执行该读取。改为用户仅安全提供 test 最小连接，原失败记录保留。 |
| 14:00:12Z–14:01:29Z | T01 | 安装官方 Homebrew libpq@17 客户端，未启动新数据库服务；用户输入最小连接后本地解析，未打印凭据。 |
| 14:03:43Z–14:04:04Z | T01 | pre-merge 只读 plan exit 0；确认 PG17、旧库身份/历史及新清单。 |
| 14:15:20Z–14:15:26Z | T02 | 不调用共享 Action，仅 test 的 keep_project_active 三次 POST，均 HTTP200/JSON string；没有业务写或付费请求。 |
| 14:15:32Z | T03 | 维护开始，北京时间 22:15:32；记录原 tracking/autodeploy 状态及 prod 排除范围。 |
| 14:19:39Z | T03 | Preview Branch Tracking 关闭并刷新确认；初始无效 UI 操作未改变配置，实际保存后的状态单独核验。 |
| 14:26:33Z | T03 | test Git Deploy to production 关闭，刷新确认；保留 main/原生集成。 |
| 14:29:18Z–14:30:11Z | T03 | Data API 关闭且实际 RPC 503/PGRST002；精确旧 cron 停用、运行数 0；屏障后请求、attempt 和其他开放事务为 0。 |
| 14:31:10Z | T04 | merge-commit 被仓库规则拒绝，未改变远端；未强推或改仓库规则。 |
| 14:32:08Z | T04 | squash 合并成功，actual main=bc9d9ce…；未运行 Promote Release。 |
| 14:32:55Z 起 | T05 | 人工触发唯一 actual-main DB run；成功后只读下载 ZIP/元数据/日志，严格校验实际 SHA，不重绑旧 synthetic 证明。 |
| 14:36:19Z（实录所记） | T06 | actual-main plan attempt2 成功；首次因独立 checkout 缺 zod，在模块解析、数据库访问前退出。随后只补 ignored 依赖，保留失败轨迹，canonical catalog/history 未变。 |
| 14:38:56Z | T06/T09 准备 | 独立 clean checkout 与精确 CLI 就绪；Preview AI flags 已保存为关闭，fresh-reload 验证当时仍 pending。 |
| 14:41:17Z–14:46:26Z | T07 | 一次受控 rebuild exit 0，到达 DB-ready，maintenance=true；未重复 reset。 |
| 14:43:03Z | T09 准备 | Vercel 部分变量列表曾被误判为缺少公开 alias。精确搜索确认 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 已来自原生 test/Preview 集成；创建提示 already exists，重复草稿丢弃，没有替换原集成 secret。 |
| 14:48:44Z | T08 | 重建后 hosted 只读复核 PASS；15 history、当前 contract/PREVIEW/instance、管理员、AI off/jobs inactive 与平台保留检查均通过，见 preparation/post-rebuild-verification.json。 |
| 14:51:42Z | T09 | 实际 Preview deployment Ready、main 与 exact SHA 已核对，域名正确；不是仅凭点击创建按钮记通过。 |
| 14:51:42Z 起 | T10 | Data API 受控恢复用于应用验收，AI/cron 仍 off，未恢复自动集成。 |
| 14:53:42Z–14:57:58Z | T10 | 独立匿名 Data API 检查 9/9 通过；独立 Web HTTP 检查被现有 Vercel Protection 的 302/401 拦截，未到达应用，不计为应用 PASS，也未绕过保护。 |
| 登录验收阶段（记录 14:58:40Z） | T10 | 用户登录的是另一个原有 Auth 账号，初始 Admin FORBIDDEN 符合权限边界；首次追加 grant 因缺少明确授权被自动审批拒绝，未执行。随后用户明确回复“授权添加为 test 管理员”。 |
| 14:57:59.513Z–14:58:08.917Z | T10 | 仅为用户指定的既有 test 账号追加管理员 membership，exit 0，SYSTEM 审计确认；保留原管理员、Auth 用户与密码。事件记录时间晚于实际命令时间，两者按原始实录保留。 |
| 授权纠正后 | T10 | 刷新后真实 Admin 显示 TEST/PREVIEW 和配置列表。正常 Vercel 浏览器观察应用错误 UNAUTHORIZED（Admin 无 Bearer）与 UNAVAILABLE（AI 关闭）；未采集 HTTP 状态，不据错误代码推断数字。 |
| 表单验收 | T10 | 禁用配置创建/编辑完成；结构化 DB 回查确认配置与四项价格 typed audit 同一 operation，输出价 1.25 CNY 对应 1250000000 nanos。独立禁用说明创建/编辑、runtime 关闭态保存、pinned Terms reader 通过，未调用 Provider。 |
| 15:10:43Z | T10 | SYSTEM 审计确认删除本次禁用配置/价格/说明 fixture，remaining fixtures=0；保留配置与价格 typed audit 各 3 条，AI requests/attempts 均 0。 |
| 约 15:13Z–16:12:57Z | T10 证据归档 | 本机 CUA/Preview 截图归档尝试阻塞约一小时，最终 ScreenCaptureKit 捕获初始化失败；没有保存截图文件，没有因此执行云端数据库动作，不宣称截图已归档。 |
| 16:13Z 用户确认；16:15:25.994Z 只读观察（随后追加实录） | T10 | 用户明确确认已亲自点击当前 cloud Terms 接受；current-human-gate 核对当前 document/audit/digest 精确匹配，结果 true。16:17:40Z 左右是补记事件时间，不作为数据库观察时间。不是 agent 代点，也不是 AI 条款接受。 |
| 当前云端 CV 验收 | T10 | 独立空白 fixture “Cutover UI 20261110”完成 cloud create、编辑保存、完整页面 reload 后重新 select，header/subtitle 回读正确且 preview ready；随后删除唯一 fixture。 |
| 16:20:37Z | T10 | final-application-readonly PASS：CV 及 smoke config/price/doc fixture 均为 0，AI request/attempt=0、runtime off、cron inactive；当前条款精确接受、2 个有效管理员、instance 与 15 history 均匹配。 |
| 截止当前 | T10 范围边界 | hosted viewport override 请求 390，但实际仍为 1454，已 reset，故 mobile=NOT_VALIDATED。真实 logout 因缺少额外明确授权被自动审批拒绝、未执行且未绕过，保留用户登录；本次 off 范围不反复要求用户退出，记 NOT_RUN。 |
| 最终范围复核 | T10 | acceptance-evidence 固定 10 项 required checks 为 PASS；本次为 AI-off/明文云端 CV 范围，条件性未执行项另列，不用 all_gates_passed 掩盖证据边界。 |
| 16:25:21Z–16:26:15.725Z | T11 | 最终 resume exit0，将实际检查点推进 accepted / maintenance=false，保留原 source、instance、operation 和 15 条 history。 |
| 16:26:58Z | T12 | 首次 start 报 SQLSTATE 42501；一次性脚本对 managed cron.job 加 FOR UPDATE 超出当前角色 UPDATE 权限。未直接 grant，保留 ENABLE_REQUESTED intent，先只读诊断两 job 仍 inactive、没有 run。 |
| 16:28:51Z 起 | T12 | 修正仅移除 managed row lock，增加保留 intent 的 continue 路径；通过 cron.alter_job 启用，未增加权限或新建 job，未再次 resume/rebuild。 |
| 16:31 / 16:32 UTC | T12 | 两个 job 的真实 run 均 succeeded；临时每分钟 retention 实际成功 2 次，不将它改写为只执行一次。 |
| 恢复计划后，记录 16:35:24Z | T12 | restore PASS：cv-ai-reconcile active / `* * * * *`；cv-ai-retention active / `17 3 * * *`。 |
| 16:31:02Z–16:31:58Z | T13 | 本地 test 三次 HTTP200/boolean，prod 三次 HTTP200/string；同一只读 keep_project_active RPC，无共享 Action dispatch，也无本次 run/job。 |
| 记录 16:35:24Z | T13 | test Supabase Git Deploy ON/main、Vercel Preview Branch Tracking ON/all unassigned 均保存并刷新确认；Data API 已 ON，Production 未改。 |
| 16:34:44Z–16:35:10Z | T14 | 仅执行最终 verify，exit0；context ready / PREVIEW / cv_app_db_2 / 同 instance，15 history、30 private tables、unprotected=0/public application tables=0，检查点 accepted。未再 resume/rebuild。 |
| 最终现场复核 | T14 | git ls-remote 确认 main=bc9d9ce…、release=4d4dfa5…；Vercel Production Ready / release 4d4dfa5… / cvmaker.dyue.org 未变，test Admin controls 实际正常且 AI off；两个自动集成再次 fresh reload 核验。 |
| 16:40:55.241363Z | T14 | 关闭本次窗口，北京时间 2026-11-10 00:40:55.241363；final-environment-summary 与 execution.phase=completed，无新增云端操作待办。 |
| 现场归档完成 | T14 | 141 文件索引和 546091-byte tar.gz 已封存，排除凭据输入、私有身份关联及执行 checkout；accepted checkpoint 单独复制。记录提交信息之后只追加 record-commit.json sidecar，不修改既有现场索引或归档。 |

T07 的 operation 为 `0b98aa5d-b18a-4d3a-b5eb-6314b4011422`，新数据库 instance 为 `842d36df-6969-4c86-abcc-6dc956dd6318`，两者都是执行/数据库元数据，不是用户身份。T11 后两者保持不变，检查点已 accepted / maintenance=false。原始执行事实以 [execution.json](../output/test-cutover-20261109/execution.json)、[hosted-test-rebuild.json](../output/test-cutover-20261109/hosted-test-rebuild.json)、[post-rebuild-verification.json](../output/test-cutover-20261109/preparation/post-rebuild-verification.json) 和 [hosted-test-final-resume.json](../output/test-cutover-20261109/hosted-test-final-resume.json) 为准。accepted 是终态，后续只运行只读 verify 和单独的后置任务/集成恢复流程，不再 rebuild/resume，不覆盖既有失败记录。

### 后续每次操作的记录要求

记录步骤与开始/结束时间、候选 SHA、mode、目标、预期结果、退出码、真实 state/phase、run/deployment、证据文件摘要和下一步。敏感命令输入使用环境变量名或私有引用，不复制用户 UUID、邮箱、连接或 key。原始证据与脱敏副本分列。

`phase=migrations` 只表示进入阶段，不保证所有文件已完成；`DB-ready` 不代表应用已通过。网络超时或 reset_started 不明时，先核对 state/catalog/history，按受控 resume 前进，不重复清库、不手工 repair/accepted。若使用恢复证明，明确是真实观察还是演练构造。

### 应用验收

| 验收项 | 必须记录的结果 | 状态 |
| --- | --- | --- |
| Auth 与权限 | 普通账号 FORBIDDEN、明确授权补充管理员后实际读取、无 Bearer 应用 UNAUTHORIZED 均通过；真实 logout 未获额外授权而未执行，CI logout 范围单列 | 本次 required 范围 PASS；hosted logout NOT_RUN |
| 明文 CV 与实例 | 用户亲自接受精确当前条款；cloud create/edit/save/full reload/reselect 回读/preview ready/delete 通过；最终 CV=0，未复用旧同意 | PASS |
| Admin | 配置 create/edit 与 typed config/price 原子回查、独立禁用说明 create/edit、runtime off 保存通过；fixture 已清理，本次 required 范围完成 | PASS |
| 条款与选择 | pinned common/provider reader、用户亲自 cloud Terms 接受和精确 current gate 通过；未提交 AI terms acceptance | 本次 required 范围 PASS；AI 同意/生成 NOT_RUN |
| AI 与额度/结算 | 关闭态应用错误 UNAVAILABLE 已观察，无 HTTP 数字推断；接受前 AI/cron off、requests/attempts=0。hosted routing/quota/settlement 未开启，不据 CI 改写为 hosted 执行 | 关闭态 PASS；其余 NOT_RUN（AI-off 范围） |
| 加密云端 CV | 当前 hosted smoke 仅明文云端流程；加密流程的 CI/源码证据单独归属 | NOT_RUN（本次范围外） |
| Hosted 窄屏与截图 | 请求 390 的 override 未生效，实际 1454 并已 reset；截图归档工具失败且无文件。CI 同 SHA 响应式 25 项另列通过 | Hosted mobile NOT_VALIDATED；截图未保存 |
| 付费调用 | 本次保持 AI off，Provider 网络调用与付费请求为 0；未进行 hosted paid smoke | NOT_RUN（当前 off 范围） |
| 接受证据 | 10 项 required checks 通过，条件边界明确；source_sha、manifest、instance 与 all_gates_passed/applications_verified 一致，最终 resume 已完成 | PASS |

本次 [acceptance-evidence.json](../output/test-cutover-20261109/acceptance-evidence.json) 明确列出 10 项 required checks 均 PASS，all_gates_passed/applications_verified=true；同 SHA、清单与实例已由最终 resume 核对。条件性排除为未开启的 Provider/AI 选择及 AI-specific 同意、路由/额度/结算/付费调用，加密 hosted CV、hosted mobile 和真实 logout；各自理由保留，不改为 PASS。verify 不能代替该最终 resume，accepted 后也不再 resume。CI G3 不调用真实 Provider，不证明线上实际供应商费用。

### 接受后的恢复验收

| 验收项 | 必须记录的结果 | 状态 |
| --- | --- | --- |
| 任务 | 两 job 真实 run succeeded；reconcile active/每分钟、retention active/03:17UTC 已恢复；临时 retention 实际 2 次 | PASS |
| Keepalive | 本地 test/prod 各三次同一只读 RPC 均 HTTP200；记录每次时间与响应类型，无 Action run/job | PASS |
| 自动集成 | test Git ON/main、Preview Branch Tracking ON/all unassigned、Data API ON；Production 未改 | PASS |
| 最终关闭与归档 | final only-verify、source/domain/release/保留项及自动集成 fresh reload 全部通过；窗口已关闭，现场索引/归档和 checkpoint 副本已封存；记录提交独立处理 | PASS（现场） |

最终证据见 [hosted-test-final-verify.json](../output/test-cutover-20261109/hosted-test-final-verify.json)、[final-environment-summary.json](../output/test-cutover-20261109/final-environment-summary.json)、[execution-artifact-index.json](../output/test-cutover-20261109/execution-artifact-index.json)、[现场归档](../output/test-cutover-20261109/test-cutover-evidence.tar.gz) 和 [accepted checkpoint](../output/test-cutover-20261109/accepted-test-checkpoint.json)。141 个文件的现场索引与归档是已结束 snapshot；原始私有文件保持 0600，不进入公开文档。后续仅用 record-commit.json sidecar 登记本记录的独立本地 commit，不修改已索引档案，不把记录 commit 改作实际部署/accepted 的 source SHA。

[归档完整性复核](../output/test-cutover-20261109/archive-integrity-verification.json) 是封存后的独立 sidecar，141 个索引 hash 均匹配，142 个 tar entries 已核对，已知 hosted 密码/连接 URI 字节未进入归档；不列出这些敏感字节，也不改动既有归档摘要。

## 异常与恢复边界

已发生的审批拒绝、模块解析缺依赖、merge 方法拒绝和变量部分列表误判均已保留，见上表。它们不等于数据库清理失败；首次真正 rebuild 已成功退出。其后任何失败应记录具体 phase/catalog/history，保持维护并按同一 operation 恢复，不将旧应用直接指向新库作为回滚。若需要新源码/DDL 修复，保留旧记录并先验证新候选，不改写已应用历史。

本次管理员验收出现身份选择不一致：初始化所保留的唯一旧管理员，与用户实际登录的另一个原有 Auth 账号不同。数据库只读身份核对成功，但这不足以证明用户将使用该账号；普通账号被 FORBIDDEN 拒绝是正确行为，不是 migration bug。首次未获明确授权的 grant 被自动审批拒绝且未执行；用户随后明确授权添加指定 test 管理员后，才完成 membership 写入和 SYSTEM 审计。原管理员、Auth 用户和密码均未改变，source SHA 仍为 bc9d9ce…。证据见 [intended-admin-membership-correction.json](../output/test-cutover-20261109/intended-admin-membership-correction.json)，身份仅保存在其 private reference，本文不公布账号标识。prod 复用时必须先由用户以预期账号真实登录并核对目标 Auth 身份/权限，不能凭邮箱、同名或旧管理员唯一性自动提权。

独立 HTTP 检查因现有 Vercel Protection 未到达应用，分类为 BLOCKED，不把网关 302/401 当成应用返回。后续正常 Vercel 浏览器实际到达应用并看到 UNAUTHORIZED/UNAVAILABLE；未读取其 HTTP 状态，故不填数字。详见 [匿名检查](../output/test-cutover-20261109/application-anonymous-acceptance.json) 与 [真实浏览器验收](../output/test-cutover-20261109/browser-acceptance.json)。禁用验收 fixture 清理及保留审计见 [ui-fixture-cleanup.json](../output/test-cutover-20261109/ui-fixture-cleanup.json)。用户已完成云端条款操作，精确接受见 [current-human-gate-readonly.json](../output/test-cutover-20261109/current-human-gate-readonly.json)，最终数据与维护状态见 [final-application-readonly.json](../output/test-cutover-20261109/final-application-readonly.json)。

截图归档的长阻塞最终为 ScreenCaptureKit 工具失败，不是应用或数据库恢复失败；未创建截图文件，不补写截图成功。hosted 窄屏 override 没有生效，实际仍是 1454；其结果为 NOT_VALIDATED，即使同 SHA CI 响应式测试通过也不改名为 hosted PASS。真实 logout 的自动审批拒绝同样记为未执行，未绕过，也不为本次非必要退出反复打扰用户；CI 的实际退出/账号缓存隔离覆盖只标 CI 范围。这些边界已进入 AI-off 范围复核，T10/T11 已通过；T12/T13 有实际运行和恢复证据，T14 另以最终 verify、fresh reload、关窗和归档证明收尾，不把 accepted 的 maintenance=false 单独当作整个窗口完成。

T12 的 42501 是一次性操作脚本对 managed `cron.job` 使用行锁导致，不是迁移或应用源码缺陷。只读诊断见 [cron-start-failure-readonly.json](../output/test-cutover-20261109/preparation/cron-start-failure-readonly.json)；start/continue/status/restore 的精确文件路径及原值在 execution.json 的对应事件中保留。续跑保持原 intent，只去掉 managed table 的 FOR UPDATE，以 `cron.alter_job` 完成，无 GRANT、平台角色提升或新 job。prod 复用必须使用修正版，不复制行锁，也不保证临时计划只执行一次；本次记录实际 retention 成功 2 次及恢复后的计划。accepted 后未再运行 resume/rebuild。

最终保活证据为 [final-keepalive-verification.json](../output/test-cutover-20261109/final-keepalive-verification.json)：2026-11-09T16:31:02.250Z–16:31:58.798Z，本地 test/prod 各三次 RPC 均 HTTP200，新旧返回分别 boolean/string；只记录类型、不记录响应正文或 key。本地探测没有 Action run/job，用实际时间、目标、RPC/HTTP 记录。prod 的访问边界是这三次只读 RPC，不是“从未访问 prod”；prod 数据、配置、Auth、部署与 release 均未改变。

## Prod 重建前复用检查

- 本次 test 已 accepted，后置任务、集成恢复、最终校对、窗口关闭和现场归档均完成；prod 重建仍需独立授权，不能只因 accepted 或只读保活成功就开始切换。
- test 最终 accepted 的完整 SHA、两类清单、真实部署及全部必需验收须能互相核对；归档不得只依赖短期 artifact。
- 复制本流程到独立 prod 实录后，将状态重置为 NOT_STARTED，重新核对项目、连接/CA、管理员、保留项、维护窗口与各类 run/operation/instance，不照搬 test 用户或成功状态。
- prod 使用同一已通过 test 的完整 SHA/摘要；本地 --target=prod 显式绑定目标和 --test-state，读取本次最终 accepted 私有文件；无需 GitHub 状态 token、仓库变量或重建 Environment。
- prod 的原生配置变量应精确搜索并核对资源/作用域，不能由部分 UI 列表推断缺失；先处理维护和 DB-ready，再受控 promotion/deploy/验收，不让 release 自动同步抢跑。
- 明确登记任务/写入口暂停、恢复及最终 keepalive；最后一次 resume 会重新注册 inactive jobs，恢复后须重新核验。
- 使用去除 managed cron.job 行锁且可保留 intent 继续的修正操作脚本；通过 cron.alter_job，不直接锁表/改表或 grant。临时 retention 实跑可能跨多个 tick，按实际次数记录并核验恢复原 schedule。
- 未来 prod --test-state 使用已封存且通过 SHA-256/0600 核对的 accepted-test-checkpoint.json；发布候选仍为实际通过本次 test 的 bc9d9ce…，不自动追随独立记录 commit。记录文档/sidecar 与现场归档分开，不能给旧 proof 或成功状态换绑新 SHA。

当前结论：test 本次现场切换与 AI-off 范围验收完成，T01–T14 均 PASS，检查点保持 accepted / maintenance=false；任务原计划、自动集成、保留项及 source/domain/release 已最终核验，窗口于 2026-11-09T16:40:55.241363Z 关闭，现场索引与档案已封存，无待执行云端操作。记录文档独立本地提交、不 push，不改变发布 SHA，也不再 rebuild/resume。prod 仅三次只读保活 RPC，数据/配置/Auth/部署/release 未改，后续 prod 重建另需授权。
