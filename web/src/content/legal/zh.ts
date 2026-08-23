import {
  DEEPSEEK_LEGAL_DISPLAY_KEY,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_DISPLAY_KEY,
  MIMO_LEGAL_MANIFEST_ID,
  SERVICE_CONTACT_EMAIL,
  SERVICE_NAME,
  SERVICE_OPERATOR,
  SERVICE_WEBSITE,
} from "./constants";
import {
  defineAiProviderLegalManifest,
  type LegalDocument,
} from "./types";

export const LEGAL_EFFECTIVE_DATE = "2026 年 7 月 3 日";

export const PRIVACY_EFFECTIVE_DATE = "2026 年 8 月 23 日";

export const AI_TERMS_EFFECTIVE_DATE = "2026 年 8 月 23 日";

export const deepseekLegalManifest = defineAiProviderLegalManifest({
  manifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
  displayKey: DEEPSEEK_LEGAL_DISPLAY_KEY,
  reviewedAt: "2026-08-23（Asia/Shanghai）",
  provider: "DeepSeek 官方开放平台",
  gatewayOperator: "杭州深度求索人工智能有限公司（DeepSeek）",
  modelVendor: "DeepSeek",
  models: ["deepseek-v4-flash（Chat Completions profile）"],
  upstream: "DeepSeek 官方 API（api.deepseek.com）",
  submittedData: [
    "用户选中的简历正文、所选上下文以及风格指令",
    "用于请求隔离的 HMAC-SHA256 假名 user_id；不发送邮箱、用户名或原始账户 ID",
  ],
  providerSubjectId:
    "发送 HMAC-SHA256 假名 user_id；DeepSeek 文档称其用于内容安全、缓存隔离与调度隔离。",
  processingRegion:
    "DeepSeek 的政策支持在中华人民共和国境内处理和存储数据；实际 API 内容的精确设施或区域未获单独承诺。",
  cache:
    "官方 API 文档说明磁盘上下文缓存默认启用；不再使用的缓存通常会在数小时至数天内自动清除。",
  retention:
    "未找到适用于本 API 内容的固定总保留期限或零保留承诺。",
  training:
    "官方政策允许在适用条件下将输入/输出用于服务改进或模型训练；未找到 API 不训练承诺，也未确认消费者退出开关覆盖 API 请求。",
  transfer:
    "内容可能在中国境内处理。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程；这并非对所有用户或所有传输情形作出的通用法律结论。",
  unknowns: [
    "API 内容除上下文缓存外的具体保留和删除期限",
    "精确处理设施以及消费者训练退出设置是否覆盖 API",
  ],
  sources: [
    "https://api-docs.deepseek.com/quick_start/pricing/",
    "https://api-docs.deepseek.com/api/create-chat-completion/",
    "https://api-docs.deepseek.com/guides/kv_cache/",
    "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
    "https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html",
    "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
  ],
});

