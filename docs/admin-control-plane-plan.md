**Admin 配置与 AI 运行管理方案（草案）**

日期：2026-09-03。代码基线：main，2783057292cef4ba3889d6bded31ce7863b2270f。

本文提出下一阶段设计，不改变现有运行时契约、发布权限或线上状态。Preview 已运行双 Provider 是本次用户提供的背景；本次核对范围为本地最新代码和官方技术资料，未检查线上数据库、部署配置或调用 Provider。

目标是让管理员通过 Web 管理 AI Provider 的连接配置、版本、路由和运营数据，同时保留请求快照、配置不可变、受控发布和审计。按本轮讨论，endpoint、密钥环境变量名和 model ID 使用文本输入，不维持逐个 profile/model 的代码白名单；adapter 使用由代码实现、migration 登记的字典项。自由输入仍要通过格式、地址、secret 用途、能力、价格与 legal/runtime 覆盖验证。新增已支持能力范围内的模型应能通过配置和验证完成；新增协议实现或不兼容行为仍需开发与部署。用户级 AI 白名单、停用和配额调整界面后续再做。

**1. 对外部建议的取舍**

| 建议 | 本方案决定 | 原因 |
| --- | --- | --- |
| Endpoint 与 credential 引用入 DB，真实 key 留在部署环境 | 采纳 | 符合配置管理目标，并保持密钥边界 |
| 优先 credential_ref，推导环境变量名 | 选择完整 credential_env_name 加受限解析 | 延续用户原先要求；引用名映射是可选表达方式，安全性来自 secret 范围和接收方绑定 |
| Endpoint 属于不可变 profile version | 采纳 | 连接参数是执行语义，变更必须生成后继版本 |
| 在旧 profile version 上 UPDATE 回填新字段 | 调整为保留 v1、创建 v2 后继版本 | 当前 trigger 禁止变更执行字段，包括新增的执行列 |
| 把新字段并入现有 config_sha256 或新增 execution_sha256 | 保留现有 hash 含义，第一版不新增 execution_sha256 | profile 的 config_sha256 对应 adapter config；新执行字段由不可变版本 ID 与逐字段校验绑定，无需再存一份全量摘要 |
| 单独增加 destination_policy_id | 第一版不新增 | 用现有 gateway/adapter/wire 与 runtime contract 定位已审核地址约束，避免再增加一套策略身份 |
| Adapter 使用迁移维护的枚举字典 | 采纳字典表与外键，不额外增加 PostgreSQL 原生 enum | UI 读取目录与当前 runtime 能力的交集；表中存在不代表部署已经支持 |
| credential_generation 放 profile version | 第一版不增加 | 同名 secret 可以在部署时轮换，profile 字段无法证明实际使用哪一代 key |
| 重定向使用 manual | 保留现有 redirect: error | 当前 adapter 已禁止自动重定向，继续保持并覆盖所有 3xx 失败路径 |
| 同仓库、独立 Admin 应用 | 首期采用现有 web 内的 Admin 模块 | 当前规模下复用登录、部署和 runtime 更直接；通过构建入口管理隔离静态产物，按用户最新方向调整 |
| 首期三个管理员角色 | 首期仅 admin | 沿用已讨论的首位 DB 添加、后续页面授权规则；内部能力检查集中实现，便于未来扩展 |
| 分析可以直接展示所有列出的指标 | 分为已有事实与新增采集 | 当前统计来自 ledger；配额拒绝发生在 request 插入之前，不能从成功入账记录反推完整拒绝量 |
| 一开始建立多个 shared packages | 首期不增加 workspace package | 同一 web 内按模块共享必要契约与校验，后续确有跨应用复用时再提取 |

两个补充约束：专用 secret 前缀不能单独防止把 MiMo 的 key 发给其他接收方；域名文本检查也不能单独解决 DNS 解析和实际连接之间的变化。[OWASP SSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)分别讨论了目标 allowlist、禁用重定向和 DNS 风险。本方案允许文本填写 endpoint，但启用需要接收方授权和匹配的出站防护；不能只凭 adapter 字典外键允许任意外呼。

**2. 应用与部署边界**

在当前 web 应用内实现 Admin，使用同一个 Next.js/Vercel 部署、Supabase Auth 和数据库。中文入口为 /zh/admin，英文入口为 /en/admin，管理 API 为 /api/admin/...。这里的 admin-web 是功能模块名称，不新增根目录 app、部署项目或管理子域名。

| 模块 | 职责 | 导入边界 |
| --- | --- | --- |
| web/src/features/admin | 管理页面、导航、表单、看板、客户端登录衔接 | 只消费安全 DTO 与管理 API，不导入 server 模块 |
| web/src/server/admin | requireAdmin、查询、mutation、审计读回、运行时验证 | server-only；管理写入使用当前用户 JWT 的请求级 Supabase client，服务端检查复用 AI resolver |
| web/src/lib/admin | 纯 DTO、表单 schema、错误契约 | 无 env 读取、数据库客户端或 Provider 调用 |
| web/src/app 下生成的 Admin 入口 | locale layout/page 与 /api/admin route 薄包装 | 由统一 server/static 路由清单管理 |
| supabase | 配置版本、管理员、操作记录、分析聚合与窄权限 RPC | 继续使用现有迁移目录 |

Admin 继承现有 RootLayout 和 LocaleLayout，复用字体、全局样式、ThemeProvider、NextIntlClientProvider 与 QueryProvider。新增 AdminShell 负责管理导航、环境标识、顶栏、内容滚动与表格空间，不挂载 CvBuilder、编辑/预览 Workspace 或带简历同步行为的 CvToolbar。按钮、表单、对话框和菜单继续复用现有 UI 组件及设计变量。

主题沿用全站 light/dark/system 偏好，Admin 顶栏复用 ThemeToggle，不增加管理员专属主题配置。新增表格、图表、状态色与焦点样式需要在明暗模式分别检查；复用 provider 并不自动完成图表配色适配。

语言沿用 /zh 与 /en 的现有机制，建议随每个 Admin 页面提供两种文案并复用 LocaleSwitcher。中英文不是权限或运行正确性的前置条件，但已有基础设施使保留切换成本可控。翻译导航、字段说明、错误提示和操作确认；model ID、环境变量名和审计技术标识保持原值。Admin 专用消息只在 Admin 入口加载，避免进入公共静态页面的消息包。

语言切换需保留当前管理子页面、必要的筛选/分页参数，并遵守表单的未保存修改保护。当前 LocaleSwitcher 只替换 pathname，扩展复用时要验证查询参数与草稿行为。主题切换直接复用现有偏好，不重置表单。

当前 run-next-mode.mjs 仅管理三个 polish API 文件，需扩展成有明确所有权的服务端路由入口清单。实现代码放在 app 路由树之外；server 构建生成全部 Admin page/layout/API 薄包装，static 构建在 next build 之前移除这些已标记入口。只管理清单中带 sentinel 的生成文件，发现同路径手写文件或未登记的 Admin 入口时失败，不递归删除业务源码。

