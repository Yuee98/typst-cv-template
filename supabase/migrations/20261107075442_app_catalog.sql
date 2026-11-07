-- Explicit file transaction also protects CLI versions that execute statements separately.
begin;
-- Reviewed current code capabilities and legal content; no runtime credentials or active policy.
insert into ai.runtime_control (id)
  values (1);
insert into ai.capabilities (id, code, name, description, adapter_kind, wire_api_kind, execution_contract, calculator_kind, cache_policy, descriptor_digest)
  values (1, 'DEEPSEEK_CHAT', 'DEEPSEEK_CHAT', 'Current CV polish execution semantics', 'deepseek_chat_v1', 'chat_completions_v1', 'cv_polish_1', 'linear_token_v1', 'automatic', common.digest('{
  "code": "DEEPSEEK_CHAT",
  "adapter_kind": "deepseek_chat_v1",
  "wire_api_kind": "chat_completions_v1",
  "execution_contract": "cv_polish_1",
  "calculator_kind": "linear_token_v1",
  "cache_policy": "automatic"
}'::jsonb));
insert into ai.capabilities (id, code, name, description, adapter_kind, wire_api_kind, execution_contract, calculator_kind, cache_policy, descriptor_digest)
  values (2, 'MIMO_RESPONSES', 'MIMO_RESPONSES', 'Current CV polish execution semantics', 'mimo_responses_v1', 'responses_v1', 'cv_polish_1', 'linear_token_v1', 'none', common.digest('{
  "code": "MIMO_RESPONSES",
  "adapter_kind": "mimo_responses_v1",
  "wire_api_kind": "responses_v1",
  "execution_contract": "cv_polish_1",
  "calculator_kind": "linear_token_v1",
  "cache_policy": "none"
}'::jsonb));
select
  common.insert_entity ('ai.providers', jsonb_build_object('code', 'DEEPSEEK', 'name', 'DEEPSEEK', 'description', 'Supported direct Provider', 'recipient_code', 'DEEPSEEK', 'gateway_kind', 'DIRECT'));
select
  common.insert_entity ('ai.providers', jsonb_build_object('code', 'MIMO', 'name', 'MIMO', 'description', 'Supported direct Provider', 'recipient_code', 'MIMO', 'gateway_kind', 'DIRECT'));
do $$
declare
  t bigint;
  a bigint;
  b bigint;
  p bigint;
  manifest_digest text;
  ai_digest text;
  content jsonb;
begin
  content = '{
  "zh": {
    "title": "使用条款",
    "effectiveDate": "2026 年 7 月 3 日",
    "intro": [
      "本使用条款管辖你对 cv maker（https://cvmaker.dyue.org）及相关功能的使用。",
      "使用本服务即表示你同意本条款。如果你不同意，请勿使用本服务。"
    ],
    "sections": [
      {
        "heading": "服务",
        "body": [
          "cv maker 是一款简历与 CV 模板及编辑工具。它可以帮助你创建、预览、导出简历，并可选择将简历数据保存在线。",
          "本服务仅用于文档创建和个人效率提升，不提供法律、就业、移民、招聘或其他专业建议。"
        ]
      },
      {
        "heading": "账户",
        "body": [
          "部分功能可能需要注册账户。你有责任保护自己的账户安全，并对账户下的所有活动负责。",
          "对于违反本条款、滥用服务、超出合理使用限制，或造成法律、安全或运营风险的账户，我们可能会暂停或终止其使用权限。"
        ]
      },
      {
        "heading": "你的内容",
        "body": [
          "你保留通过本服务输入、上传、保存或分享的简历数据、文档、文本、文件、模板、配置及其他内容的所有权。",
          "你授予我们为提供、维护、保护和运营服务所必需而处理你内容的有限权利，具体如隐私政策所述。",
          "你应对自己的内容负责，并确保你拥有使用这些内容所需的权力和许可。",
          "你不得使用本服务存储、上传、创建或分享违法、有害、辱骂、侵权、欺骗、恶意或侵犯他人隐私或权利的内容。"
        ]
      },
      {
        "heading": "简历准确性",
        "body": [
          "你有责任检查通过本服务生成的所有简历、CV、预览、导出文件、PDF 及其他文档。",
          "我们不保证生成的文档准确、完整、无错误、兼容所有系统，或适用于任何雇主、机构、司法管辖区或用途。"
        ]
      },
      {
        "heading": "云端保存与加密",
        "body": [
          "如果云端保存功能可用，本服务可允许你将简历数据保存在线。",
          "如果你启用加密云端保存，部分简历内容会在上传前于你的浏览器中加密。在该模式下，我们不会故意存储你的加密密钥或密码；如果你丢失密钥、密码、恢复密钥、设备密钥或浏览器数据，我们可能无法恢复你的加密简历内容。",
          "除非服务另有说明，加密简历的标题、时间戳、存储模式及其他元数据可能仍然可见。",
          "如果你未启用加密即保存数据，你的简历内容可能以可读形式存储，并在为运营、保护、调试和维护服务所必需时，被我们或服务提供商访问。",
          "加密无法防范所有风险。如果你的设备、浏览器、账户、浏览器扩展、恢复密钥或服务前端代码遭到入侵，数据仍可能暴露。"
        ]
      },
      {
        "heading": "使用限制与滥用",
        "body": [
          "我们可能会设置使用限制以保护服务，包括账户创建、保存文档数量、存储大小、上传大小、请求频率、导出次数以及可疑或自动化活动的限制。",
          "你不得试图绕过这些限制、使服务过载、抓取服务、干扰安全控制，或以损害其他用户或我们基础设施的方式使用服务。"
        ]
      },
      {
        "heading": "第三方服务",
        "body": [
          "本服务可能依赖第三方提供商提供托管、身份验证、数据库存储、分析、性能测量、DNS、内容分发、安全及相关基础设施。这些提供商可能包括 Vercel、Supabase、GitHub 及身份验证服务提供商。",
          "你使用第三方登录提供商也可能受这些提供商自身条款和隐私政策的约束。"
        ]
      },
      {
        "heading": "服务可用性",
        "body": [
          "本服务按“原样”和“可用”状态提供。我们可能会随时修改、暂停、限制或终止服务的任何部分。",
          "我们不保证服务不间断可用、永久存储，或与所有浏览器、设备或系统兼容。你有责任自行备份重要数据和导出文件。"
        ]
      },
      {
        "heading": "免责声明与责任限制",
        "body": [
          "在法律允许的最大范围内，我们排除所有明示或暗示的保证，包括准确性、可用性、安全性、特定用途适用性及不侵权的保证。",
          "在法律允许的最大范围内，我们不对间接、附带、特殊、后果性、惩罚性或示范性损害，或数据、就业机会、利润、商誉或业务损失承担责任。",
          "与服务相关的索赔中，我们的总责任不超过你在索赔前 12 个月内向我们支付的服务费用或 50 美元中的较高者。"
        ]
      },
      {
        "heading": "终止",
        "body": [
          "你可以随时停止使用本服务。你可以按照隐私政策中的说明请求删除账户或云端保存的数据。",
          "如果你违反本条款、滥用服务、造成风险，或我们终止服务，我们可能会暂停或终止你的访问权限。"
        ]
      },
      {
        "heading": "变更",
        "body": [
          "我们可能会不时更新本条款。如果变更具有实质性，我们将采取合理措施通知用户，例如发布公告或更新生效日期。",
          "变更生效后你继续使用本服务，即表示你接受更新后的条款。"
        ]
      },
      {
        "heading": "适用法律",
        "body": [
          "本条款在适用法律允许的范围内适用。本条款中的任何内容均不限制适用法律下不可放弃的任何权利或救济。"
        ]
      },
      {
        "heading": "联系我们",
        "body": [
          "如有关于本条款的问题，请联系 Yue, operator of cv maker。",
          "邮箱：cvmaker@dyue.org",
          "网站：https://cvmaker.dyue.org"
        ]
      }
    ]
  },
  "en": {
    "title": "Terms of Use",
    "effectiveDate": "July 3, 2026",
    "intro": [
      "These Terms of Use govern your use of cv maker at https://cvmaker.dyue.org and related features.",
      "By using the service, you agree to these Terms. If you do not agree, do not use the service."
    ],
    "sections": [
      {
        "heading": "The Service",
        "body": [
          "cv maker is a resume and CV template and editing tool. It may allow you to create, preview, export, and optionally save resume data online.",
          "The service is provided for document creation and personal productivity. It does not provide legal, employment, immigration, recruitment, or other professional advice."
        ]
      },
      {
        "heading": "Accounts",
        "body": [
          "Some features may require an account. You are responsible for keeping your account secure and for all activity under your account.",
          "We may suspend or terminate accounts that violate these Terms, abuse the service, exceed reasonable usage limits, or create legal, security, or operational risk."
        ]
      },
      {
        "heading": "Your Content",
        "body": [
          "You retain ownership of the resume data, documents, text, files, templates, configuration, and other content you enter, upload, save, or share through the service.",
          "You grant us a limited right to process your content only as necessary to provide, maintain, secure, and operate the service, and as described in the Privacy Policy.",
          "You are responsible for your content and must ensure that you have the rights and permissions needed to use it.",
          "You must not use the service to store, upload, create, or share content that is unlawful, harmful, abusive, infringing, deceptive, malicious, or that violates another person''s privacy or rights."
        ]
      },
      {
        "heading": "Resume Accuracy",
        "body": [
          "You are responsible for reviewing all resumes, CVs, previews, exports, PDFs, and other documents generated through the service.",
          "We do not guarantee that generated documents are accurate, complete, error-free, compatible with all systems, or suitable for any employer, institution, jurisdiction, or purpose."
        ]
      },
      {
        "heading": "Cloud Save and Encryption",
        "body": [
          "If cloud save is available, the service may allow you to save resume data online.",
          "If you enable encrypted cloud save, certain resume content is encrypted in your browser before upload. In that mode, we do not intentionally store your encryption key or passphrase, and we may be unable to recover your encrypted resume content if you lose your key, passphrase, recovery key, device key, or browser data.",
          "Encrypted CV titles, timestamps, storage mode, and other metadata may remain visible unless the service says otherwise.",
          "If you save data without encryption, your resume content may be stored in a readable form and may be accessible to us and our service providers as necessary to operate, secure, debug, and maintain the service.",
          "Encryption does not protect against all risks. Data may still be exposed if your device, browser, account, browser extensions, recovery key, or the service''s frontend code is compromised."
        ]
      },
      {
        "heading": "Usage Limits and Abuse",
        "body": [
          "We may apply limits to protect the service, including limits on account creation, saved documents, storage size, upload size, request rate, exports, and suspicious or automated activity.",
          "You must not attempt to bypass these limits, overload the service, scrape the service, interfere with security controls, or use the service in a way that harms other users or our infrastructure."
        ]
      },
      {
        "heading": "Third-Party Services",
        "body": [
          "The service may rely on third-party providers for hosting, authentication, database storage, analytics, performance measurement, DNS, content delivery, security, and related infrastructure. These providers may include Vercel, Supabase, GitHub, and authentication providers.",
          "Your use of third-party login providers may also be subject to those providers'' own terms and privacy policies."
        ]
      },
      {
        "heading": "Availability",
        "body": [
          "The service is provided on an as-is and as-available basis. We may modify, suspend, limit, or discontinue any part of the service at any time.",
          "We do not guarantee uninterrupted availability, permanent storage, or compatibility with every browser, device, or system. You are responsible for keeping your own backups of important data and exported files."
        ]
      },
      {
        "heading": "Disclaimer and Liability",
        "body": [
          "To the maximum extent permitted by law, we disclaim all warranties, express or implied, including warranties of accuracy, availability, security, fitness for a particular purpose, and non-infringement.",
          "To the maximum extent permitted by law, we will not be liable for indirect, incidental, special, consequential, punitive, or exemplary damages, or for loss of data, employment opportunities, profits, goodwill, or business.",
          "Our total liability for claims relating to the service will not exceed the greater of the amount you paid us for the service in the 12 months before the claim or USD 50."
        ]
      },
      {
        "heading": "Termination",
        "body": [
          "You may stop using the service at any time. You may request deletion of your account or cloud-saved data as described in the Privacy Policy.",
          "We may suspend or terminate access if you violate these Terms, abuse the service, create risk, or if we discontinue the service."
        ]
      },
      {
        "heading": "Changes",
        "body": [
          "We may update these Terms from time to time. If changes are material, we will take reasonable steps to notify users, such as posting a notice or updating the effective date.",
          "Your continued use of the service after changes take effect means you accept the updated Terms."
        ]
      },
      {
        "heading": "Applicable Law",
        "body": [
          "These Terms apply to the extent permitted by applicable law. Nothing in these Terms limits any rights or remedies that cannot be waived under applicable law."
        ]
      },
      {
        "heading": "Contact",
        "body": [
          "For questions about these Terms, contact Yue, operator of cv maker.",
          "Email: cvmaker@dyue.org",
          "Website: https://cvmaker.dyue.org"
        ]
      }
    ]
  }
}'::jsonb;t=(common.insert_entity('legal.document_versions',jsonb_build_object('document_code','TERMS','version',1,'renderer_contract','legal_document_1','content',content,'content_digest',common.digest(content)))->>'id')::bigint;
  content = '{
  "zh": {
    "title": "AI 服务条款",
    "effectiveDate": "2026 年 11 月 7 日",
    "intro": [
      "本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。",
      "我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、所选提供方的精确披露内容版本、摘要与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。",
      "本版本由公共 AI 条款和所选提供方的披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会展示并要求接受对应的完整披露。切换提供方不代表自动同意其他披露。"
    ],
    "sections": [
      {
        "heading": "AI 润色功能",
        "body": [
          "AI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。",
          "当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。",
          "可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。"
        ]
      },
      {
        "heading": "发送的内容",
        "body": [
          "我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。",
          "我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。",
          "每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围："
        ],
        "bullets": [
          "Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。",
          "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。",
          "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。"
        ]
      },
      {
        "heading": "我们存储的内容",
        "body": [
          "我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。",
          "我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。",
          "请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。"
        ]
      },
      {
        "heading": "使用限制、配额与取消",
        "body": [
          "AI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。",
          "请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。"
        ]
      },
      {
        "heading": "提供方、路由与政策变化",
        "body": [
          "当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。",
          "第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。",
          "新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。"
        ]
      },
      {
        "heading": "AI 输出需要你审阅",
        "body": [
          "AI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。",
          "润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。"
        ]
      },
      {
        "heading": "加密与 AI 润色",
        "body": [
          "端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。",
          "当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。"
        ]
      },
      {
        "heading": "变更",
        "body": [
          "我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。"
        ]
      },
      {
        "heading": "联系我们",
        "body": [
          "如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。",
          "邮箱：cvmaker@dyue.org",
          "网站：https://cvmaker.dyue.org"
        ]
      }
    ]
  },
  "en": {
    "title": "AI Service Terms",
    "effectiveDate": "November 7, 2026",
    "intro": [
      "These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.",
      "We chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, the exact selected-provider disclosure version and digest, and acceptance time to demonstrate authorization. This is the service operator''s chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.",
      "This version consists of common AI terms and the selected provider disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is displayed and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure."
    ],
    "sections": [
      {
        "heading": "The AI Polish Feature",
        "body": [
          "AI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.",
          "When you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).",
          "The available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request."
        ]
      },
      {
        "heading": "What Is Sent",
        "body": [
          "We do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.",
          "We never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.",
          "Before each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:"
        ],
        "bullets": [
          "Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.",
          "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.",
          "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels."
        ]
      },
      {
        "heading": "What We Store",
        "body": [
          "We do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.",
          "We keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.",
          "Request metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account."
        ]
      },
      {
        "heading": "Usage Limits, Quota, and Cancellation",
        "body": [
          "AI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.",
          "Quota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service''s settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider."
        ]
      },
      {
        "heading": "Providers, Routing, and Policy Changes",
        "body": [
          "The current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.",
          "Each third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.",
          "If we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle."
        ]
      },
      {
        "heading": "AI Output Requires Your Review",
        "body": [
          "AI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.",
          "Polished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume."
        ]
      },
      {
        "heading": "Encryption and AI Polish",
        "body": [
          "End-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish.",
          "When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy."
        ]
      },
      {
        "heading": "Changes",
        "body": [
          "We may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again."
        ]
      },
      {
        "heading": "Contact",
        "body": [
          "For questions about these AI Service Terms, contact Yue, operator of cv maker.",
          "Email: cvmaker@dyue.org",
          "Website: https://cvmaker.dyue.org"
        ]
      }
    ]
  }
}'::jsonb;a=(common.insert_entity('legal.document_versions',jsonb_build_object('document_code','AI_TERMS','version',1,'renderer_contract','legal_document_1','content',content,'content_digest',common.digest(content)))->>'id')::bigint;
  content = '{
  "code": "PROVIDER_CHOICE_20261107",
  "renderer_contract": "legal_disclosure_1",
  "sources": [
    "https://api-docs.deepseek.com/quick_start/pricing/",
    "https://api-docs.deepseek.com/api/create-chat-completion/",
    "https://api-docs.deepseek.com/guides/kv_cache/",
    "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
    "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
    "https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html",
    "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
    "https://mimo.mi.com/docs/en-US/api/chat/responses",
    "https://mimo.mi.com/docs/en-US/price/pay-as-you-go",
    "https://mimo.mi.com/docs/en-US/api/guidance/rate-limit",
    "https://mimo.mi.com/docs/en-US/api/guidance/error-codes",
    "https://mimo.mi.com/docs/quick-start/terms/user-agreement",
    "https://mimo.mi.com/docs/en-US/terms/privacy-policy"
  ],
  "reviewed_provider_facts": [
    {
      "manifestId": "deepseek-official-2026-08-23-v1",
      "displayKey": "deepseek-official-v1",
      "reviewedAt": "2026-08-23 (Asia/Shanghai)",
      "provider": "Official DeepSeek Open Platform",
      "gatewayOperator": "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
      "modelVendor": "DeepSeek",
      "models": [
        "deepseek-v4-flash (Chat Completions profile)"
      ],
      "upstream": "Official DeepSeek API (api.deepseek.com)",
      "submittedData": [
        "The resume text selected by the user, chosen context, and style instructions",
        "An HMAC-SHA256 pseudonymous user_id for request isolation; no email address, username, or raw account ID"
      ],
      "providerSubjectId": "An HMAC-SHA256 pseudonymous user_id is sent. DeepSeek documents it as supporting content safety, cache isolation, and scheduling isolation.",
      "processingRegion": "DeepSeek''s general Privacy Policy describes processing and storage in the People''s Republic of China, but it expressly excludes products and services provided by downstream users. It therefore does not establish a location for content that this service submits through the Open Platform API. The API-specific processing location and region are unverified.",
      "cache": "Official API documentation states that disk context caching is enabled by default and that an unused cache is usually cleared automatically within a few hours to a few days.",
      "retention": "We found no fixed overall retention period or zero-retention commitment for this API content.",
      "training": "DeepSeek''s Terms of Use, which defines its Services to include APIs, describes limited use of de-identified data to improve the Services. The Open Platform Terms do not grant DeepSeek training use: their model-training clause concerns what the developer may do with inputs and outputs. We found no API-specific no-training commitment or opt-out.",
      "transfer": "The API-specific processing location and transfer path are unverified. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature; this is the operator''s chosen authorization flow, not a claim that API content is processed in any particular location or a universal legal conclusion for every user or transfer.",
      "unknowns": [
        "Specific retention and deletion periods for API content beyond context caching",
        "The API-specific processing/storage location, transfer path, and whether any opt-out covers API requests"
      ],
      "sources": [
        "https://api-docs.deepseek.com/quick_start/pricing/",
        "https://api-docs.deepseek.com/api/create-chat-completion/",
        "https://api-docs.deepseek.com/guides/kv_cache/",
        "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
        "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
        "https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html",
        "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"
      ]
    },
    {
      "manifestId": "mimo-cn-2026-08-23-v1",
      "displayKey": "mimo-cn-v1",
      "reviewedAt": "2026-08-23 (Asia/Shanghai)",
      "provider": "Official MiMo API (mainland-China profile)",
      "gatewayOperator": "Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.",
      "modelVendor": "Xiaomi / MiMo",
      "models": [
        "mimo-v2.5-pro (Responses API profile)"
      ],
      "upstream": "Official MiMo Responses API (api.xiaomimimo.com/v1/responses)",
      "submittedData": [
        "The resume text selected by the user, chosen context, and style instructions",
        "The initial adapter sends no HMAC provider subject ID, email address, username, or raw account ID"
      ],
      "providerSubjectId": "No provider subject ID is sent.",
      "processingRegion": "The Privacy Policy describes global data centers, including the Netherlands and Singapore, and possible transfers involving other parties or regions. The actual request region depends on the request or a separate arrangement and is not guaranteed.",
      "cache": "We could not verify a fixed TTL, scope, or opt-out mechanism for API-content caching from the reviewed official materials.",
      "retention": "The Privacy Policy states a general rule of retaining data for the necessary period and then deleting or anonymizing it; it gives no fixed numeric TTL for API content.",
      "training": "MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.",
      "transfer": "Access from mainland China is governed by the in-PRC terms; cross-border or other-region processing depends on the request and arrangements. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature.",
      "unknowns": [
        "The exact company operating the service in mainland China",
        "A guaranteed processing region for each API request",
        "API-content cache TTL, cache scope, opt-out mechanism, and fixed content-retention period"
      ],
      "sources": [
        "https://mimo.mi.com/docs/en-US/api/chat/responses",
        "https://mimo.mi.com/docs/en-US/price/pay-as-you-go",
        "https://mimo.mi.com/docs/en-US/api/guidance/rate-limit",
        "https://mimo.mi.com/docs/en-US/api/guidance/error-codes",
        "https://mimo.mi.com/docs/quick-start/terms/user-agreement",
        "https://mimo.mi.com/docs/en-US/terms/privacy-policy"
      ]
    }
  ]
}'::jsonb;manifest_digest=common.digest(content);select content_digest into ai_digest from legal.document_versions where id=a;b=(common.insert_entity('legal.bundles',jsonb_build_object('code','CURRENT_20261107','ai_document_version_id',a,'manifest',content,'manifest_digest',manifest_digest))->>'id')::bigint;
  select
    id
  into
    p
  from
    ai.providers
  where
    code = 'DEEPSEEK';
  content = '{
  "zh": {
    "providerLabel": "DeepSeek 官方开放平台",
    "modelLabel": "deepseek-v4-flash（Chat Completions profile）",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。\n\n我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、所选提供方的精确披露内容版本、摘要与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。\n\n本版本由公共 AI 条款和所选提供方的披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会展示并要求接受对应的完整披露。切换提供方不代表自动同意其他披露。\n\nAI 润色功能\n\nAI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。\n\n当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。\n\n可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。\n\n发送的内容\n\n我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。\n\n我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。\n\n每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围："
      },
      {
        "kind": "bulletList",
        "items": [
          "Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。",
          "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。",
          "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。"
        ]
      },
      {
        "kind": "paragraph",
        "text": "我们存储的内容\n\n我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。\n\n我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。\n\n请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。\n\n使用限制、配额与取消\n\nAI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。\n\n请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。\n\n提供方、路由与政策变化\n\n当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。\n\n第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。\n\n新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。\n\nAI 输出需要你审阅\n\nAI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。\n\n润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。\n\n加密与 AI 润色\n\n端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。\n\n当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。\n\n变更\n\n我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。\n\n联系我们\n\n如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。\n\n邮箱：cvmaker@dyue.org\n\n网站：https://cvmaker.dyue.org\n\n提供方附录：DeepSeek 官方开放平台\n\nManifest ID：deepseek-official-2026-08-23-v1；显示键：deepseek-official-v1；核验时间：2026-08-23（Asia/Shanghai）。\n\n提供方：DeepSeek 官方开放平台。Gateway/operator：杭州深度求索人工智能有限公司（DeepSeek）。模型提供方：DeepSeek。模型：deepseek-v4-flash（Chat Completions profile）。Upstream：DeepSeek 官方 API（api.deepseek.com）。\n\n发送内容：用户选中的简历正文、所选上下文以及风格指令；用于请求隔离的 HMAC-SHA256 假名 user_id；不发送邮箱、用户名或原始账户 ID。Provider subject ID：发送 HMAC-SHA256 假名 user_id；DeepSeek 文档称其用于内容安全、缓存隔离与调度隔离。\n\n处理地区：DeepSeek 的一般隐私政策说明会在中华人民共和国境内处理和存储数据，但该政策明确排除下游用户提供的产品和服务，因此不能据此确定本服务通过开放平台 API 提交内容的处理地点。API 特定的处理地点和区域尚未核实。\n\n缓存：官方 API 文档说明磁盘上下文缓存默认启用；不再使用的缓存通常会在数小时至数天内自动清除。\n\n留存：未找到适用于本 API 内容的固定总保留期限或零保留承诺。\n\n训练/服务改进：DeepSeek 使用条款将 API 纳入“服务”范围，并说明会在有限范围内使用去标识化数据改进服务。开放平台条款并未授予 DeepSeek 训练使用权，其中关于模型训练的条款描述的是开发者可如何使用输入和输出。未找到 API 特定的不训练承诺或退出机制。\n\n传输机制：API 特定的处理地点和传输路径尚未核实。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程；这是运营者选择的授权流程，不表示 API 内容在任何特定地点处理，也并非对所有用户或传输情形作出的通用法律结论。\n\n尚未确认：API 内容除上下文缓存外的具体保留和删除期限；API 特定的处理/存储地点、传输路径以及任何退出机制是否覆盖 API 请求。这些未知事项不得由 DB 配置或产品文案改写为保证。\n\n核验来源：\n\n官方来源 1：https://api-docs.deepseek.com/quick_start/pricing/ https://api-docs.deepseek.com/quick_start/pricing/\n\n官方来源 2：https://api-docs.deepseek.com/api/create-chat-completion/ https://api-docs.deepseek.com/api/create-chat-completion/\n\n官方来源 3：https://api-docs.deepseek.com/guides/kv_cache/ https://api-docs.deepseek.com/guides/kv_cache/\n\n官方来源 4：https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html\n\n官方来源 5：https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html\n\n官方来源 6：https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html\n\n官方来源 7：https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"
      }
    ]
  },
  "en": {
    "providerLabel": "Official DeepSeek Open Platform",
    "modelLabel": "deepseek-v4-flash (Chat Completions profile)",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.\n\nWe chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, the exact selected-provider disclosure version and digest, and acceptance time to demonstrate authorization. This is the service operator''s chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.\n\nThis version consists of common AI terms and the selected provider disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is displayed and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure.\n\nThe AI Polish Feature\n\nAI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.\n\nWhen you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).\n\nThe available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request.\n\nWhat Is Sent\n\nWe do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.\n\nWe never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.\n\nBefore each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:"
      },
      {
        "kind": "bulletList",
        "items": [
          "Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.",
          "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.",
          "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels."
        ]
      },
      {
        "kind": "paragraph",
        "text": "What We Store\n\nWe do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.\n\nWe keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.\n\nRequest metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account.\n\nUsage Limits, Quota, and Cancellation\n\nAI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.\n\nQuota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service''s settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider.\n\nProviders, Routing, and Policy Changes\n\nThe current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.\n\nEach third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.\n\nIf we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle.\n\nAI Output Requires Your Review\n\nAI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.\n\nPolished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.\n\nEncryption and AI Polish\n\nEnd-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish."
      },
      {
        "kind": "paragraph",
        "text": "When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.\n\nChanges\n\nWe may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again.\n\nContact\n\nFor questions about these AI Service Terms, contact Yue, operator of cv maker.\n\nEmail: cvmaker@dyue.org\n\nWebsite: https://cvmaker.dyue.org\n\nProvider Annex: Official DeepSeek Open Platform\n\nManifest ID: deepseek-official-2026-08-23-v1; display key: deepseek-official-v1; reviewed: 2026-08-23 (Asia/Shanghai).\n\nProvider: Official DeepSeek Open Platform. Gateway/operator: Hangzhou DeepSeek Artificial Intelligence Co., Ltd.. Model vendor: DeepSeek. Models: deepseek-v4-flash (Chat Completions profile). Upstream: Official DeepSeek API (api.deepseek.com).\n\nSubmitted data: The resume text selected by the user, chosen context, and style instructions; An HMAC-SHA256 pseudonymous user_id for request isolation; no email address, username, or raw account ID. Provider subject ID: An HMAC-SHA256 pseudonymous user_id is sent. DeepSeek documents it as supporting content safety, cache isolation, and scheduling isolation.\n\nProcessing region: DeepSeek''s general Privacy Policy describes processing and storage in the People''s Republic of China, but it expressly excludes products and services provided by downstream users. It therefore does not establish a location for content that this service submits through the Open Platform API. The API-specific processing location and region are unverified.\n\nCaching: Official API documentation states that disk context caching is enabled by default and that an unused cache is usually cleared automatically within a few hours to a few days.\n\nRetention: We found no fixed overall retention period or zero-retention commitment for this API content.\n\nTraining/service improvement: DeepSeek''s Terms of Use, which defines its Services to include APIs, describes limited use of de-identified data to improve the Services. The Open Platform Terms do not grant DeepSeek training use: their model-training clause concerns what the developer may do with inputs and outputs. We found no API-specific no-training commitment or opt-out.\n\nTransfer mechanism: The API-specific processing location and transfer path are unverified. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature; this is the operator''s chosen authorization flow, not a claim that API content is processed in any particular location or a universal legal conclusion for every user or transfer.\n\nUnresolved: Specific retention and deletion periods for API content beyond context caching; The API-specific processing/storage location, transfer path, and whether any opt-out covers API requests. Database configuration and product copy must not turn these unknowns into guarantees.\n\nSources reviewed:\n\nOfficial source 1: https://api-docs.deepseek.com/quick_start/pricing/ https://api-docs.deepseek.com/quick_start/pricing/\n\nOfficial source 2: https://api-docs.deepseek.com/api/create-chat-completion/ https://api-docs.deepseek.com/api/create-chat-completion/\n\nOfficial source 3: https://api-docs.deepseek.com/guides/kv_cache/ https://api-docs.deepseek.com/guides/kv_cache/"
      },
      {
        "kind": "paragraph",
        "text": "Official source 4: https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html\n\nOfficial source 5: https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html\n\nOfficial source 6: https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html\n\nOfficial source 7: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"
      }
    ]
  }
}'::jsonb;perform common.insert_entity('legal.disclosures',jsonb_build_object('bundle_id',b,'provider_id',p,'disclosure_code','DEEPSEEK_CURRENT','renderer_contract','legal_display_1','model_id','deepseek-v4-flash','recipient_code','DEEPSEEK','content',content,'content_digest',common.digest(jsonb_build_object('content',content,'ai_document_digest',ai_digest,'manifest_digest',
  manifest_digest))));
  select
    id
  into
    p
  from
    ai.providers
  where
    code = 'MIMO';
  content = '{
  "zh": {
    "providerLabel": "MiMo 官方 API（中国大陆 profile）",
    "modelLabel": "mimo-v2.5-pro（Responses API profile）",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。\n\n我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、所选提供方的精确披露内容版本、摘要与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。\n\n本版本由公共 AI 条款和所选提供方的披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会展示并要求接受对应的完整披露。切换提供方不代表自动同意其他披露。\n\nAI 润色功能\n\nAI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。\n\n当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。\n\n可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。\n\n发送的内容\n\n我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。\n\n我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。\n\n每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围："
      },
      {
        "kind": "bulletList",
        "items": [
          "Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。",
          "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。",
          "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。"
        ]
      },
      {
        "kind": "paragraph",
        "text": "我们存储的内容\n\n我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。\n\n我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。\n\n请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。\n\n使用限制、配额与取消\n\nAI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。\n\n请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。\n\n提供方、路由与政策变化\n\n当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。\n\n第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。\n\n新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。\n\nAI 输出需要你审阅\n\nAI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。\n\n润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。\n\n加密与 AI 润色\n\n端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。\n\n当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。\n\n变更\n\n我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。\n\n联系我们\n\n如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。\n\n邮箱：cvmaker@dyue.org\n\n网站：https://cvmaker.dyue.org\n\n提供方附录：MiMo 官方 API（中国大陆 profile）\n\nManifest ID：mimo-cn-2026-08-23-v1；显示键：mimo-cn-v1；核验时间：2026-08-23（Asia/Shanghai）。\n\n提供方：MiMo 官方 API（中国大陆 profile）。Gateway/operator：MiMo 官方 API；已核验页面未明确给出中国大陆适用运营主体的具体公司名称。中国大陆以外服务的条款列明 Xiaomi Technologies Singapore Pte. Ltd.。。模型提供方：Xiaomi / MiMo。模型：mimo-v2.5-pro（Responses API profile）。Upstream：MiMo 官方 Responses API（api.xiaomimimo.com/v1/responses）。\n\n发送内容：用户选中的简历正文、所选上下文以及风格指令；初版 adapter 不发送 HMAC provider subject ID、邮箱、用户名或原始账户 ID。Provider subject ID：不发送 provider subject ID。\n\n处理地区：隐私政策说明使用全球数据中心，包括荷兰和新加坡，并可能发生其他参与方或地区的传输；实际请求区域取决于请求或另行安排，未作固定区域保证。\n\n缓存：API 内容缓存的固定 TTL、作用域和退出机制未能从已核验官方资料确认。\n\n留存：隐私政策采用目的所需期间后删除或匿名化的一般规则；未提供 API 内容的固定数字 TTL。\n\n训练/服务改进：MiMo 将用户视为控制者、将自身描述为处理者，并称提交的 API 内容不用于模型训练或其他目的。\n\n传输机制：中国大陆访问适用中国大陆条款；跨境或其他地区处理取决于请求和安排。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程。\n\n尚未确认：中国大陆适用服务运营主体的确切公司名称；每次 API 请求的保证处理区域；API 内容缓存 TTL、缓存作用域、退出机制与固定内容保留期限。这些未知事项不得由 DB 配置或产品文案改写为保证。\n\n核验来源：\n\n官方来源 1：https://mimo.mi.com/docs/en-US/api/chat/responses https://mimo.mi.com/docs/en-US/api/chat/responses\n\n官方来源 2：https://mimo.mi.com/docs/en-US/price/pay-as-you-go https://mimo.mi.com/docs/en-US/price/pay-as-you-go\n\n官方来源 3：https://mimo.mi.com/docs/en-US/api/guidance/rate-limit https://mimo.mi.com/docs/en-US/api/guidance/rate-limit\n\n官方来源 4：https://mimo.mi.com/docs/en-US/api/guidance/error-codes https://mimo.mi.com/docs/en-US/api/guidance/error-codes\n\n官方来源 5：https://mimo.mi.com/docs/quick-start/terms/user-agreement https://mimo.mi.com/docs/quick-start/terms/user-agreement\n\n官方来源 6：https://mimo.mi.com/docs/en-US/terms/privacy-policy https://mimo.mi.com/docs/en-US/terms/privacy-policy"
      }
    ]
  },
  "en": {
    "providerLabel": "Official MiMo API (mainland-China profile)",
    "modelLabel": "mimo-v2.5-pro (Responses API profile)",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.\n\nWe chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, the exact selected-provider disclosure version and digest, and acceptance time to demonstrate authorization. This is the service operator''s chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.\n\nThis version consists of common AI terms and the selected provider disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is displayed and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure.\n\nThe AI Polish Feature\n\nAI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.\n\nWhen you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).\n\nThe available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request.\n\nWhat Is Sent\n\nWe do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.\n\nWe never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.\n\nBefore each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:"
      },
      {
        "kind": "bulletList",
        "items": [
          "Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.",
          "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.",
          "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels."
        ]
      },
      {
        "kind": "paragraph",
        "text": "What We Store\n\nWe do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.\n\nWe keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.\n\nRequest metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account.\n\nUsage Limits, Quota, and Cancellation\n\nAI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.\n\nQuota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service''s settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider.\n\nProviders, Routing, and Policy Changes\n\nThe current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.\n\nEach third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.\n\nIf we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle.\n\nAI Output Requires Your Review\n\nAI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.\n\nPolished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.\n\nEncryption and AI Polish\n\nEnd-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish."
      },
      {
        "kind": "paragraph",
        "text": "When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.\n\nChanges\n\nWe may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again.\n\nContact\n\nFor questions about these AI Service Terms, contact Yue, operator of cv maker.\n\nEmail: cvmaker@dyue.org\n\nWebsite: https://cvmaker.dyue.org\n\nProvider Annex: Official MiMo API (mainland-China profile)\n\nManifest ID: mimo-cn-2026-08-23-v1; display key: mimo-cn-v1; reviewed: 2026-08-23 (Asia/Shanghai).\n\nProvider: Official MiMo API (mainland-China profile). Gateway/operator: Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.. Model vendor: Xiaomi / MiMo. Models: mimo-v2.5-pro (Responses API profile). Upstream: Official MiMo Responses API (api.xiaomimimo.com/v1/responses).\n\nSubmitted data: The resume text selected by the user, chosen context, and style instructions; The initial adapter sends no HMAC provider subject ID, email address, username, or raw account ID. Provider subject ID: No provider subject ID is sent.\n\nProcessing region: The Privacy Policy describes global data centers, including the Netherlands and Singapore, and possible transfers involving other parties or regions. The actual request region depends on the request or a separate arrangement and is not guaranteed.\n\nCaching: We could not verify a fixed TTL, scope, or opt-out mechanism for API-content caching from the reviewed official materials.\n\nRetention: The Privacy Policy states a general rule of retaining data for the necessary period and then deleting or anonymizing it; it gives no fixed numeric TTL for API content.\n\nTraining/service improvement: MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.\n\nTransfer mechanism: Access from mainland China is governed by the in-PRC terms; cross-border or other-region processing depends on the request and arrangements. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature.\n\nUnresolved: The exact company operating the service in mainland China; A guaranteed processing region for each API request; API-content cache TTL, cache scope, opt-out mechanism, and fixed content-retention period. Database configuration and product copy must not turn these unknowns into guarantees.\n\nSources reviewed:\n\nOfficial source 1: https://mimo.mi.com/docs/en-US/api/chat/responses https://mimo.mi.com/docs/en-US/api/chat/responses\n\nOfficial source 2: https://mimo.mi.com/docs/en-US/price/pay-as-you-go https://mimo.mi.com/docs/en-US/price/pay-as-you-go\n\nOfficial source 3: https://mimo.mi.com/docs/en-US/api/guidance/rate-limit https://mimo.mi.com/docs/en-US/api/guidance/rate-limit\n\nOfficial source 4: https://mimo.mi.com/docs/en-US/api/guidance/error-codes https://mimo.mi.com/docs/en-US/api/guidance/error-codes\n\nOfficial source 5: https://mimo.mi.com/docs/quick-start/terms/user-agreement https://mimo.mi.com/docs/quick-start/terms/user-agreement\n\nOfficial source 6: https://mimo.mi.com/docs/en-US/terms/privacy-policy https://mimo.mi.com/docs/en-US/terms/privacy-policy"
      }
    ]
  }
}'::jsonb;perform common.insert_entity('legal.disclosures',jsonb_build_object('bundle_id',b,'provider_id',p,'disclosure_code','MIMO_CURRENT','renderer_contract','legal_display_1','model_id','mimo-v2.5-pro','recipient_code','MIMO','content',content,'content_digest',common.digest(jsonb_build_object('content',content,'ai_document_digest',ai_digest,'manifest_digest',
  manifest_digest))));
  update
    legal.bundles
  set
    time_sealed = clock_timestamp()
  where
    id = b;