export const mimoLegalManifest = defineAiProviderLegalManifest({
  manifestId: MIMO_LEGAL_MANIFEST_ID,
  displayKey: MIMO_LEGAL_DISPLAY_KEY,
  reviewedAt: "2026-08-23（Asia/Shanghai）",
  provider: "MiMo 官方 API（中国大陆 profile）",
  gatewayOperator:
    "MiMo 官方 API；已核验页面未明确给出中国大陆适用运营主体的具体公司名称。中国大陆以外服务的条款列明 Xiaomi Technologies Singapore Pte. Ltd.。",
  modelVendor: "Xiaomi / MiMo",
  models: ["mimo-v2.5-pro（Responses API profile）"],
  upstream: "MiMo 官方 Responses API（api.xiaomimimo.com/v1/responses）",
  submittedData: [
    "用户选中的简历正文、所选上下文以及风格指令",
    "初版 adapter 不发送 HMAC provider subject ID、邮箱、用户名或原始账户 ID",
  ],
  providerSubjectId: "不发送 provider subject ID。",
  processingRegion:
    "隐私政策说明使用全球数据中心，包括荷兰和新加坡，并可能发生其他参与方或地区的传输；实际请求区域取决于请求或另行安排，未作固定区域保证。",
  cache:
    "API 内容缓存的固定 TTL、作用域和退出机制未能从已核验官方资料确认。",
  retention:
    "隐私政策采用目的所需期间后删除或匿名化的一般规则；未提供 API 内容的固定数字 TTL。",
  training:
    "MiMo 将用户视为控制者、将自身描述为处理者，并称提交的 API 内容不用于模型训练或其他目的。",
  transfer:
    "中国大陆访问适用中国大陆条款；跨境或其他地区处理取决于请求和安排。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程。",
  unknowns: [
    "中国大陆适用服务运营主体的确切公司名称",
    "每次 API 请求的保证处理区域",
    "API 内容缓存 TTL、缓存作用域、退出机制与固定内容保留期限",
  ],
  sources: [
    "https://mimo.mi.com/docs/en-US/api/chat/responses",
    "https://mimo.mi.com/docs/en-US/price/pay-as-you-go",
    "https://mimo.mi.com/docs/en-US/api/guidance/rate-limit",
    "https://mimo.mi.com/docs/en-US/api/guidance/error-codes",
    "https://mimo.mi.com/docs/quick-start/terms/user-agreement",
    "https://mimo.mi.com/docs/en-US/terms/privacy-policy",
  ],
});

export const aiProviderLegalManifests = Object.freeze([
  deepseekLegalManifest,
  mimoLegalManifest,
]);