CI 同时验证 server → static → server 切换：server 中 Admin 可用；static route manifest、导出 HTML 和 JS 中没有 Admin 页面、API、管理客户端或服务凭据。公共导航对 Admin 的引用也要经过静态构建边界处理。隐藏菜单不能替代构建隔离。

Next.js 静态导出不支持依赖请求的 Route Handler、Cookies 和 Server Actions，因此这些能力只进入 server 路由树。同一代码库保留静态和 server 两种产物是可行的，关键是显式管理入口。[Next.js 官方说明](https://nextjs.org/docs/app/guides/static-exports)

Admin 复用当前应用的登录状态；页面登录引导与 API 授权分开，页面壳和菜单不能承载敏感数据或替代服务端鉴权。沿用现有 Bearer API 模式，由每个请求携带用户 token；服务器 auth.getUser 验证后，使用同一用户 JWT 调用管理 RPC，不把用户身份转换为 service_role 加任意 actor 参数。如果以后采用 cookie 会话，则同时加入对应的 CSRF 防护。

Preview 部署内 Admin 固定操作 Preview Supabase；Production 固定操作 Production。浏览器请求不得指定任意 Supabase URL、目标环境或凭据。部署配置与 DB 环境标识核对失败时拒绝操作。环境名称在导航和发布确认中持续显示，界面不提供跨环境写入切换。

管理响应使用 private/no-store；查询和写入分别限流、设超时并限制数据量。当前根 layout 全局挂载 Analytics/SpeedInsights，增加 Admin 时要限制管理页面的第三方遥测，尤其不能让用户标识、配置和操作参数进入 URL 或分析事件。

单一部署共享应用故障与数据库负载，现有数据面仍使用服务端 service_role。管理写入不依赖该角色冒充用户；通过用户 JWT、窄 RPC 和有界查询控制权限。只有以后出现独立发布团队、明显负载差异或必须隔离部署凭据的需求时，再评估拆分应用。

**3. 管理员身份与用户管理**

首期只有一个 admin 角色，首位和后续管理员具有相同权限。

拟新增 admin_memberships，核心字段为 user_id、role、granted_at、granted_by、revoked_at、revoked_by。user_id 关联 auth.users；成员表本身不向普通登录用户开放 DML。审计独立追加保存，避免反复授权覆盖历史。

1. 首位管理员只能由数据库 operator 手动执行引导事务添加。需要绑定已经存在的用户 UUID，并记录 db_operator 类型的初始化审计，不伪造已登录管理员身份。Web 和普通 service_role 路径都不能创建首位管理员。
2. 已有管理员通过用户管理页面查找注册用户，授予或撤销 admin。首期不提供任意用户删除、密码修改、代登录或批量数据导出。
3. 每个管理请求先验证登录身份，再查询当前有效成员关系。继续采用现有服务端 auth.getUser(token) 方式；JWT 中的角色可以用于 UI 提示，但不是即时权限权威。user_metadata 不参与授权。[Supabase getUser](https://supabase.com/docs/reference/javascript/auth-getuser)、[用户元数据安全说明](https://supabase.com/docs/guides/auth/users)
4. Web mutation 的 actor 在最外层 SECURITY DEFINER 管理 RPC 中由 auth.uid() 取得，必须非空；不能从表单或 service_role 传入的 UUID 取得。RPC 锁定并重查操作者有效成员关系，再执行业务变更。普通用户直接调用该 RPC 也必须被 DB 拒绝，不能把 /api/admin 的存在作为权限边界。
5. 管理员变更使用同一 DB 锁串行化，覆盖操作者重新校验、目标变更、剩余管理员检查和审计写入。撤销权限及相关用户删除不得使有效管理员数降为零。用户外键采用阻止意外删除的语义；以后引入用户停用或删除能力时纳入同一规则。
6. 撤权提交后的新授权检查拒绝该成员。与撤权并发的写入通过事务锁确定先后；已经提交的合法操作不自动撤销。

用户管理页可以为识别目标展示必要的 email、注册时间和管理员状态，分页并限制搜索频率。Analytics 不返回用户目录；不能把“分析不展示 email”扩展成“用户管理也无法识别用户”。

管理员身份与 AI 使用资格分开：现有 AI allowlist 控制谁能调用 AI，不授予 Admin 权限；授予 admin 也不自动改变普通 AI 调用资格。首期用户页只管理账号查询和 admin 成员关系。AI allowlist、逐用户停用、逐用户配额调整后续增加，现有执行规则继续保留。

能力检查集中到 requireAdmin / assertAdminCapability。第一版 admin 拥有全部已开放管理能力，将来再添加 viewer/operator 等角色及映射，无需提前实现多角色界面。

P0 冻结“有效管理员”的完整定义，包括 membership 撤权、Auth 账户禁用与可登录状态，以及密码/GitHub 登录各自可验证的近期重新认证证据。高风险 RPC 在 DB 内验证该证据对 actor、操作和有效期的绑定；不能仅凭 API 传入 reauthenticated=true。首次 bootstrap 与 DB-owner 应急操作是明确的 operator 来源，不伪造 auth.uid()。

**4. Provider 连接配置模型**

Provider 与 Profile 分成独立管理页面。Provider 表示 API 服务商/接入方，Profile 表示使用该接入方的一份模型执行配置；一个 Provider 可以关联多个 Profile 和版本。当前 schema 只有 ai_provider_profiles，没有独立 Provider 目录；本阶段需要增加受控目录及显式关联，具体关联方式在 P0 冻结并兼容既有不可变记录。

Provider 页面管理稳定标识、管理显示名称、已支持的接入类型、创建 Profile 时使用的默认连接参数，并展示关联 Profiles、使用概况和操作记录。接入能力来自已实现的 adapter/runtime，不允许通过修改显示信息或创建目录项扩张执行能力。管理显示名称不改变法律披露中的主体身份。

默认 endpoint 和默认 credential_env_name 按适用的 adapter/wire 配置，仅用于新建 Profile 草稿时预填。保存草稿时解析并复制为 profile version 的完整、不可变执行字段，随后单独校验。修改 Provider 默认值只影响后续新建草稿，不自动改变已保存的 draft、active profile 或进行中的请求。需要让已有 Profile 使用新默认值时显式创建后继版本并展示差异；runtime 不在每次请求时回读可变默认值。

拟新增 ai_adapter_catalog 字典表，最小字段为 id、display_name、wire_api_kind 和 deprecated_at。id 使用稳定字符串，例如 deepseek_chat_v1、mimo_responses_v1，不使用跨环境可能不同的自增编号。沿用现有 profile version 的 adapter_kind 列，增加指向 catalog.id 的外键即可，不为命名一致额外重命名历史列。该表由 migration 维护，Admin 只读，不能在页面中创建 adapter 或修改其执行语义。不增加另一套 PostgreSQL 原生 enum。

代码 registry 继续负责按 id 选择实现、校验 adapter config 和声明 wire/能力；DB 目录负责可查询的选项与引用完整性。Admin API 将目录与本部署代码支持的 id、wire 和 schema 兼容性求交后返回 select 选项；未知或不匹配项不可选，并显示“当前部署不支持”。提交和实际执行时重新检查，不能只依赖下拉框或外键。wire_api_kind 从选定 adapter 推导并在服务端/DB 验证一致性，不让用户独立选择出矛盾组合。表单所需的配置字段定义来自对应受信 schema，不允许 DB 定义可执行代码或任意 header。

新增 adapter 的同一变更包含实现、测试、catalog migration，以及实际涉及的 wire/gateway/schema/契约扩展。迁移可先添加目录项，旧部署仍拒绝不支持的 id；新配置的启用必须等待目标执行部署支持。CI 核对新增目录与代码声明的匹配，兼容迁移先行、滚动部署及回滚期间的目录超集。已被历史版本引用的 id 不删除、不重用；不兼容语义创建新 id。deprecated 只阻止新选择/新启用，不隐式停止已有合法请求与重试。

当前代码除了 adapter，还固定了 profileKey、modelId、capability、cache、calculator、legal/disclosure 及 runtime target。v2 需要将“逐 profile/model 常量匹配”改为对 DB 不可变配置与已支持能力的组合验证，并同步请求构造、响应/usage 解析、价格计算、模型观察、披露与 runtime/legal target 的生产者和消费者。model_id 是有长度和字符约束的文本，按原值传给 Provider，不枚举已有两个模型；但新模型仍须满足所选 adapter 的参数、输出及计费语义并具备有效价格和接收方证据。不能只移除 registry 中一条 model 检查就宣称已支持配置化接入。

现有 deepseek_chat_v1 和 mimo_responses_v1 是 Provider 专用适配器，不保证可用于所有声称兼容相同 wire API 的服务。未来需要通用兼容接入时，再实现相应 adapter 并登记；仅在 catalog 增加名称不会产生这种能力。P0 明确哪些 legal/disclosure/runtime 证据可通过受控数据登记完成，哪些变化仍需契约发布；不能让已支持能力内的新模型仍因硬编码 profile/model 名称必须改代码，也不能绕过真实证据与用户披露要求。

拟在 ai_provider_profile_versions 扩展以下字段；最终 SQL 命名在契约阶段冻结：

| 字段 | 定义 |
| --- | --- |
| execution_config_schema_version | 区分旧 profile_execution_config_v1 与新 v2 投影 |
| endpoint_url | 完整、规范化的 HTTPS 请求地址；v2 必填 |
| credential_env_name | 完整的 AI secret 环境变量名；v2 必填 |

旧 v1 行保留原始 aliases 和解释方式，新列在兼容路径中允许为空。v2 使用新字段，其 alias 列约束按 schema 分支处理；不得让两套字段在同一个版本里同时成为执行权威。缺失或错误的 v2 配置直接失败，不回退到 v1 alias。

profile 表中的 config_sha256 继续只表示现有 adapter config：先按固定规则规范化 JSON，再计算 SHA-256。当前 seed/fixture 会核对其内容，基础 DB CHECK 校验十六进制格式；实际执行快照不包含它，runtime 通过 schema/registry 逐字段校验。routing policy 表也有同名字段，但摘要范围是该 policy 自己的配置，两者不能混用。

第一版不新增 execution_sha256。新增 endpoint、credential_env_name 等字段纳入完整的不可变 profile version；同一 environment 内的 profile_version_id 已唯一确定这些字段。创建/验证/发布仍执行完整 schema、地址、secret 用途和 runtime/legal 覆盖校验；reservation 固定版本 ID，retry 继承该版本。字段间一致性用独立 fixtures 与逐字段比较验证。

原提议的 execution_sha256 是把完整执行配置做成额外内容摘要，适合将来需要跨环境比对、导入导出校验或外部验证报告绑定精确内容的场景。当前单一 Web/DB 架构下，没有明确消费者需要该独立字段，因此延后。未来引入时明确它的规范化规则、计算方、验证方和失败行为；不能把 hash 当作签名、权限证明或 secret 安全检查。

价格继续保留独立版本与 hash。新 profile version 需要创建归属该版本的 price 记录，复用已验证的价格事实时仍要满足 profile 外键、有效期和 sealing 规则；不能把旧 profile 的 price ID 直接接到新版本。

请求在 reservation 时固定不可变 profile version 引用；attempt 与 retry 继承它。客户端 expected-route DTO 只包含所需的版本身份，不返回密钥、credential_env_name 或完整执行配置。只有服务端执行投影与受保护的管理投影可包含连接元数据。

**5. Secret 与目标地址解析**

新配置使用专用命名空间，例如 AI_PROVIDER_KEY_DEEPSEEK_PRIMARY、AI_PROVIDER_KEY_MIMO_PRIMARY。credential_env_name 必须通过严格的大写 ASCII 命名规则与长度检查。运行时先从部署环境构造专用 secret map；DB 字符串只查询这个 map，不索引完整 process.env。

每个 secret 还需要部署侧受信的非敏感用途声明，例如允许的 gateway/数据接收方和精确目标 origin。通用 resolver 核对“环境变量名、secret 用途、profile gateway/adapter/wire、获准接收方”后才交给 adapter。该声明管理 key 的允许用途，不选择实际路由；新增 key 名或获准地址通过部署配置登记，不增加 Provider 专属 URL/env 代码常量。用途声明具有可由实际部署报告的非敏感 revision，绑定验证报告与探测；它只表示规则版本，不是 key 的代次或 hash。仅能修改 DB 的操作者不能把已有 key 重新绑定到任意外部接收方。

Admin 只能编辑变量名称，显示 configured/missing/unavailable 及检查时间。真实 key、部分 key、key hash 都不进入 DB、浏览器、日志、validation report 或测试结果。新增或轮换 key 继续在对应 Web 部署环境完成，是否需要重新部署依部署平台当前机制执行。

第一版不新增 credential_generation。需要轮换追踪时，应由实际执行部署报告非敏感 binding revision，并在使用时记录 observed revision。它不是 key 的密码学证明，也不意味着历史请求会自动持有旧 key；当前版本冻结的是 credential 引用。

Endpoint 使用文本输入，DB 保存完整请求 URL，服务端采用通用规则校验，不再由代码 registry 给出两个固定 URL。实际地址必须匹配部署侧批准的精确 origin、所选 adapter/wire 的路径语义以及 legal/disclosure 与 runtime contract 中的接收方。拒绝 URL userinfo、query、fragment、IP literal、非 HTTPS、非批准端口、伪装后缀及不符合规范化规则的地址。保持 TLS 校验和 redirect: error。当前两家官方目标作为首批登记值；新域名需要独立完成接收方授权与适用的出站验证，不能因为字段可填写就自动启用。

第一版不增加 destination_policy_id。它原本表示一套地址安全规则的引用，例如允许的 host、端口、路径与 wire 协议。由 gateway_kind + adapter_kind + wire_api_kind 定位代码支持的通用规则，结合部署侧 secret 接收方范围与既有 runtime contract 验证实际 endpoint_url；扩大接收方或改变不兼容语义仍需相应证据或后继契约。将来同一组合需要多套独立版本化的地址规则时，再评估单独的策略引用。

建草稿时验证格式，验证报告检查契约，真正发请求前再次执行地址和 secret 用途校验。这样 DB 配置漂移或绕过 UI 写入不会直接变成任意外呼。

本期不自动增加 custom-compatible adapter 或允许任意公开 HTTPS 目标。若一个新填写地址涉及自建代理或其他可控 DNS 目标，在开放该目标之前，需要实现并验证 DNS A/AAAA 与实际连接绑定，或使用受控出站代理，覆盖解析时序变化、私网/链路本地地址和重定向。不能把一次 DNS 查询后再普通 fetch 当作完整防护。P0 对目标地址范围和连接实现作具体决定，未实现防护的目标在验证时明确拒绝。

**6. Admin 如何取得运行状态**

Admin API 与 AI 执行属于同一 Web 部署，直接复用同一个服务端 secret resolver 和执行配置校验函数，不新增跨应用鉴权、token 转发或管理到 Web 的 HTTP 探测服务。

状态 API 接受 profile version ID 等已定义身份，验证管理员权限后读取 DB 中的版本，并从当前部署的实际 resolver 获取 schema 支持、运行时版本、部署/API gate、credential 是否存在和检查时间。客户端不能传入任意 URL、header、prompt 或 env 查询。共享的是准备与校验函数，不为一次状态读取启动 AI handler 或调用 Provider。

secret 状态绑定实际处理查询的 deployment/build identity；滚动部署期间一次 configured 不能证明所有旧实例都已经更新。发布新配置仍需通过目标部署身份和兼容性检查。查询失败显示 unavailable，不能将其解释成 missing，更不能据此自动切换路由。

纯 schema/secret-presence 检查不调用 Provider，随 P4a 的静态 validation 交付。有成本的 synthetic probe 单列 P4b，仍在本方案范围内，不能用直接 fetch 实现成静态检查的副作用。P4a 草稿管理与 P5 发布不依赖 P4b 已上线；P4b 未完成时不显示可执行的付费测试入口，也不展示不存在的测试分类数据。

P4b 采用专用 probe parent 与 probe attempt 记录，复用纯 adapter/usage/cost 逻辑，保留现有产品 request/attempt 外键。parent 固定 purpose=synthetic_validation、管理员 actor、候选 profile/price/runtime/legal 版本、环境/部署、secret/destination 规则 revision、固定 fixture 版本、幂等 key 和限额。拒绝真实简历与自由 prompt。DB 使用独立 probe admission 校验候选的格式、运行兼容性、价格与接收方证据，允许符合探测条件但尚未被 active policy 选择的版本；不把它伪装成普通用户 reservation，不临时切换 pointer。该资格只允许固定测试内容，不授予用户数据路由资格。

调用前先提交 durable reservation，再通过原子 start 领取一次性发送资格；同一 probe 默认最多一次 transmission，无自动重试或跨 Provider fallback。只有首次成功领取者可发送，重放 API 只查询结果或继续结算，不再次获得发送资格。网络请求在 DB 事务之外。已记录 started 不等于已证明 transmitted；进程在 start 后、发送前或响应后崩溃均可能留下 unknown，由 stale reconciler 保守收口，不据此重发或认定零费用。结算记录取消/超时、transmission、billability、usage、成本和 route observation，只有充分响应事实才标记对应成功与完整度。

Probe 使用同一 deployment API gate 和 DB runtime kill switch，并设置独立 admin/probe 限额和 token/timeout 上限。全局 Provider 调用限额覆盖产品与 probe 的实际发送资格，由两条 start 路径在同一 DB 计数/锁规则下原子扣占；产品的用户配额和成功率不计入 probe。P0 冻结 reservation/start/settlement/reconciliation 的锁序与未知发送计数规则，P4b 必须验收后才开放。Probe 终态元数据沿用 90 天保留窗口；未结算记录先 reconciliation，不直接按时间丢弃。

首期 Web probe 定位为诊断和兼容性证据，不新增“每个 clone 都必须付费测试”的激活硬门槛。发布仍须满足该候选实际需要的代码/外部事实、runtime/legal、价格及已审核集成验证要求；可以引用既有合格 operator evidence，不能把 schema 检查冒充模型兼容验证，也不能由一次绿色 probe 替代用户 auth、terms、quota、reservation 与普通 settlement 的集成证明。没有足够证据的新 endpoint/model/adapter 组合继续阻塞发布。

P4b 上线前同时完成 probe 聚合投影：测试费用进入总成本，产品用户请求量/成功率默认排除测试，费用视图分别显示用户/测试及合计；unknown usage/billability 不补零。Probe 的 start/terminal 是它自己的多阶段事实，与下一节同步 DB mutation 的 committed-result 幂等语义分开。

这些管理端点与 Admin 自身由独立管理开关控制，不依赖 AI_POLISH_ENABLED=true。AI 关闭时管理员仍能检查和停用服务；管理开关关闭时拒绝管理写入。普通 AI 三条 API 继续遵守原有关闭行为。

**7. 管理写入与验证报告**

首期提供明确业务操作：维护受支持的 Provider 目录与新建默认值、clone profile version、create price version、create routing policy、validate、canary、activate、set pointer、retire、调整配额及启停 DB runtime gate。新增创建操作使用窄权限 RPC，保留现有表级 DML 撤销规则。Provider 默认值修改也执行预期 revision 比较及审计，避免多人编辑覆盖。

管理 mutation 的唯一应用入口链为：用户 Bearer → /api/admin 校验与受控 DTO → 同一 JWT 的 SECURITY DEFINER Admin RPC → auth.uid() 与锁定成员检查 → 目标/状态/报告校验 → owner-only lifecycle implementation → 提交变更与审计。函数固定安全 search_path、限定执行授权；普通 authenticated 只获得带完整鉴权的外层 RPC，不能执行内部实现。直接调用外层 RPC 也执行环境、membership、step-up、证据及并发约束，服务端路由不是唯一检查点。[Supabase 函数安全说明](https://supabase.com/docs/guides/database/functions)

在首个管理写功能开放前，用后继 migration 撤销旧 DB-013 operator RPC 对应用 service_role 的 execute，以及 ai_feature_config 三个运行控制列的直接 UPDATE。旧函数可保留名称供 owner-only 内部调用；不新建应用 admin_owner 角色。启停与全局 quota 使用窄 RPC；allowlist 的 Web 编辑继续后置。该权限收口需同步修订 operator runbook/CLI，明确旧 service_role 配方停止使用。reserve/start/complete/finalize/reconcile 等数据面权限保持可用，既有 security-invoker guard 所需的受限行锁权限单独验证，不能盲目撤权或把 guard 改为宽权限执行来掩盖回归。

保留 DB-owner 手工 bootstrap、证据登记与 break-glass 停用。应用不可用时，owner 可通过单向 disable 路径关闭 DB gate，记录 db_operator/break_glass 来源、原因和审计；不冒充 Web 管理员，也不把该应急路径用于重新开启或扩大权限。若故障使同事务审计不可用，外部操作记录及恢复后的关联补记须明确区分，不能伪造原事务审计。owner 的受控应急能力不恢复给应用 service_role。

表单编辑期间可以反复修改，只有点击“创建版本”并成功提交后才插入不可变 draft 记录；首期不做自动保存到版本表，也不增加可变工作区草稿表。已经创建的 draft 再修改时复制到表单，下一次提交创建后继版本。Provider 默认值在打开表单时预填，提交前显示最终完整值，不能悄悄换用期间更新的默认值。编辑完成和发布是两个独立步骤。

普通同步 DB mutation 采用 committed-result 幂等表，唯一键为 actor、operation_kind、idempotency_key，保存 payload_hash、committed_result 和 domain_audit_id。actor 由 DB 的 auth.uid() 确定；环境、目标与 reason 纳入标准化 payload。幂等记录、领域变更和领域审计在同一事务提交，不构建通用 command bus，也不承诺这类 mutation 有可观察的 durable pending。

相同 key 已有已提交结果且 payload 相同，重新检查当前访问权限后返回原结果；payload 不同则拒绝。并发首次提交通过唯一约束/锁确定执行者；另一个事务等待并读回已提交结果，若前一事务回滚则可重新执行。幂等命中在当前权限检查后、目标 expected-state 检查前返回，否则成功提交后的重试会被自己造成的 generation 变化误拒绝。客户端在结果不确定期间保持原 key 与原 payload，修改内容必须使用新 key；发生完整回滚且没有登记记录时，不声称 DB 仍记得该次尝试的 payload。

普通业务拒绝和基础设施错误不承诺 durable failed 记录。事务回滚后没有 committed operation；可另行记录脱敏诊断，但不伪造领域 audit。HTTP timeout/响应丢失显示“结果未知”，客户端按事先持有的 key 查询，已存在结果则恢复，不存在只表示当前没有可证明的提交结果；原事务可能仍在执行，同 key 重试仍受唯一约束/锁保护。operation UUID 在提交结果中返回，用于后续关联。所有已提交的幂等结果与其领域审计一起保留，MVP 不提前 TTL 清理，避免旧 key 重放重新执行。

涉及 active pointer、quota 或共享配置时，提交 expected configuration generation / expected state，并在锁定后比较，防止两个浏览器用旧页面相互覆盖。管理锁与现有 config→policy→runtime→profile→price 顺序一并审查，避免新增反向锁序。

验证报告绑定 environment、不可变 profile/policy/price version ID、执行 schema、runtime/legal contract、部署版本、相关配置 generation、检查时间及期限。配置字段变更产生新版本 ID；部署变化、generation 漂移、证据到期或 secret 用途改变后，相关报告失效并重新验证。报告引用的可变外部事实必须在发布前复查，不能仅凭 profile ID 推断它们仍然有效。

现有 reviewed source OID/hash 是审计证据字段，runtime ID 是另一种执行身份。Web 表单不能填写任意 hash 来表示“已审核”，服务端也不能只 hash 一份配置就声称代码、外部价格或法律事实已通过审核。发布 API 消费已经登记的构建证据、受审契约和有来源的复核报告，执行现有 profile/price/legal 校验；缺少报告的操作显示具体阻塞项。

P0 冻结两类实际 producer：受信 migration/DB operator 登记已审核的 build/source、runtime/legal 与外部事实证据；本部署的受信 validation service 运行真实检查后，通过仅向该服务开放的窄记录 RPC 创建不可变报告，probe 报告必须关联已结算的 probe。普通 Admin mutation 只提交 report/evidence ID，不能创建或覆盖成功报告、传入任意审核 hash。内部 lifecycle 需要的旧 hash 参数由 DB 从批准记录读取。

发布事务锁定候选与报告，验证 candidate/version、environment、deployment/build、runtime/legal、secret/destination policy revision、配置状态及有效期的精确绑定，并消费相应证据。服务端实时校验与 DB 可验证事实各有明确来源；DB 不凭空声称已读取部署 env。用途规则或部署变化须使旧报告不再可发布，具体通知/复核机制属于 P0 的必交付契约。报告是验证服务的检查证据，不是独立的 secret 或任意外部事实签名；该可信服务不能自行登记新的 code/legal 审核权威。

成功发布返回 operation ID 和 lifecycle audit UUID，并读回有效配置与实际路由。读回超时显示“操作结果待确认”，通过同一 operation 查询恢复，不把 HTTP 200 或前端 toast 作为最终状态。

**8. 启停、发布与回退交互**

准备顺序为：创建后继草稿 → 验证并查看阻塞项 → 确认目标环境和版本差异 → 按现有生命周期准备可用的 profile/price/policy。canary 仅表示生命周期资格，不自动分配百分比或限定用户群；pointer 指向 canary policy 后，实际流量仍由全部 policy rules 与现有 allowlist 决定。UI 展示真实覆盖范围，不使用未经实现的“小流量”或“灰度百分比”承诺。

第一版 pointer set/clear 与 rollback 沿用现有 gate-off 发布边界：先以独立、带审计 mutation 关闭 DB runtime gate并读回 → 在 DB 锁内确认仍关闭且 expected pointer/generation 一致 → 执行 pointer mutation → 读回 operation、audit、generation、policy 与实际 route → 管理员单独确认重新开启。改变 pointer 或回退不自动开启服务，失败/超时保持关闭并按 operation key 恢复。[现有 runbook](/D:/code/typst-cv-template/docs/ai-provider-operations.md:168)

gate 的重新开启由独立高风险 RPC 处理，要求近期重新认证、最新合格 validation，以及绑定最新 pointer/generation 和关闭周期的受信 readback 记录；不能由浏览器传 readback_ok=true。门控/配额变更需要自身 revision，不能把只反映 pointer 的旧 config_generation 当作全部控制变更计数。P0 冻结 generation/revision、读回记录及并发 reopen 的事务条件，保证读回期间不会被其他旧页面提前开启。DB gate 关闭时用允许管理读取的 route projection 检查目标，不依赖只在 AI 开启时可用的普通 API。第一版不承诺零停机 live switch；未来需要时作为独立操作契约讨论。

Profile、Price、Routing 保留各自的列表、编辑与发布操作。页面间提供依赖链接、状态和阻塞项，不要求用一个统一向导才能管理这些对象；如以后需要汇总发布检查，可复用已有校验与确认组件，不增加独立发布实体。

保留三层开关：浏览器 build flag、Web deployment API gate、DB runtime gate。Admin 读取前两层状态，页面内主要操作第三层；DB 开关不能打开被部署 gate 关闭的 API。

紧急停用 DB runtime gate 应快速、幂等、可审计，不依赖价格新鲜度、Provider 可用性或新 validation report。重新启用、扩大配额、授予管理员和 Production 发布要求清晰确认及近期重新认证；token refresh 不能冒充重新认证。具体认证机制在 Admin auth 实现时依据现有登录方式冻结并验收。

Kill switch 阻止后续 admission/start，不承诺撤回已经发送给 Provider 的请求。旧请求按照既有取消与结算规则完成。UI 显示这一实际生效范围。

回退是切到仍然有效、被当前 runtime 支持且价格/法律证据合格的已有 policy，保留全部历史。过期、retired、历史明确禁用的 policy 不能作为回退候选。

**9. 页面与指标范围**

侧栏采用两级结构，一级入口为 Overview、Users、AI 管理、Analytics、Audit。AI 管理和 Analytics 为可折叠分组；进入子页面时保持所属分组展开。实体详情、版本和操作记录使用页面内 tabs 与面包屑，不继续增加侧栏第三层。

| 一级入口 | 二级页面 | 第一版范围 |
| --- | --- | --- |
| Overview | — | 全局摘要：当前环境、三个 AI gate、active policy、当前路由、credential 检查状态、关键指标、异常和最近操作；提供配置、分析及紧急停用的快捷入口 |
| Users | — | 注册用户查询、管理员列表、授予/撤销权限、相关审计 |
| AI 管理 | Providers | API 接入方目录、管理显示信息、新建 Profile 的默认连接参数、关联 Profiles、使用概况和操作记录 |
| AI 管理 | Profiles | 所属 Provider、模型/adapter、不可变版本、实际连接配置、clone draft、价格/路由引用、验证报告 |
| AI 管理 | Pricing | 归属 profile 的价格、币种、components、有效期、来源与 sealing 状态；legal/runtime coverage 以只读验证状态呈现 |
| AI 管理 | Routing Policies | policy 列表、时区与时间窗口、指定时间模拟、发布差异、active pointer、合格回退候选 |
| AI 管理 | Runtime Controls | DB runtime 开关、全局调用配额及现有 allowlist 状态，明确生效范围；白名单和逐用户控制的编辑界面后续再做 |
| Analytics | AI Usage | request/attempt 数、Provider/Profile 使用分布、token/cache 用量及时间趋势 |
| Analytics | Costs | 分币种费用、估算与 Provider 报告值、按 Provider/Profile 归因、用量完整度与对账差异 |
| Analytics | Performance | 延迟分布、成功/失败/取消、重试、已持久化的 transmission/settlement 异常和元数据诊断入口 |
| Audit | — | 全局操作查询；按模块、对象、操作者、时间与结果筛选，统一列表与只读详情 |

路由沿用 locale 前缀，例如 /zh/admin、/zh/admin/users、/zh/admin/ai/providers、/zh/admin/ai/profiles、/zh/admin/ai/pricing、/zh/admin/ai/routing-policies、/zh/admin/ai/controls、/zh/admin/analytics/usage、/zh/admin/analytics/costs、/zh/admin/analytics/performance、/zh/admin/audit。英文使用对应 /en 前缀。分组本身不额外增加与 Overview 重复的首页。

AI 管理集中配置与发布操作；Analytics 集中只读数据观察。各分析子页面共享日期、时区及 Provider/Profile 筛选控件和统计契约，并在适用的页面切换时保留筛选。Overview 展示精简摘要并跳到对应详情，不重复完整配置表单或分析报表。Audit 的事件类型使用筛选器，保持单一全局入口。

未来 Analytics 可增加用户增长、编辑/导出行为、转化与留存等子页面。只有对应数据采集、统计口径和页面达到可用状态才加入菜单，第一版不显示没有数据来源的占位入口。Performance 只表示可观测的性能与稳定性，不把响应成功或输出格式合法宣称为简历内容质量评估。

页面可以先按导航分组逐步开放，不要求首个交付包含全部写入功能。adapter 使用目录与当前部署支持集合校验后的 select；endpoint、credential_env_name 和 model_id 使用文本输入并展示对应验证结果。UI 不提供任意 header、原始 SQL 或法律/runtime hash 编辑器。

审计采用“全局 Audit 页面 + 对象详情页操作记录”的双入口。Provider、Profile、Price、Routing policy 和用户详情页嵌入同一审计列表，并固定对应对象过滤条件；全局页支持跨对象排查。它们共享查询 API、分页、权限和详情组件，不维护两份审计记录。跨对象操作用 operation ID 关联，来源审计 ID 保持可追溯。

Audit 列表采用固定列：时间、操作者、模块、操作、对象、结果和变更摘要。点击后打开统一只读详情抽屉，公共区域展示环境、目标稳定 ID、操作原因、operation/audit ID 和时间。详情页面不复用业务编辑表单，不提供在审计记录上修改历史的能力。

变化内容使用少量按事件类型选择的展示组件：普通字段显示“字段 / 旧值 / 新值”，管理员授权显示角色变化，价格显示 components 差异表，routing 显示默认路由和时间窗口差异，发布操作显示状态或 active pointer 的变化。详情外框、导航、样式与公共元数据保持一致，不为每个功能另建完整 layout。

查询层提供带 schema version、事件类型、来源 ID 和批准字段的统一审计投影；现有 ai_routing_lifecycle_audit 保留其结构约束，新用户授权、Provider 默认值等操作增加各自明确的审计形状。前端不依据任意 JSON 动态生成表单，也不直接展示原始请求 payload。未知事件类型仍展示已批准公共元数据及不支持的详情提示，不回退为原始 JSON dump。

成功业务变更由领域审计和 committed operation 证明；普通同步 mutation 的“处理中/结果未知”属于客户端恢复状态，不承诺在 Audit 中出现 durable pending/failed。Probe 的 durable started/terminal 是独立执行事实，可在对应详情关联展示。全局查询避免将一个 operation 与它的 audit 重复计数；查询不到 committed operation 不自动显示“未执行”或“已失败”。现有 lifecycle audit 通过窄、批准字段的管理读取 RPC 暴露，不为页面恢复 service_role 全表读取权限。

路由模拟使用与真实选择一致的纯选择器和 TS/SQL 共享 fixtures，显式输入时间及 Asia/Shanghai 等配置时区，不改系统时钟、DB 时钟或 active pointer。结果区分“规则匹配结果”和“当前具备执行资格”，不调用 Provider，也不宣称未来价格/secret 状态必然有效。

Analytics 以现有 ai_request_ledger、ai_provider_attempt_ledger 和 ai-metrics.mjs 的计算口径为起点。observability.ts 可复用 DTO 与拒绝敏感内容的边界，但当前模块不等于已接入、可查询的事件仓库。

首批指标包括 request/attempt 数与终态分布、各自成功率及明确分母、重试触发/成功、P50/P95 延迟、Provider 路由占比、token/cache 用量、按币种成本、已知费用与用量完整度、结算异常和持久化 transmission 状态。未知 transmission 不推断成已发送，unknown usage 不计成零成本，不将 request 与 attempt 费用相加。

global_daily_limit 表示全局 Provider 调用配额，UI 使用“次/日”；金额图表独立呈现。统计日期注明时区，quota 的 UTC 计数周期与路由的 Asia/Shanghai 时间窗口分别显示。

quota/rate-limit 拒绝、完整访问漏斗、编辑/导出转化及留存没有同等完整的数据来源，另行增加 content-free 事件或计数后上线，不从现有 ledger 伪造历史。新增采集需要明确去重、保留期、完整性和可观测失败处理。

管理 API 只返回批准字段和聚合结果。第一版默认近 7 天、单次最多 31 天，分页或 DB 聚合并限制执行时间；复用计算逻辑，不让每个看板请求都拉全表或把所有 ledger 传到浏览器。量增大后再增加按日聚合及迟到结算修正。

Admin 沿用现有 DB retention，不因增加 UI 改变历史保留期，也不为看板复制一份永久明细。当前 cleanup_ai_polish_metadata 按 finalized_at 删除超过 90 天的 finalized request，并级联删除 attempts；按 UTC day 清理超过 90 天的用户/全局/Profile 日汇总；分钟限流桶保留 2 天。未完成请求不由这条 90 天规则直接删除，应按既有 reconciliation 处理。这里核实的是本地迁移定义，未核对线上 cron 是否安装、运行及最近结果。

90 天是数据库清理规则，不代表任意按 created_at 查询的 90 天区间都完整；迟到结算、建库时间、账号删除与实际清理执行都可能影响覆盖。分析返回查询范围与可得数据/完整性说明，对被清理的历史不补零。单次 31 天查询限制是性能约束，与 90 天保留期分开。现有 ai_routing_lifecycle_audit 为 append-only，未发现自动到期清理，不纳入请求 ledger 的 90 天删除。新增管理审计延续追加保留，不擅自为旧审计添加 TTL；将来要修改保留策略另行设计。

按 request ID 的诊断只展示脱敏元数据时间线。prompt、简历正文、模型输出、原始 Provider 错误、真实密钥和原始上游 request ID 不进入管理分析。Endpoint 与 credential 名称仅在有权限的配置页面及对应配置审计详情中展示，不进入通用 Analytics。审计变化字段采用允许列表，真实 secret 始终不存储或返回。

**10. 分阶段集成与验收**

以下为方案阶段编号，不复用已有多 Provider 计划的任务 ID。

| 阶段 | 依赖 | 交付 | 主要验收 |
| --- | --- | --- | --- |
| P0 契约与边界冻结 | 当前 main | Provider/adapter/v2 模型契约；JWT 唯一 mutation authority、证据 producer、committed-result 幂等；probe admission/结算；canary/gate-off 与 reopen；成员/step-up 和目标防护 | 不改变旧 ID/hash 含义；能力内新模型不依赖代码登记；所有 RPC/证据/读回/锁权限链闭合，局部 SQL 与失败测试有明确交付 |
| P1 Admin 基础与只读页面 | P0 | web 内 Admin 模块、server/static 入口管理、DB 手动 bootstrap、服务端鉴权、Overview/配置/审计只读查询 | 普通用户/伪造角色/错误环境均拒绝；无 bootstrap Web 入口；三次构建切换与静态/Admin 客户端产物检查通过 |
| P2 连接配置 v2 | P0、P1 身份边界 | adapter catalog/FK、additive schema、双版本读路径、配置化 model 验证、受限 secret map、地址验证、同部署能力检查 | v1 请求/重试不变；错误 v2 零外呼；迁移先行时未知 adapter 不可用；兼容的新 model 无需新增 profile/model 常量；未切 active pointer |
| P3 Users 与 Analytics | P1，可与 P2 分开实现 | 管理员授予/撤销、JWT 管理 RPC 与 committed-result 基础、旧 operator 权限收口、聚合指标和有界诊断 | 首位不可 Web 创建；旧 service_role 不能绕过管理链；数据面不回归；最后管理员竞态、撤权和超时幂等通过 |
| P4a 配置草稿与静态验证 | P2，复用 P3 的管理 RPC/幂等基础（不依赖完整 Analytics） | Provider 默认值、clone version、price/policy 创建、不可变验证报告与证据引用、路由模拟 | 默认值不改变已存版本；执行字段不能 UPDATE；报告精确绑定且不可由 Admin 伪造；无 Provider 调用 |
| P4b 付费 synthetic probe | P2、P4a，以及 P3 的统计投影基础 | 独立 probe parent/attempt、单次发送资格、共享全局限额、结算/unknown/reconciliation/retention、测试成本投影 | 不伪造用户 request 或切 pointer；重复/崩溃不重发；全局限额不超发；费用计入总额且用户成功率不受污染；未验收不开放入口 |
| P5 受控发布与运行操作 | P3、P4a；不要求 Web probe 已上线 | canary/activate/pointer、回退、DB gate、全局调用配额、审计读回；白名单及逐用户控制编辑后置 | gate-off/readback/reopen 顺序与 DB 约束一致；旧页面不能提前开启；所需兼容/集成证据齐全，不能以缺少 probe 功能跳过验证 |
| P6 兼容路径整理 | P5 稳定运行且保留期明确 | 后续独立评估旧 aliases 与旧解析分支 | 历史查询与合法 in-flight/retry 不受影响；不自动删除历史版本或证据 |

建议主线集成顺序为 P0 → P1 → P2 → P3 → P4a → P5；P4b 在依赖完成后独立交付，可在 P5 前后集成。P1 完成即可使用只读后台；P3 不需要等待配置发布能力完成。首个管理写功能开放前必须完成旧控制面授权收口及 operator runbook 更新，不能先叠加新 wrapper 后把旧入口遗留到 P5。每阶段独立、可审查地提交，避免把 DB 扩展、Runtime 切换与旧路径删除放在一次发布中。

P2 到 P5 的迁移采用以下固定顺序：

1. 发布兼容旧行的 additive migration，保持现有 active policy 和执行不变。
2. 部署同时支持 v1/v2 的 Web runtime；在目标环境登记新命名空间的 key 与接收方用途。旧 v1 继续读取旧名字。
3. 创建新的 v2 profile、对应 price/policy 与必要的 runtime/legal 后继契约。旧 profile 不 UPDATE 回填，也不重写历史 ledger。
4. 用独立 fixtures 和验证报告对照旧/新目的地、adapter、model、接收方及 credential 用途。旧 env 名迁移到新命名空间需要显式部署映射和就绪检查；不比较或暴露实际 key 值，不发送两次用户请求。
5. 在获授权的 Preview 环境验证候选，确认仍服务请求的部署均能读取 v2；按第 8 节关闭 DB gate，由管理员显式选择新 policy，读回审计、generation 与路由后另行确认开启。
6. 回退先切回合格 policy，代码回退点保持 v1/v2 双读能力。仍有 v2 请求时不能直接回滚成只支持 v1 的代码。
7. Production 按相同顺序独立核对自己的部署、Supabase、key、契约和授权，不复制 Preview 的就绪结论。

**11. 必须覆盖的失败场景**

权限：未登录、普通用户、伪造 actor/user_metadata、跨环境 token、已撤权旧页面、越权直接 RPC、Web 首位创建、同时撤销最后两名管理员。

管理 authority：直接调用旧 operator RPC/控制列 UPDATE 被拒；外层 JWT RPC 不接受 actor/hash/reauth/readback 布尔值伪造；报告/evidence 的 producer 和引用权限分离；受限行锁与数据面 reserve/start/complete/reconcile 保持可用；DB-owner 应急停用有独立来源。

配置：旧 v1 行和历史请求可读；错 schema、缺 v2 字段、版本与字段不一致、跨 profile price、未覆盖 legal/runtime、别名与新字段混用、旧代码遇到新版本均按定义处理。

Adapter 与模型：目录新增而代码未部署、代码支持而目录缺失、wire/schema 不匹配、未知 id、已弃用项新建与历史执行的区别；已有 adapter 下兼容的新 model ID 不需要代码常量；模型参数、输出/usage 或计费语义不兼容时明确拒绝，不能通过填写名字伪造能力。

Provider 默认值：修改默认值不影响既有 draft/active 版本及 retry；新建草稿明确复制并验证完整连接字段；目录项与 Profile 关联保持一致；管理展示信息不能改变法律身份或扩张 runtime 能力。

外呼：非 AI env 名、错误 recipient scope、未授权 origin、伪造域名后缀、编码 URL、内网/IP、端口、query/userinfo、redirect 及尚未实现防护的自定义目标均拒绝；受支持且获准的新配置可用；被拒配置不得发生带 secret 或 CV 的网络请求。

并发与恢复：stale generation/revision、重复幂等 key、已登记同 key 不同 payload、提交后响应丢失、前一事务执行中/回滚后的重试、权限检查与幂等命中顺序、readback 暂时失败、报告过期，以及 reserve/retry 与 pointer/retirement 的交错。不存在记录不能推断失败；同步 mutation 不伪称有 durable pending。

发布：gate 开启时 pointer set/clear/rollback 被拒；关闭/切换/读回/再开启跨请求失败仍保持安全关闭；并发旧页面不能跨越最新关闭周期与 readback；canary 默认路由覆盖全部合格请求时 UI 如实显示，不能暗示百分比灰度。

Probe：未获发送资格、start 前后 crash、发送后响应丢失、取消/超时、结算重试、未知 usage/billability、共享配额竞态、过期候选和幂等重放；同 probe 不二次发送，未知不补零，stale recovery/retention 不丢失未结算事实，不污染产品用户配额与成功率。

运行：禁用 AI 后管理查询与紧急停用仍可工作；停用不伪称取消已经发送的调用；新旧 deployment 并存期间 v1/v2 行为一致。

构建与界面：server → static → server 切换无入口残留，未知手写入口不被生成器覆盖或删除；普通站点 bundle 不引入 Admin 服务端代码；静态产物无 Admin 路由与客户端模块；管理数据不进入全局第三方遥测。

布局与偏好：Admin 页面使用独立内容布局并继承公共 providers；明暗模式下表格/图表可读；中英页面词条完整；切换语言保持子页面和筛选且保护未保存草稿；切主题不改变表单内容。

导航：两级菜单的选中项、父分组展开和面包屑与当前路由一致；详情页不增加多层侧栏；Analytics 子页面共享适用筛选；尚未开放或没有数据来源的页面不出现可点击占位入口；Overview 的紧急停用操作复用同一权限与审计逻辑。

审计：全局页与对象页同一条件返回相同事件；跨对象操作可按 operation ID 关联；历史显示不依赖可变表单默认值；类型专属详情只展示批准字段；未知类型、失败和 pending 操作不会被误呈现为成功配置变更。

分析：request/attempt 不双计，币种不混加，unknown 不变零；测试计入真实成本但与用户成功率分开；迟到 settlement、retention 边界、历史缺失、分页、时区和限流拒绝缺失事实有明确表现；请求清理不删除配置审计。

执行这些验证时，普通 unit/DB/构建测试与任何真实 Provider 调用分开。P0 文档阶段不运行付费验证，也不执行迁移或线上操作。

**12. 当前代码依据**

- [固定 URL 与 credential 映射](/D:/code/typst-cv-template/web/src/server/polish/adapter-registry.ts:198)，以及 [profile 校验](/D:/code/typst-cv-template/web/src/server/polish/profile-registry.ts:137)。
- [不可变 profile version trigger](/D:/code/typst-cv-template/supabase/migrations/20260823230000_ai_provider_foundation_expand.sql:116)。
- [config_sha256 的既有定义](/D:/code/typst-cv-template/docs/ai-provider-contract.md:56)与[运行时身份定义](/D:/code/typst-cv-template/docs/ai-runtime-execution-contract.md:111)。
- [运行开关与 operator 流程](/D:/code/typst-cv-template/docs/ai-provider-operations.md:15)和[生命周期窄权限边界](/D:/code/typst-cv-template/supabase/migrations/20260824004000_add_ai_provider_operator_lifecycle.sql:131)。
- [双构建模式脚本](/D:/code/typst-cv-template/web/scripts/run-next-mode.mjs:1)。
- [现有持久化统计入口](/D:/code/typst-cv-template/web/scripts/ai-metrics.mjs:1)与[content-free 投影边界](/D:/code/typst-cv-template/web/src/server/polish/observability.ts:1)。
- [quota/rate-limit 拒绝先于 request 插入](/D:/code/typst-cv-template/supabase/migrations/20260823234000_reserve_ai_polish_v2.sql:420)。
- [现有 metadata retention](/D:/code/typst-cv-template/supabase/migrations/20260824001000_secure_reconcile_ai_provider_attempts.sql:322)与[append-only lifecycle audit](/D:/code/typst-cv-template/supabase/migrations/20260824004000_add_ai_provider_operator_lifecycle.sql:119)。