end
$$;
-- Register only after explicit owner initialization, initially inactive.
create function admin.register_jobs ()
  returns void
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
declare
  j bigint;
begin
  if not exists (
    select
      1
    from
      admin.environment
    where
      id = 1) then
  perform
    common.fail ('NOT_READY');
end if;
  if not exists (
    select
      1
    from
      pg_extension
    where
      extname = 'pg_cron') then
  perform
    common.fail ('NOT_READY', 'PG_CRON_NOT_INSTALLED');
end if;
  if not exists (
    select
      1
    from
      cron.job
    where
      jobname = 'cv-ai-reconcile') then
  j = cron.schedule ('cv-ai-reconcile', '* * * * *', 'select ai.reconcile(100);');
  perform
    cron.alter_job (j, active := false);
end if;
  if not exists (
    select
      1
    from
      cron.job
    where
      jobname = 'cv-ai-retention') then
  j = cron.schedule ('cv-ai-retention', '17 3 * * *', 'select ai.retention_cleanup(1000);');
  perform
    cron.alter_job (j, active := false);
end if;
end
$$;
revoke all on function admin.register_jobs () from public, anon, authenticated, service_role, app_api_owner;
comment on function admin.register_jobs () is 'Migration-owner only; creates this application two named cron jobs inactive after environment initialization; never modifies other jobs.';
-- Cover FK checks/deletion paths without duplicating PK/unique index prefixes.
do $$
declare
  r record;