export const termsDocument: LegalDocument = {
  title: "使用条款",
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  intro: [
    `本使用条款管辖你对 ${SERVICE_NAME}（${SERVICE_WEBSITE}）及相关功能的使用。`,
    "使用本服务即表示你同意本条款。如果你不同意，请勿使用本服务。",
  ],
  sections: [
    {
      heading: "服务",
      body: [
        `${SERVICE_NAME} 是一款简历与 CV 模板及编辑工具。它可以帮助你创建、预览、导出简历，并可选择将简历数据保存在线。`,
        "本服务仅用于文档创建和个人效率提升，不提供法律、就业、移民、招聘或其他专业建议。",
      ],
    },
    {
      heading: "账户",
      body: [
        "部分功能可能需要注册账户。你有责任保护自己的账户安全，并对账户下的所有活动负责。",
        "对于违反本条款、滥用服务、超出合理使用限制，或造成法律、安全或运营风险的账户，我们可能会暂停或终止其使用权限。",
      ],
    },
    {
      heading: "你的内容",
      body: [
        "你保留通过本服务输入、上传、保存或分享的简历数据、文档、文本、文件、模板、配置及其他内容的所有权。",
        "你授予我们为提供、维护、保护和运营服务所必需而处理你内容的有限权利，具体如隐私政策所述。",
        "你应对自己的内容负责，并确保你拥有使用这些内容所需的权力和许可。",
        "你不得使用本服务存储、上传、创建或分享违法、有害、辱骂、侵权、欺骗、恶意或侵犯他人隐私或权利的内容。",
      ],
    },
    {
      heading: "简历准确性",
      body: [
        "你有责任检查通过本服务生成的所有简历、CV、预览、导出文件、PDF 及其他文档。",
        "我们不保证生成的文档准确、完整、无错误、兼容所有系统，或适用于任何雇主、机构、司法管辖区或用途。",
      ],
    },
    {
      heading: "云端保存与加密",
      body: [
        "如果云端保存功能可用，本服务可允许你将简历数据保存在线。",
        "如果你启用加密云端保存，部分简历内容会在上传前于你的浏览器中加密。在该模式下，我们不会故意存储你的加密密钥或密码；如果你丢失密钥、密码、恢复密钥、设备密钥或浏览器数据，我们可能无法恢复你的加密简历内容。",
        "除非服务另有说明，加密简历的标题、时间戳、存储模式及其他元数据可能仍然可见。",
        "如果你未启用加密即保存数据，你的简历内容可能以可读形式存储，并在为运营、保护、调试和维护服务所必需时，被我们或服务提供商访问。",
        "加密无法防范所有风险。如果你的设备、浏览器、账户、浏览器扩展、恢复密钥或服务前端代码遭到入侵，数据仍可能暴露。",
      ],
    },
    {
      heading: "使用限制与滥用",
      body: [
        "我们可能会设置使用限制以保护服务，包括账户创建、保存文档数量、存储大小、上传大小、请求频率、导出次数以及可疑或自动化活动的限制。",
        "你不得试图绕过这些限制、使服务过载、抓取服务、干扰安全控制，或以损害其他用户或我们基础设施的方式使用服务。",
      ],
    },
    {
      heading: "第三方服务",
      body: [
        "本服务可能依赖第三方提供商提供托管、身份验证、数据库存储、分析、性能测量、DNS、内容分发、安全及相关基础设施。这些提供商可能包括 Vercel、Supabase、GitHub 及身份验证服务提供商。",
        "你使用第三方登录提供商也可能受这些提供商自身条款和隐私政策的约束。",
      ],
    },
    {
      heading: "服务可用性",
      body: [
        "本服务按“原样”和“可用”状态提供。我们可能会随时修改、暂停、限制或终止服务的任何部分。",
        "我们不保证服务不间断可用、永久存储，或与所有浏览器、设备或系统兼容。你有责任自行备份重要数据和导出文件。",
      ],
    },
    {
      heading: "免责声明与责任限制",
      body: [
        "在法律允许的最大范围内，我们排除所有明示或暗示的保证，包括准确性、可用性、安全性、特定用途适用性及不侵权的保证。",
        "在法律允许的最大范围内，我们不对间接、附带、特殊、后果性、惩罚性或示范性损害，或数据、就业机会、利润、商誉或业务损失承担责任。",
        "与服务相关的索赔中，我们的总责任不超过你在索赔前 12 个月内向我们支付的服务费用或 50 美元中的较高者。",
      ],
    },
    {
      heading: "终止",
      body: [
        "你可以随时停止使用本服务。你可以按照隐私政策中的说明请求删除账户或云端保存的数据。",
        "如果你违反本条款、滥用服务、造成风险，或我们终止服务，我们可能会暂停或终止你的访问权限。",
      ],
    },
    {
      heading: "变更",
      body: [
        "我们可能会不时更新本条款。如果变更具有实质性，我们将采取合理措施通知用户，例如发布公告或更新生效日期。",
        "变更生效后你继续使用本服务，即表示你接受更新后的条款。",
      ],
    },
    {
      heading: "适用法律",
      body: [
        "本条款在适用法律允许的范围内适用。本条款中的任何内容均不限制适用法律下不可放弃的任何权利或救济。",
      ],
    },
    {
      heading: "联系我们",
      body: [
        `如有关于本条款的问题，请联系 ${SERVICE_OPERATOR}。`,
        `邮箱：${SERVICE_CONTACT_EMAIL}`,
        `网站：${SERVICE_WEBSITE}`,
      ],
    },
  ],
};

