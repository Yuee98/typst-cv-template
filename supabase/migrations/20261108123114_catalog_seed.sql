begin;
set local search_path = '';
select
  common.audit_context (null, null, 'cv_app_db_2 initial catalog', 'MIGRATION');
insert into ai.adapters (id, name)
values
  (1, 'DeepSeek Responses'),
  (2, 'MiMo Responses'),
  (3, 'Gemini Interactions');
insert into ai.runtime_control (id)
  values (1);
do $seed$
declare
  tries integer := 0;
  cn text;
begin
  loop
    begin
      insert into legal.documents (enabled, recipient_name, adapter_id, endpoint_url, model_id, kind, effective_date, zh_title, en_title, zh_body, en_body, content_digest)
        values (true, null, null, null, null, 'TERMS', '2026-07-03', '使用条款', 'Terms of Use', '本使用条款管辖你对 cv maker（https://cvmaker.dyue.org）及相关功能的使用。

使用本服务即表示你同意本条款。如果你不同意，请勿使用本服务。

## 服务

cv maker 是一款简历与 CV 模板及编辑工具。它可以帮助你创建、预览、导出简历，并可选择将简历数据保存在线。

本服务仅用于文档创建和个人效率提升，不提供法律、就业、移民、招聘或其他专业建议。

## 账户

部分功能可能需要注册账户。你有责任保护自己的账户安全，并对账户下的所有活动负责。

对于违反本条款、滥用服务、超出合理使用限制，或造成法律、安全或运营风险的账户，我们可能会暂停或终止其使用权限。

## 你的内容

你保留通过本服务输入、上传、保存或分享的简历数据、文档、文本、文件、模板、配置及其他内容的所有权。

你授予我们为提供、维护、保护和运营服务所必需而处理你内容的有限权利，具体如隐私政策所述。

你应对自己的内容负责，并确保你拥有使用这些内容所需的权力和许可。

你不得使用本服务存储、上传、创建或分享违法、有害、辱骂、侵权、欺骗、恶意或侵犯他人隐私或权利的内容。

## 简历准确性

你有责任检查通过本服务生成的所有简历、CV、预览、导出文件、PDF 及其他文档。

我们不保证生成的文档准确、完整、无错误、兼容所有系统，或适用于任何雇主、机构、司法管辖区或用途。

## 云端保存与加密

如果云端保存功能可用，本服务可允许你将简历数据保存在线。

如果你启用加密云端保存，部分简历内容会在上传前于你的浏览器中加密。在该模式下，我们不会故意存储你的加密密钥或密码；如果你丢失密钥、密码、恢复密钥、设备密钥或浏览器数据，我们可能无法恢复你的加密简历内容。

除非服务另有说明，加密简历的标题、时间戳、存储模式及其他元数据可能仍然可见。

如果你未启用加密即保存数据，你的简历内容可能以可读形式存储，并在为运营、保护、调试和维护服务所必需时，被我们或服务提供商访问。

加密无法防范所有风险。如果你的设备、浏览器、账户、浏览器扩展、恢复密钥或服务前端代码遭到入侵，数据仍可能暴露。

## 使用限制与滥用

我们可能会设置使用限制以保护服务，包括账户创建、保存文档数量、存储大小、上传大小、请求频率、导出次数以及可疑或自动化活动的限制。

你不得试图绕过这些限制、使服务过载、抓取服务、干扰安全控制，或以损害其他用户或我们基础设施的方式使用服务。

## 第三方服务

本服务可能依赖第三方提供商提供托管、身份验证、数据库存储、分析、性能测量、DNS、内容分发、安全及相关基础设施。这些提供商可能包括 Vercel、Supabase、GitHub 及身份验证服务提供商。

你使用第三方登录提供商也可能受这些提供商自身条款和隐私政策的约束。

## 服务可用性

本服务按“原样”和“可用”状态提供。我们可能会随时修改、暂停、限制或终止服务的任何部分。

我们不保证服务不间断可用、永久存储，或与所有浏览器、设备或系统兼容。你有责任自行备份重要数据和导出文件。

## 免责声明与责任限制

在法律允许的最大范围内，我们排除所有明示或暗示的保证，包括准确性、可用性、安全性、特定用途适用性及不侵权的保证。

在法律允许的最大范围内，我们不对间接、附带、特殊、后果性、惩罚性或示范性损害，或数据、就业机会、利润、商誉或业务损失承担责任。

与服务相关的索赔中，我们的总责任不超过你在索赔前 12 个月内向我们支付的服务费用或 50 美元中的较高者。

## 终止

你可以随时停止使用本服务。你可以按照隐私政策中的说明请求删除账户或云端保存的数据。

如果你违反本条款、滥用服务、造成风险，或我们终止服务，我们可能会暂停或终止你的访问权限。

## 变更

我们可能会不时更新本条款。如果变更具有实质性，我们将采取合理措施通知用户，例如发布公告或更新生效日期。

变更生效后你继续使用本服务，即表示你接受更新后的条款。

## 适用法律

本条款在适用法律允许的范围内适用。本条款中的任何内容均不限制适用法律下不可放弃的任何权利或救济。

## 联系我们

如有关于本条款的问题，请联系 Yue, operator of cv maker。

邮箱：cvmaker@dyue.org

网站：https://cvmaker.dyue.org','These Terms of Use govern your use of cv maker at https://cvmaker.dyue.org and related features.

By using the service, you agree to these Terms. If you do not agree, do not use the service.

## The Service

cv maker is a resume and CV template and editing tool. It may allow you to create, preview, export, and optionally save resume data online.

The service is provided for document creation and personal productivity. It does not provide legal, employment, immigration, recruitment, or other professional advice.

## Accounts

Some features may require an account. You are responsible for keeping your account secure and for all activity under your account.

We may suspend or terminate accounts that violate these Terms, abuse the service, exceed reasonable usage limits, or create legal, security, or operational risk.

## Your Content

You retain ownership of the resume data, documents, text, files, templates, configuration, and other content you enter, upload, save, or share through the service.

You grant us a limited right to process your content only as necessary to provide, maintain, secure, and operate the service, and as described in the Privacy Policy.

You are responsible for your content and must ensure that you have the rights and permissions needed to use it.

You must not use the service to store, upload, create, or share content that is unlawful, harmful, abusive, infringing, deceptive, malicious, or that violates another person''s privacy or rights.

## Resume Accuracy

You are responsible for reviewing all resumes, CVs, previews, exports, PDFs, and other documents generated through the service.

We do not guarantee that generated documents are accurate, complete, error-free, compatible with all systems, or suitable for any employer, institution, jurisdiction, or purpose.

## Cloud Save and Encryption

If cloud save is available, the service may allow you to save resume data online.

If you enable encrypted cloud save, certain resume content is encrypted in your browser before upload. In that mode, we do not intentionally store your encryption key or passphrase, and we may be unable to recover your encrypted resume content if you lose your key, passphrase, recovery key, device key, or browser data.

Encrypted CV titles, timestamps, storage mode, and other metadata may remain visible unless the service says otherwise.

If you save data without encryption, your resume content may be stored in a readable form and may be accessible to us and our service providers as necessary to operate, secure, debug, and maintain the service.

Encryption does not protect against all risks. Data may still be exposed if your device, browser, account, browser extensions, recovery key, or the service''s frontend code is compromised.

## Usage Limits and Abuse

We may apply limits to protect the service, including limits on account creation, saved documents, storage size, upload size, request rate, exports, and suspicious or automated activity.

You must not attempt to bypass these limits, overload the service, scrape the service, interfere with security controls, or use the service in a way that harms other users or our infrastructure.

## Third-Party Services

The service may rely on third-party providers for hosting, authentication, database storage, analytics, performance measurement, DNS, content delivery, security, and related infrastructure. These providers may include Vercel, Supabase, GitHub, and authentication providers.

Your use of third-party login providers may also be subject to those providers'' own terms and privacy policies.

## Availability

The service is provided on an as-is and as-available basis. We may modify, suspend, limit, or discontinue any part of the service at any time.

We do not guarantee uninterrupted availability, permanent storage, or compatibility with every browser, device, or system. You are responsible for keeping your own backups of important data and exported files.

## Disclaimer and Liability

To the maximum extent permitted by law, we disclaim all warranties, express or implied, including warranties of accuracy, availability, security, fitness for a particular purpose, and non-infringement.

To the maximum extent permitted by law, we will not be liable for indirect, incidental, special, consequential, punitive, or exemplary damages, or for loss of data, employment opportunities, profits, goodwill, or business.

Our total liability for claims relating to the service will not exceed the greater of the amount you paid us for the service in the 12 months before the claim or USD 50.

## Termination

You may stop using the service at any time. You may request deletion of your account or cloud-saved data as described in the Privacy Policy.

We may suspend or terminate access if you violate these Terms, abuse the service, create risk, or if we discontinue the service.

## Changes

We may update these Terms from time to time. If changes are material, we will take reasonable steps to notify users, such as posting a notice or updating the effective date.

Your continued use of the service after changes take effect means you accept the updated Terms.

## Applicable Law

These Terms apply to the extent permitted by applicable law. Nothing in these Terms limits any rights or remedies that cannot be waived under applicable law.

## Contact

For questions about these Terms, contact Yue, operator of cv maker.

Email: cvmaker@dyue.org

Website: https://cvmaker.dyue.org','');exit;exception when unique_violation then get stacked diagnostics cn=constraint_name;tries=tries+1;if cn<>'uq_legal_documents_external_id'
          or tries >= 5 then
          raise;
    end if;
    end;
end loop;
end
$seed$;
do $seed$
declare
  tries integer := 0;
  cn text;
begin
  loop
    begin
      insert into legal.documents (enabled, recipient_name, adapter_id, endpoint_url, model_id, kind, effective_date, zh_title, en_title, zh_body, en_body, content_digest)
        values (true, null, null, null, null, 'AI_COMMON', '2026-11-08', 'AI 服务条款', 'AI Service Terms', '本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。

我们为这项可选功能选择独立同意流程。使用适用条款前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、公共条款与所选服务披露的精确内容与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。

适用条款由公共 AI 条款和所选服务披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会提供完整披露的精确阅读链接，并要求接受对应内容。切换提供方不代表自动同意其他披露。

## AI 润色功能

AI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。

当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。

可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用所选并已披露的一项服务和模型；服务故障不会在同一请求内触发未披露的跨服务自动切换。

## 发送的内容

我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。

我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于所选接入已实现的请求格式；所选服务的精确数据处理说明会说明是否发送此标识符。

每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围：

- Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。
- Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。
- Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。

## 我们存储的内容

我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。

我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的配置、时间规则、价格与精确法律同意记录、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。

请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。

## 使用限制、配额与取消

AI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。

请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。

## 提供方、路由与政策变化

可用服务由运营者配置。实际接收方、接入地址与模型必须符合所选配置展示的披露，并在请求中冻结。请求格式兼容不代表接收方或数据处理条款相同。

第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。

新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新适用披露，并在新请求前要求接受其当前内容。此前的同意不授权其他接收方或处理范围。

## AI 输出需要你审阅

AI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。

润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。

## 加密与 AI 润色

端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。

当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。

## 变更

我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。

## 联系我们

如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。

邮箱：cvmaker@dyue.org

网站：https://cvmaker.dyue.org','These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.

We chose a separate-consent flow for this optional feature. Before using the applicable terms, you must separately accept it in the feature interface; we record your user ID, the exact common terms and selected-service disclosure, and acceptance time to demonstrate authorization. This is the service operator''s chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.

The applicable terms consist of common AI terms and the selected service disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is available through an exact document link and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure.

## The AI Polish Feature

AI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.

When you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see "Encryption and AI Polish" below).

The available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed service and model; a service failure does not trigger an undisclosed automatic cross-provider fallback within that request.

## What Is Sent

We do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.

We never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the selected connection’s implemented request format. The exact selected-service disclosure states whether this identifier is sent.

Before each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:

- Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.
- Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.
- Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels.

## What We Store

We do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.

We keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen configuration, routing rule, price and exact legal acceptance records, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.

Request metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account.

## Usage Limits, Quota, and Cancellation

AI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.

Quota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service''s settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider.

## Providers, Routing, and Policy Changes

Available services are configured by the operator. The actual recipient, endpoint and model must match the disclosure presented for the selected configuration and frozen for the request. A compatible request format does not establish the same recipient or data-processing terms.

Each third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.

If we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the applicable disclosure and require acceptance of its current content before a new request. An earlier acceptance does not authorize another recipient or processing scope.

## AI Output Requires Your Review

AI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.

Polished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.

## Encryption and AI Polish

End-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish.

When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.

## Changes

We may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again.

## Contact

For questions about these AI Service Terms, contact Yue, operator of cv maker.

Email: cvmaker@dyue.org

Website: https://cvmaker.dyue.org','');exit;exception when unique_violation then get stacked diagnostics cn=constraint_name;tries=tries+1;if cn<>'uq_legal_documents_external_id'
          or tries >= 5 then
          raise;
    end if;
    end;
end loop;
end
$seed$;
do $seed$
declare
  tries integer := 0;
  cn text;
begin
  loop
    begin
      insert into legal.documents (kind, effective_date, enabled, recipient_name, adapter_id, endpoint_url, model_id, zh_title, en_title, zh_body, en_body, content_digest)
        values ('AI_PROVIDER', '2026-11-08', true, 'Official DeepSeek Open Platform', 1, 'https://api.deepseek.com/responses', 'deepseek-flash', 'DeepSeek 官方开放平台 · deepseek-flash 数据处理说明', 'Official DeepSeek Open Platform · deepseek-flash data-processing disclosure', '实际服务: DeepSeek 官方开放平台

运营者/接收方: 杭州深度求索人工智能有限公司（DeepSeek）

模型: deepseek-flash

## 发送内容

用户选中的简历正文、所选上下文以及风格指令

通过 Responses API user 字段发送的 HMAC-SHA256 假名标识；不发送邮箱、用户名或原始账户 ID

通过 Responses API 的 user 字段发送 HMAC-SHA256 假名标识；DeepSeek 文档称其用于内容安全、缓存隔离与调度隔离。

## 处理地区

DeepSeek 的一般隐私政策说明会在中华人民共和国境内处理和存储数据，但该政策明确排除下游用户提供的产品和服务，因此不能据此确定本服务通过开放平台 API 提交内容的处理地点。API 特定的处理地点和区域尚未核实。

## 缓存

官方 API 文档说明磁盘上下文缓存默认启用；不再使用的缓存通常会在数小时至数天内自动清除。

## 留存

DeepSeek 将 Responses API 描述为无状态，不保存可续接的响应或会话状态。store 请求参数不受支持，本服务不发送该参数；响应中的 store 固定为 false。这不构成缓存或安全日志零留存保证，未找到适用于 API 内容的固定总保留期限或零保留承诺。

## 训练与服务改进

DeepSeek 使用条款将 API 纳入“服务”范围，并说明会在有限范围内使用去标识化数据改进服务。开放平台条款并未授予 DeepSeek 训练使用权，其中关于模型训练的条款描述的是开发者可如何使用输入和输出。未找到 API 特定的不训练承诺或退出机制。

## 传输

API 特定的处理地点和传输路径尚未核实。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程；这是运营者选择的授权流程，不表示 API 内容在任何特定地点处理，也并非对所有用户或传输情形作出的通用法律结论。

## 尚未确认事项

- API 内容除上下文缓存外的具体保留和删除期限
- API 特定的处理/存储地点、传输路径以及任何退出机制是否覆盖 API 请求

## 来源与核验日期

Responses API 技术事实：2026-11-07；政策证据沿用 2026-08-23（Asia/Shanghai）

- [官方来源 1](https://api-docs.deepseek.com/quick_start/pricing/)
- [官方来源 2](https://api-docs.deepseek.com/api/create-response/)
- [官方来源 3](https://api-docs.deepseek.com/guides/responses_api/)
- [官方来源 4](https://api-docs.deepseek.com/quick_start/rate_limit/)
- [官方来源 5](https://api-docs.deepseek.com/guides/kv_cache/)
- [官方来源 6](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
- [官方来源 7](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)
- [官方来源 8](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)
- [官方来源 9](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)','Service: Official DeepSeek Open Platform

Operator/recipient: Hangzhou DeepSeek Artificial Intelligence Co., Ltd.

Model: deepseek-flash

## What is sent

The resume text selected by the user, chosen context, and style instructions

An HMAC-SHA256 pseudonymous identifier in the Responses API user field; no email address, username, or raw account ID

An HMAC-SHA256 pseudonymous identifier is sent in the Responses API user field. DeepSeek documents it for content safety, cache isolation, and scheduling isolation.

## Processing region

DeepSeek''s general Privacy Policy describes processing and storage in the People''s Republic of China, but it expressly excludes products and services provided by downstream users. It therefore does not establish a location for content that this service submits through the Open Platform API. The API-specific processing location and region are unverified.

## Caching

Official API documentation states that disk context caching is enabled by default and that an unused cache is usually cleared automatically within a few hours to a few days.

## Retention

DeepSeek describes Responses as stateless, without stored response or conversation state. The store request parameter is unsupported and is not sent; responses carry store:false. This does not establish zero retention of caches or safety logs. We found no fixed overall retention period or zero-retention commitment for API content.

## Training and service improvement

DeepSeek''s Terms of Use, which defines its Services to include APIs, describes limited use of de-identified data to improve the Services. The Open Platform Terms do not grant DeepSeek training use: their model-training clause concerns what the developer may do with inputs and outputs. We found no API-specific no-training commitment or opt-out.

## Transfers

The API-specific processing location and transfer path are unverified. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature; this is the operator''s chosen authorization flow, not a claim that API content is processed in any particular location or a universal legal conclusion for every user or transfer.

## Unverified matters

- Specific retention and deletion periods for API content beyond context caching
- The API-specific processing/storage location, transfer path, and whether any opt-out covers API requests

## Sources and review dates

Responses API technical facts: 2026-11-07; policy evidence retained from 2026-08-23 (Asia/Shanghai)

- [Official source 1](https://api-docs.deepseek.com/quick_start/pricing/)
- [Official source 2](https://api-docs.deepseek.com/api/create-response/)
- [Official source 3](https://api-docs.deepseek.com/guides/responses_api/)
- [Official source 4](https://api-docs.deepseek.com/quick_start/rate_limit/)
- [Official source 5](https://api-docs.deepseek.com/guides/kv_cache/)
- [Official source 6](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
- [Official source 7](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)
- [Official source 8](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)
- [Official source 9](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)','');exit;exception when unique_violation then get stacked diagnostics cn=constraint_name;tries=tries+1;if cn<>'uq_legal_documents_external_id'
          or tries >= 5 then
          raise;
    end if;
    end;
end loop;
end
$seed$;
do $seed$
declare
  tries integer := 0;
  cn text;
begin
  loop
    begin
      insert into legal.documents (kind, effective_date, enabled, recipient_name, adapter_id, endpoint_url, model_id, zh_title, en_title, zh_body, en_body, content_digest)
        values ('AI_PROVIDER', '2026-11-08', true, 'Official MiMo API (mainland-China access)', 2, 'https://api.xiaomimimo.com/v1/responses', 'mimo-v2.6-flash', 'MiMo 官方 API（中国大陆接入） · mimo-v2.6-flash 数据处理说明', 'Official MiMo API (mainland-China access) · mimo-v2.6-flash data-processing disclosure', '实际服务: MiMo 官方 API（中国大陆接入）

运营者/接收方: MiMo 官方 API；已核验页面未明确给出中国大陆适用运营主体的具体公司名称。中国大陆以外服务的条款列明 Xiaomi Technologies Singapore Pte. Ltd.。

模型: mimo-v2.6-flash

## 发送内容

用户选中的简历正文、所选上下文以及风格指令

初版 adapter 不发送 HMAC provider subject ID、邮箱、用户名或原始账户 ID

不发送 provider subject ID。

## 处理地区

隐私政策说明使用全球数据中心，包括荷兰和新加坡，并可能发生其他参与方或地区的传输；实际请求区域取决于请求或另行安排，未作固定区域保证。

## 缓存

API 内容缓存的固定 TTL、作用域和退出机制未能从已核验官方资料确认。

## 留存

隐私政策采用目的所需期间后删除或匿名化的一般规则；未提供 API 内容的固定数字 TTL。

## 训练与服务改进

MiMo 将用户视为控制者、将自身描述为处理者，并称提交的 API 内容不用于模型训练或其他目的。

## 传输

中国大陆访问适用中国大陆条款；跨境或其他地区处理取决于请求和安排。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程。

## 尚未确认事项

- 中国大陆适用服务运营主体的确切公司名称
- 每次 API 请求的保证处理区域
- API 内容缓存 TTL、缓存作用域、退出机制与固定内容保留期限

## 来源与核验日期

2026-08-23（Asia/Shanghai）

- [官方来源 1](https://mimo.mi.com/docs/en-US/api/chat/responses)
- [官方来源 2](https://mimo.mi.com/docs/en-US/price/pay-as-you-go)
- [官方来源 3](https://mimo.mi.com/docs/en-US/api/guidance/rate-limit)
- [官方来源 4](https://mimo.mi.com/docs/en-US/api/guidance/error-codes)
- [官方来源 5](https://mimo.mi.com/docs/quick-start/terms/user-agreement)
- [官方来源 6](https://mimo.mi.com/docs/en-US/terms/privacy-policy)','Service: Official MiMo API (mainland-China access)

Operator/recipient: Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.

Model: mimo-v2.6-flash

## What is sent

The resume text selected by the user, chosen context, and style instructions

The adapter sends no HMAC provider subject ID, email address, username, or raw account ID

No provider subject ID is sent.

## Processing region

The Privacy Policy describes global data centers, including the Netherlands and Singapore, and possible transfers involving other parties or regions. The actual request region depends on the request or a separate arrangement and is not guaranteed.

## Caching

We could not verify a fixed TTL, scope, or opt-out mechanism for API-content caching from the reviewed official materials.

## Retention

The Privacy Policy states a general rule of retaining data for the necessary period and then deleting or anonymizing it; it gives no fixed numeric TTL for API content.

## Training and service improvement

MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.

## Transfers

Access from mainland China is governed by the in-PRC terms; cross-border or other-region processing depends on the request and arrangements. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature.

## Unverified matters

- The exact company operating the service in mainland China
- A guaranteed processing region for each API request
- API-content cache TTL, cache scope, opt-out mechanism, and fixed content-retention period

## Sources and review dates

Model selection updated: 2026-11-08; policy evidence retained from 2026-08-23 (Asia/Shanghai)

- [Official source 1](https://mimo.mi.com/docs/en-US/api/chat/responses)
- [Official source 2](https://mimo.mi.com/docs/en-US/price/pay-as-you-go)
- [Official source 3](https://mimo.mi.com/docs/en-US/api/guidance/rate-limit)
- [Official source 4](https://mimo.mi.com/docs/en-US/api/guidance/error-codes)
- [Official source 5](https://mimo.mi.com/docs/quick-start/terms/user-agreement)
- [Official source 6](https://mimo.mi.com/docs/en-US/terms/privacy-policy)','');exit;exception when unique_violation then get stacked diagnostics cn=constraint_name;tries=tries+1;if cn<>'uq_legal_documents_external_id'
          or tries >= 5 then
          raise;
    end if;
    end;
end loop;
end
$seed$;
do $seed$
declare
  tries integer := 0;
  cn text;
begin
  loop
    begin
      insert into legal.documents (kind, effective_date, enabled, recipient_name, adapter_id, endpoint_url, model_id, zh_title, en_title, zh_body, en_body, content_digest)
        values ('AI_PROVIDER', '2026-11-08', true, 'Google Gemini API (AI Studio)', 3, 'https://generativelanguage.googleapis.com/v1/interactions', 'gemini-3.8-flash', 'Google Gemini API（AI Studio） · gemini-3.8-flash 数据处理说明', 'Google Gemini API (AI Studio) · gemini-3.8-flash data-processing disclosure', '实际服务: Google Gemini API（AI Studio）

运营者/接收方: 通过 Google AI Studio 使用 Google Gemini Developer API；实际签约的 Google 主体取决于适用账户、计费协议及司法辖区。

模型: gemini-3.8-flash

## 发送内容

用户选中的简历正文、所选上下文以及风格指令

不发送 HMAC provider subject ID、邮箱、用户名或原始账户 ID

不发送 provider subject ID。此配置只处理单次文本请求，不使用工具、搜索 grounding、上传文件、后台执行或续接会话状态。

## 处理地区

付费 API 条款允许在 Google 或其代理拥有设施的任何国家临时存储或缓存数据；此配置未核实每次请求的处理地区或数据驻留保证。

## 缓存

Google 将隐式内存缓存描述为按项目隔离的 RAM 存储，TTL 为 24 小时。本服务不创建显式缓存；关闭 interaction 存储不代表关闭所有缓存或滥用监控记录。

## 留存

本服务明确请求不保存 interaction 以供之后查询或续接会话。独立的滥用监控日志及项目日志、数据集设置仍受 Google 条款约束；不承诺整体零留存或固定的全部删除期限。

## 训练与服务改进

免费服务可能使用提交内容和响应改进产品及机器学习技术，并可人工审阅；Google 条款要求不要向免费服务提交个人、敏感或机密信息。关联活跃 Cloud Billing 项目的付费服务不将提示词和响应用于产品改进，但仍有有限的滥用监控；开发者位于欧洲经济区、瑞士和英国时，免费服务也适用付费服务的数据使用规则。主动分享的日志、数据集或反馈可用于改进和人工审阅。本应用不启用此类分享；仅凭 key 或模型名不能证明项目计费层级与设置。

## 传输

数据可能依据适用 Google 协议及保障措施在你所在国家以外处理。运营者应在真实简历使用前核实项目计费与数据分享设置；独立同意不构成处理地域或零留存证明。

## 尚未确认事项

- 实际部署项目的计费与数据分享设置，除非由其所有者另行核实
- 每次请求的实际处理地区及完整滥用监控保留、删除期限
- 任何另行约定的企业保障是否适用；本服务不假设存在此类安排

## 来源与核验日期

2026-11-07 (Asia/Shanghai)

- [官方来源 1](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [官方来源 2](https://aistudio.google.com/api-reference/interactions-api/create-interaction?api-version=v1)
- [官方来源 3](https://ai.google.dev/gemini-api/terms)
- [官方来源 4](https://ai.google.dev/gemini-api/docs/zdr)
- [官方来源 5](https://ai.google.dev/gemini-api/docs/logs-policy)','Service: Google Gemini API (AI Studio)

Operator/recipient: Google Gemini Developer API via Google AI Studio. The contracting Google entity depends on the applicable account, billing agreement and jurisdiction.

Model: gemini-3.8-flash

## What is sent

The resume text selected by the user, chosen context, and style instructions

No HMAC provider subject ID, email address, username, or raw account ID is sent

No provider subject ID is sent. This connection uses a single text request without tools, grounding, uploaded files, background execution or continued conversation state.

## Processing region

The paid API terms allow transient storage or caching in any country where Google or its agents maintain facilities. No per-request processing region or data-residency guarantee has been verified for this connection.

## Caching

Google describes implicit in-memory caching as project-isolated RAM storage with a 24-hour TTL. This service does not create explicit caches. The interaction-storage opt-out does not disable every cache or abuse-monitoring record.

## Retention

This service explicitly opts out of storing the interaction for later retrieval or conversation continuation. Separate abuse-monitoring logs and any project logging or dataset settings remain subject to Google terms; no overall zero-retention or fixed deletion deadline is promised.

## Training and service improvement

For Unpaid Services, Google may use submitted content and responses to improve products and machine-learning technologies, with human review; its terms say not to submit personal, sensitive or confidential information. For Paid Services tied to an active Cloud Billing project, Google does not use prompts/responses for product improvement, but limited abuse monitoring remains. For developers in the EEA, Switzerland and UK, the paid data-use rules also apply to Unpaid Services. Voluntarily shared logs, datasets or feedback can be used for improvement and human review. This app does not enable such sharing, and a key or model name alone does not prove the project tier or settings.

## Transfers

Data may be processed outside your country under the applicable Google agreement and safeguards. The operator must verify the project billing and data-sharing settings before real CV use; separate consent does not establish a processing region or zero retention.

## Unverified matters

- The billing and data-sharing settings of the deployed project, unless separately verified by its owner
- The actual region of each request and complete abuse-monitoring retention/deletion period
- Whether any separately arranged enterprise safeguards apply; no such arrangement is assumed

## Sources and review dates

2026-11-07 (Asia/Shanghai)

- [Official source 1](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Official source 2](https://aistudio.google.com/api-reference/interactions-api/create-interaction?api-version=v1)
- [Official source 3](https://ai.google.dev/gemini-api/terms)
- [Official source 4](https://ai.google.dev/gemini-api/docs/zdr)
- [Official source 5](https://ai.google.dev/gemini-api/docs/logs-policy)','');exit;exception when unique_violation then get stacked diagnostics cn=constraint_name;tries=tries+1;if cn<>'uq_legal_documents_external_id'
          or tries >= 5 then
          raise;
    end if;
    end;
end loop;
end
$seed$;
commit;