begin
  for r in
  select
    c.conrelid,
    c.conkey,
    n.nspname,
    t.relname,
    c.conname
  from
    pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
  where
    c.contype = 'f'
    and n.nspname in ('cv', 'ai', 'legal', 'admin', 'audit')
    and not exists (
      select
        1
      from
        pg_index i
      where
        i.indrelid = c.conrelid
        and i.indisvalid
        and i.indpred is null
        and array (
          select
            i.indkey[s]
          from
            generate_series(0, cardinality(c.conkey) - 1) s) = c.conkey)
        loop
          execute format('create index %I on %I.%I (%s)', 'ix_fk_' || substr(md5(r.conrelid::text || r.conname), 1, 16), r.nspname, r.relname, (
            select
              string_agg(quote_ident(a.attname), ',' order by x.ord)
            from unnest(r.conkey)
  with ordinality x (att, ord)
  join pg_attribute a on a.attrelid = r.conrelid
    and a.attnum = x.att));
        end loop;
  for r in
  select
    n.nspname,
    c.relname,
    a.attname
  from
    pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
  where
    n.nspname in ('cv', 'ai', 'legal', 'admin', 'audit')
    and c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped loop
      execute format('comment on column %I.%I.%I is %L', r.nspname, r.relname, r.attname, case when r.attname = 'external_id' then
          'Immutable typed random Crockford32 external identifier; not an authorization token.'
        when r.attname = 'id' then
          'Private identity primary key; never exposed to ordinary clients.'
        when r.attname like '%_id' then
          'Explicit domain reference; API projections resolve external identifiers.'
        when r.attname = 'revision' then
          'Monotonic optimistic concurrency token serialized as decimal string.'
        when r.attname = 'content_digest' then
          'Immutable SHA256 content identity; disclosure digest also covers AI document and bundle manifest.'
        else
          'Current contract field: ' || r.nspname || '.' || r.relname || '.' || r.attname
        end);
    end loop;
end
$$;
commit;