export const privacyDocument: LegalDocument = {
  title: "隐私政策",
  effectiveDate: PRIVACY_EFFECTIVE_DATE,
  intro: [
    `本隐私政策说明 ${SERVICE_OPERATOR} 在你使用 ${SERVICE_NAME}（${SERVICE_WEBSITE}）及相关功能时，如何收集、使用、存储、分享和保护个人数据。`,
  ],
  sections: [
    {
      heading: "我们是谁",
      body: [
        `你个人数据的控制者或运营者是 ${SERVICE_OPERATOR}。`,
        `邮箱：${SERVICE_CONTACT_EMAIL}`,
        `网站：${SERVICE_WEBSITE}`,
      ],
    },
    {
      heading: "我们收集的数据",
      body: [
        "如果你创建账户或登录，我们可能会处理你的邮箱地址、用户 ID、身份验证提供商信息、账户状态、邮箱验证状态、登录时间戳及安全相关信息。",
        "如果你创建、编辑、保存、导出或分享简历，我们可能会处理你选择输入的信息，例如姓名、联系方式、教育背景、工作经历、项目、技能、链接、模板设置及文档元数据。",
        "如果你仅使用本地功能，简历数据可能保留在你的浏览器中。如果你使用云端保存，简历数据可能会上传至我们的后端提供商。",
        "如果你启用加密云端保存，部分简历内容会在上传前于你的浏览器中加密。在该模式下，我们存储密文及相关加密元数据，但不会故意存储你的加密密钥、密码或恢复密钥。除非另有说明，加密简历的标题和元数据可能仍然可见。",
        "如果你未启用加密即保存数据，你的简历内容可能以可读形式存储，并在为运营、保护、调试和维护服务所必需时，被我们或服务提供商访问。",
        "我们可能会在你的浏览器中存储数据，例如草稿、编辑器设置、偏好设置、会话状态、本地简历数据，以及如果你选择记住此设备时的加密或设备密钥。",
        "我们和基础设施提供商可能会处理技术数据，例如 IP 地址、浏览器类型、设备类型、操作系统、请求日志、错误日志、时间戳以及安全或防滥用信号。",
        "如果你联系我们，我们可能会处理你的邮箱地址、消息内容、截图、附件及相关诊断信息。",
      ],
    },
    {
      heading: "我们如何使用数据",
      body: [
        "我们使用个人数据来提供服务；创建和管理账户；在你使用相关功能时保存、同步、导出和分享简历；保护服务安全并防止滥用；调试错误并保持可靠性；响应支持请求；执行使用条款；以及遵守法律义务。",
        "我们的法律依据可能包括履行合同、合法利益、必要时取得同意，以及遵守法律义务。",
      ],
    },
    {
      heading: "分析、Cookie 与本地存储",
      body: [
        "我们使用 Vercel Web Analytics 和 Vercel Speed Insights 来了解服务的整体使用情况和性能。这些工具旨在进行面向隐私的分析和性能测量，而非广告追踪。",
        "本服务可能会使用必要的 Cookie 或本地浏览器存储来支持身份验证、安全、偏好设置、编辑器草稿、本地保存和加密设备解锁。",
        "如果我们未来添加非必要的广告或追踪技术，我们将更新本隐私政策并提供所需的通知或同意控制。",
      ],
    },
    {
      heading: "我们如何分享数据",
      body: [
        "我们不会出售你的个人数据。",
        "我们可能会与帮助我们运营服务的服务提供商分享或处理个人数据，例如提供托管、数据库存储、身份验证、分析、性能测量、DNS、内容分发、安全、邮件发送和错误监控的服务提供商。",
        "这些提供商可能包括 Vercel、Supabase、GitHub、身份验证提供商及类似基础设施提供商。",
        "如果为遵守法律、保护用户或服务、调查滥用或安全事件、执行我们的条款或响应合法请求而合理必要，我们也可能会披露数据。",
      ],
    },
    {
      heading: "跨境传输",
      body: [
        "我们和我们的服务提供商可能会在你居住国以外的国家处理数据。",
        "在 GDPR 适用且个人数据被传输至欧洲经济区以外的情况下，我们将在需要时依赖适当的保障措施，例如充分性认定、标准合同条款或其他合法的传输机制。",
        "AI 润色的实际接收方与可能处理地区取决于请求时冻结的路由。当前 DeepSeek 与 MiMo 路径的已知处理地区、传输安排和未确认事项列在 AI 服务条款的提供方附录中。",
        "在适用法律要求且没有其他适当保障时，我们可能依赖你对这项可选功能的明示同意。我们选择使用独立同意流程来披露风险和记录授权；这并不表示每一家 AI 提供方普遍要求独立同意，也不构成对每个司法管辖区的法律结论。",
      ],
    },
    {
      heading: "AI 功能",
      body: [
        "如果你使用 AI 润色功能，你选中的简历文本及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。当前可纳入路由的接收方是 DeepSeek 官方开放平台与 MiMo 官方 API；MiMo 在初版发布时可以保持未激活状态，但其附录已预先披露。",
        "首次使用当前 AI legal bundle 前，我们会要求你单独同意 AI 服务条款。条款包含中性处理规则及不可变的提供方附录，说明发送内容、标识符、缓存、留存、训练或服务改进、处理地区、未确认事项、我们的元数据日志与配额规则。",
        "每次请求前，界面会展示实际路由披露。如果路由或 legal bundle 已变化，我们会在向任何 AI 服务传输前停止请求并要求你重新确认。我们不会把你的同意当作选择提供方的指令。",
        "你可以停止使用 AI 润色来撤回对未来请求的同意；这不影响撤回前已经发生的处理，也不要求我们删除为证明历史同意、结算配额、安全或法律义务而必须保留的记录。你也可以按「你的权利」一节联系我们。",
        "端到端加密（如可用）不适用于发送至 AI 服务的内容；你加密简历的其余部分仍按本政策所述受到保护。",
      ],
    },
    {
      heading: "数据保留",
      body: [
        "我们仅在隐私政策所述目的所需的时间内保留个人数据。",
      ],
      bullets: [
        "账户数据在账户存在期间保留。",
        "云端保存的简历数据保留至你删除或请求删除为止。",
        "本地浏览器数据保留在你的设备上，直至你清除或通过服务删除。",
        "支持邮件最多保留 24 个月。",
        "技术和安全日志最多保留 90 天。",
        "AI 润色请求与尝试的元数据 ledger/log（不含简历正文、风格指令与 AI 输出）在请求结束 90 天后进入删除计划；按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每日清理任务执行，因此记录可能保留至越过阈值后的下一次计划运行（最多多保留约一天）。",
        "备份可能会在有限期限内保留已删除数据，通常为 90 天，之后将被覆盖或删除。",
        "如果为遵守法律、安全、争议解决或防止滥用所需，我们可能会保留部分数据更长时间。",
      ],
    },
    {
      heading: "你的权利",
      body: [
        "根据你所在的位置和适用法律，你可能有权访问、更正、删除、导出、限制或反对处理你的个人数据，并在基于同意进行处理时撤回同意。",
        `你可以通过 ${SERVICE_CONTACT_EMAIL} 联系我们，请求删除账户或云端保存的数据。`,
        "我们可能需要先验证你的身份再处理请求。我们将在适用法律要求的时限内作出回应。",
        "如果你的简历内容已加密，而你丢失了密钥、密码、恢复密钥或本地设备密钥，我们可能无法为你解密或导出加密内容。",
      ],
    },
    {
      heading: "安全",
      body: [
        "我们采取合理的技术和组织措施保护个人数据，例如 HTTPS、身份验证控制、访问控制、数据库安全规则、适当加密、速率限制和防滥用措施。",
        "没有任何系统是完美安全的。你有责任保护自己的账户、设备、浏览器、恢复密钥和密码安全。",
      ],
    },
    {
      heading: "儿童",
      body: [
        "本服务不面向 16 岁以下儿童。我们不会在知情的情况下收集 16 岁以下儿童的个人数据。",
        `如果你认为有儿童通过本服务提供了个人数据，请通过 ${SERVICE_CONTACT_EMAIL} 联系我们。`,
      ],
    },
    {
      heading: "公开渠道",
      body: [
        "如果你在 GitHub issues、pull requests、discussions 或其他公开社区渠道等公共场所发布信息，这些信息可能会被他人看到，并由相关平台处理。",
        "请勿在公开渠道发布私人简历内容、密码、恢复密钥或敏感个人数据。",
      ],
    },
    {
      heading: "变更",
      body: [
        "我们可能会不时更新本隐私政策。如果变更具有实质性，我们将采取合理措施通知用户，例如发布公告或更新生效日期。",
      ],
    },
    {
      heading: "联系我们",
      body: [
        `如有关于隐私的问题或请求，请联系 ${SERVICE_OPERATOR}。`,
        `邮箱：${SERVICE_CONTACT_EMAIL}`,
        `网站：${SERVICE_WEBSITE}`,
      ],
    },
  ],
};

export const termsAcceptanceSummary = [
  "云端存储会同步简历数据到 Supabase。加密云端存储会在浏览器中加密简历正文内容，但标题和元数据可能仍然可见。",
  "如果丢失加密密码或受信任设备密钥，加密简历内容可能无法恢复。",
  "服务按原样提供。请自行备份重要的简历数据和导出文件。",
];

function providerAnnexSection(
  title: string,
  manifest: (typeof aiProviderLegalManifests)[number],
) {
  return {
    heading: `提供方附录：${title}`,
    body: [
      `Manifest ID：${manifest.manifestId}；显示键：${manifest.displayKey}；核验时间：${manifest.reviewedAt}。`,
      `提供方：${manifest.provider}。Gateway/operator：${manifest.gatewayOperator}。模型提供方：${manifest.modelVendor}。模型：${manifest.models.join("、")}。Upstream：${manifest.upstream}。`,
      `发送内容：${manifest.submittedData.join("；")}。Provider subject ID：${manifest.providerSubjectId}`,
      `处理地区：${manifest.processingRegion}`,
      `缓存：${manifest.cache}`,
      `留存：${manifest.retention}`,
      `训练/服务改进：${manifest.training}`,
      `传输机制：${manifest.transfer}`,
      `尚未确认：${manifest.unknowns.join("；")}。这些未知事项不得由 DB 配置或产品文案改写为保证。`,
      "核验来源：",
    ],
    bullets: [...manifest.sources],
  };
}

export const aiTermsDocument: LegalDocument = {
  title: "AI 服务条款",
  effectiveDate: AI_TERMS_EFFECTIVE_DATE,
  intro: [
    `本 AI 服务条款管辖你对 ${SERVICE_NAME}（${SERVICE_WEBSITE}）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。`,
    "我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、legal bundle 版本与时间戳，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。",
    "本版本由中性正文和下方不可变的 DeepSeek/MiMo 提供方附录共同组成。请求使用的实际 route 会在发送前只读披露；界面不提供 provider selector。",
  ],
  sections: [
    {
      heading: "AI 润色功能",
      body: [
        "AI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。",
        "当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。",
        "路由由服务端配置和请求时间决定。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。",
      ],
    },
    {
      heading: "发送的内容",
      body: [
        "我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。",
        "我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。",
        "每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围：",
      ],
      bullets: [
        "Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。",
        "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。",
        "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。",
      ],
    },
    {
      heading: "我们存储的内容",
      body: [
        "我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。",
        "我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、AI 服务请求 ID、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。",
        "请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。",
      ],
    },
    {
      heading: "使用限制、配额与取消",
      body: [
        "AI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。",
        "请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。",
      ],
    },
    {
      heading: "提供方、路由与政策变化",
      body: [
        "当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。",
        "第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。",
        "新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。",
      ],
    },
    {
      heading: "AI 输出需要你审阅",
      body: [
        "AI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。",
        "润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。",
      ],
    },
    {
      heading: "加密与 AI 润色",
      body: [
        "端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。",
        "当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。",
      ],
    },
    providerAnnexSection("DeepSeek 官方开放平台", deepseekLegalManifest),
    providerAnnexSection("MiMo 官方 API（中国大陆 profile）", mimoLegalManifest),
    {
      heading: "变更",
      body: [
        "我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。",
      ],
    },
    {
      heading: "联系我们",
      body: [
        `如有关于本 AI 服务条款的问题，请联系 ${SERVICE_OPERATOR}。`,
        `邮箱：${SERVICE_CONTACT_EMAIL}`,
        `网站：${SERVICE_WEBSITE}`,
      ],
    },
  ],
};
