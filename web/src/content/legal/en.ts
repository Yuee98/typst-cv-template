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
  type LegalSection,
} from "./types";

export const LEGAL_EFFECTIVE_DATE = "July 3, 2026";

export const PRIVACY_EFFECTIVE_DATE = "August 23, 2026";

export const AI_TERMS_EFFECTIVE_DATE = "August 23, 2026";

export const deepseekLegalManifest = defineAiProviderLegalManifest({
  manifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
  displayKey: DEEPSEEK_LEGAL_DISPLAY_KEY,
  reviewedAt: "2026-08-23 (Asia/Shanghai)",
  provider: "Official DeepSeek Open Platform",
  gatewayOperator: "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
  modelVendor: "DeepSeek",
  models: ["deepseek-v4-flash (Chat Completions profile)"],
  upstream: "Official DeepSeek API (api.deepseek.com)",
  submittedData: [
    "The resume text selected by the user, chosen context, and style instructions",
    "An HMAC-SHA256 pseudonymous user_id for request isolation; no email address, username, or raw account ID",
  ],
  providerSubjectId:
    "An HMAC-SHA256 pseudonymous user_id is sent. DeepSeek documents it as supporting content safety, cache isolation, and scheduling isolation.",
  processingRegion:
    "DeepSeek's general Privacy Policy describes processing and storage in the People's Republic of China, but it expressly excludes products and services provided by downstream users. It therefore does not establish a location for content that this service submits through the Open Platform API. The API-specific processing location and region are unverified.",
  cache:
    "Official API documentation states that disk context caching is enabled by default and that an unused cache is usually cleared automatically within a few hours to a few days.",
  retention:
    "We found no fixed overall retention period or zero-retention commitment for this API content.",
  training:
    "The Open Platform Terms allow user inputs and outputs to be used for service improvement or model training in applicable circumstances. We found no API no-training commitment or API-specific opt-out.",
  transfer:
    "The API-specific processing location and transfer path are unverified. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature; this is the operator's chosen authorization flow, not a claim that API content is processed in any particular location or a universal legal conclusion for every user or transfer.",
  unknowns: [
    "Specific retention and deletion periods for API content beyond context caching",
    "The API-specific processing/storage location, transfer path, and whether any opt-out covers API requests",
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
  reviewedAt: "2026-08-23 (Asia/Shanghai)",
  provider: "Official MiMo API (mainland-China profile)",
  gatewayOperator:
    "Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.",
  modelVendor: "Xiaomi / MiMo",
  models: ["mimo-v2.5-pro (Responses API profile)"],
  upstream: "Official MiMo Responses API (api.xiaomimimo.com/v1/responses)",
  submittedData: [
    "The resume text selected by the user, chosen context, and style instructions",
    "The initial adapter sends no HMAC provider subject ID, email address, username, or raw account ID",
  ],
  providerSubjectId: "No provider subject ID is sent.",
  processingRegion:
    "The Privacy Policy describes global data centers, including the Netherlands and Singapore, and possible transfers involving other parties or regions. The actual request region depends on the request or a separate arrangement and is not guaranteed.",
  cache:
    "We could not verify a fixed TTL, scope, or opt-out mechanism for API-content caching from the reviewed official materials.",
  retention:
    "The Privacy Policy states a general rule of retaining data for the necessary period and then deleting or anonymizing it; it gives no fixed numeric TTL for API content.",
  training:
    "MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.",
  transfer:
    "Access from mainland China is governed by the in-PRC terms; cross-border or other-region processing depends on the request and arrangements. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature.",
  unknowns: [
    "The exact company operating the service in mainland China",
    "A guaranteed processing region for each API request",
    "API-content cache TTL, cache scope, opt-out mechanism, and fixed content-retention period",
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
  title: "Terms of Use",
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  intro: [
    `These Terms of Use govern your use of ${SERVICE_NAME} at ${SERVICE_WEBSITE} and related features.`,
    "By using the service, you agree to these Terms. If you do not agree, do not use the service.",
  ],
  sections: [
    {
      heading: "The Service",
      body: [
        `${SERVICE_NAME} is a resume and CV template and editing tool. It may allow you to create, preview, export, and optionally save resume data online.`,
        "The service is provided for document creation and personal productivity. It does not provide legal, employment, immigration, recruitment, or other professional advice.",
      ],
    },
    {
      heading: "Accounts",
      body: [
        "Some features may require an account. You are responsible for keeping your account secure and for all activity under your account.",
        "We may suspend or terminate accounts that violate these Terms, abuse the service, exceed reasonable usage limits, or create legal, security, or operational risk.",
      ],
    },
    {
      heading: "Your Content",
      body: [
        "You retain ownership of the resume data, documents, text, files, templates, configuration, and other content you enter, upload, save, or share through the service.",
        "You grant us a limited right to process your content only as necessary to provide, maintain, secure, and operate the service, and as described in the Privacy Policy.",
        "You are responsible for your content and must ensure that you have the rights and permissions needed to use it.",
        "You must not use the service to store, upload, create, or share content that is unlawful, harmful, abusive, infringing, deceptive, malicious, or that violates another person's privacy or rights.",
      ],
    },
    {
      heading: "Resume Accuracy",
      body: [
        "You are responsible for reviewing all resumes, CVs, previews, exports, PDFs, and other documents generated through the service.",
        "We do not guarantee that generated documents are accurate, complete, error-free, compatible with all systems, or suitable for any employer, institution, jurisdiction, or purpose.",
      ],
    },
    {
      heading: "Cloud Save and Encryption",
      body: [
        "If cloud save is available, the service may allow you to save resume data online.",
        "If you enable encrypted cloud save, certain resume content is encrypted in your browser before upload. In that mode, we do not intentionally store your encryption key or passphrase, and we may be unable to recover your encrypted resume content if you lose your key, passphrase, recovery key, device key, or browser data.",
        "Encrypted CV titles, timestamps, storage mode, and other metadata may remain visible unless the service says otherwise.",
        "If you save data without encryption, your resume content may be stored in a readable form and may be accessible to us and our service providers as necessary to operate, secure, debug, and maintain the service.",
        "Encryption does not protect against all risks. Data may still be exposed if your device, browser, account, browser extensions, recovery key, or the service's frontend code is compromised.",
      ],
    },
    {
      heading: "Usage Limits and Abuse",
      body: [
        "We may apply limits to protect the service, including limits on account creation, saved documents, storage size, upload size, request rate, exports, and suspicious or automated activity.",
        "You must not attempt to bypass these limits, overload the service, scrape the service, interfere with security controls, or use the service in a way that harms other users or our infrastructure.",
      ],
    },
    {
      heading: "Third-Party Services",
      body: [
        "The service may rely on third-party providers for hosting, authentication, database storage, analytics, performance measurement, DNS, content delivery, security, and related infrastructure. These providers may include Vercel, Supabase, GitHub, and authentication providers.",
        "Your use of third-party login providers may also be subject to those providers' own terms and privacy policies.",
      ],
    },
    {
      heading: "Availability",
      body: [
        "The service is provided on an as-is and as-available basis. We may modify, suspend, limit, or discontinue any part of the service at any time.",
        "We do not guarantee uninterrupted availability, permanent storage, or compatibility with every browser, device, or system. You are responsible for keeping your own backups of important data and exported files.",
      ],
    },
    {
      heading: "Disclaimer and Liability",
      body: [
        "To the maximum extent permitted by law, we disclaim all warranties, express or implied, including warranties of accuracy, availability, security, fitness for a particular purpose, and non-infringement.",
        "To the maximum extent permitted by law, we will not be liable for indirect, incidental, special, consequential, punitive, or exemplary damages, or for loss of data, employment opportunities, profits, goodwill, or business.",
        "Our total liability for claims relating to the service will not exceed the greater of the amount you paid us for the service in the 12 months before the claim or USD 50.",
      ],
    },
    {
      heading: "Termination",
      body: [
        "You may stop using the service at any time. You may request deletion of your account or cloud-saved data as described in the Privacy Policy.",
        "We may suspend or terminate access if you violate these Terms, abuse the service, create risk, or if we discontinue the service.",
      ],
    },
    {
      heading: "Changes",
      body: [
        "We may update these Terms from time to time. If changes are material, we will take reasonable steps to notify users, such as posting a notice or updating the effective date.",
        "Your continued use of the service after changes take effect means you accept the updated Terms.",
      ],
    },
    {
      heading: "Applicable Law",
      body: [
        "These Terms apply to the extent permitted by applicable law. Nothing in these Terms limits any rights or remedies that cannot be waived under applicable law.",
      ],
    },
    {
      heading: "Contact",
      body: [
        `For questions about these Terms, contact ${SERVICE_OPERATOR}.`,
        `Email: ${SERVICE_CONTACT_EMAIL}`,
        `Website: ${SERVICE_WEBSITE}`,
      ],
    },
  ],
};

export const privacyDocument: LegalDocument = {
  title: "Privacy Policy",
  effectiveDate: PRIVACY_EFFECTIVE_DATE,
  intro: [
    `This Privacy Policy explains how ${SERVICE_OPERATOR} collects, uses, stores, shares, and protects personal data when you use ${SERVICE_NAME} at ${SERVICE_WEBSITE} and related features.`,
  ],
  sections: [
    {
      heading: "Who We Are",
      body: [
        `The controller or operator of your personal data is ${SERVICE_OPERATOR}.`,
        `Email: ${SERVICE_CONTACT_EMAIL}`,
        `Website: ${SERVICE_WEBSITE}`,
      ],
    },
    {
      heading: "Data We Collect",
      body: [
        "If you create an account or sign in, we may process your email address, user ID, authentication provider information, account status, email verification status, login timestamps, and security-related information.",
        "If you create, edit, save, export, or share a resume, we may process the information you choose to enter, such as your name, contact details, education, work history, projects, skills, links, template settings, and document metadata.",
        "If you use local-only features, resume data may remain in your browser. If you use cloud save, resume data may be uploaded to our backend provider.",
        "If you enable encrypted cloud save, certain resume content is encrypted in your browser before upload. In that mode, we store ciphertext and related encryption metadata, but we do not intentionally store your encryption key, passphrase, or recovery key. Encrypted CV titles and metadata may remain visible unless stated otherwise.",
        "If you save without encryption, your resume content may be stored in a readable form and may be accessible to us and our service providers as necessary to operate, secure, debug, and maintain the service.",
        "We may store data in your browser, such as drafts, editor settings, preferences, session state, local resume data, and encryption or device keys if you choose to remember this device.",
        "We and our infrastructure providers may process technical data such as IP address, browser type, device type, operating system, request logs, error logs, timestamps, and security or abuse-prevention signals.",
        "If you contact us, we may process your email address, message content, screenshots, attachments, and related diagnostic information.",
      ],
    },
    {
      heading: "How We Use Data",
      body: [
        "We use personal data to provide the service; create and manage accounts; save, sync, export, and share resumes if you use those features; secure the service and prevent abuse; debug errors and maintain reliability; respond to support requests; enforce the Terms of Use; and comply with legal obligations.",
        "Our legal bases may include performance of a contract, legitimate interests, consent where required, and compliance with legal obligations.",
      ],
    },
    {
      heading: "Analytics, Cookies, and Local Storage",
      body: [
        "We use Vercel Web Analytics and Vercel Speed Insights to understand aggregate usage and performance of the service. These tools are intended for privacy-oriented analytics and performance measurement rather than advertising tracking.",
        "The service may use necessary cookies or local browser storage for authentication, security, preferences, editor drafts, local save, and encrypted device unlock.",
        "If we add non-essential advertising or tracking technologies in the future, we will update this Privacy Policy and provide any required notice or consent controls.",
      ],
    },
    {
      heading: "How We Share Data",
      body: [
        "We do not sell your personal data.",
        "We may share or process personal data with service providers that help us operate the service, such as providers for hosting, database storage, authentication, analytics, performance measurement, DNS, content delivery, security, email delivery, and error monitoring.",
        "These providers may include Vercel, Supabase, GitHub, authentication providers, and similar infrastructure providers.",
        "We may also disclose data if reasonably necessary to comply with law, protect users or the service, investigate abuse or security incidents, enforce our Terms, or respond to lawful requests.",
      ],
    },
    {
      heading: "International Transfers",
      body: [
        "We and our service providers may process data in countries other than your country of residence.",
        "Where GDPR applies and personal data is transferred outside the European Economic Area, we rely on appropriate safeguards where required, such as adequacy decisions, standard contractual clauses, or other lawful transfer mechanisms.",
        "The actual recipient and possible processing regions for AI polish depend on the route frozen for the request. The known processing regions, transfer arrangements, and unresolved points for the current DeepSeek and MiMo routes are listed in the provider annexes to the AI Service Terms.",
        "Where applicable law requires it and no other appropriate safeguard is available, we may rely on your explicit consent for this optional feature. We chose a separate-consent flow to disclose risk and record authorization; this does not mean that every AI provider universally requires separate consent, nor is it a legal conclusion for every jurisdiction.",
      ],
      links: [
        {
          kind: "internal",
          label: "View the DeepSeek provider annex",
          href: "/ai-terms#provider-annex-deepseek-official-v1",
          locale: "en",
        },
        {
          kind: "internal",
          label: "View the MiMo provider annex",
          href: "/ai-terms#provider-annex-mimo-cn-v1",
          locale: "en",
        },
      ],
    },
    {
      heading: "AI Features",
      body: [
        "If you use AI polish, the resume text you select and the context you choose to include are forwarded in plaintext through our server to the third-party AI service disclosed for that request. The recipients currently eligible to be routed are the official DeepSeek Open Platform and the official MiMo API. MiMo may remain inactive at initial release, but its annex is disclosed in advance.",
        "Before first use of the current AI legal bundle, we ask you to separately accept the AI Service Terms. The terms combine neutral processing rules with immutable provider annexes covering submitted data, identifiers, caching, retention, training or service improvement, processing regions, unresolved points, and our own metadata logging and quota rules.",
        "Before each request, the interface discloses the actual route. If the route or legal bundle changed, we stop before transmitting anything to an AI service and ask you to confirm again. We do not treat your consent as an instruction to select a provider.",
        "You may withdraw consent for future requests by ceasing to use AI polish. This does not affect processing that already occurred, and it does not require deletion of records we must retain to prove historical consent, settle quota, protect security, or satisfy legal obligations. You may also contact us as described under \"Your Rights\".",
        "End-to-end encryption, where available, does not apply to content sent to the AI provider; the rest of your encrypted resume remains protected as described in this policy.",
      ],
      links: [
        {
          kind: "internal",
          label: "AI Service Terms — DeepSeek provider annex",
          href: "/ai-terms#provider-annex-deepseek-official-v1",
          locale: "en",
        },
        {
          kind: "internal",
          label: "AI Service Terms — MiMo provider annex",
          href: "/ai-terms#provider-annex-mimo-cn-v1",
          locale: "en",
        },
      ],
    },
    {
      heading: "Data Retention",
      body: [
        "We keep personal data only as long as necessary for the purposes described in this Privacy Policy.",
      ],
      bullets: [
        "Account data is kept while your account exists.",
        "Cloud-saved resume data is kept until you delete it or request deletion.",
        "Local browser data remains on your device until you clear it or delete it through the service.",
        "Support emails are kept for up to 24 months.",
        "Technical and security logs are kept for up to 90 days.",
        "AI polish request and attempt metadata ledgers/logs (which never contain resume text, style instructions, or AI output) are scheduled for deletion 90 days after the request completes; per-minute rate-limit counters after 2 days; and daily usage aggregates after 90 days. Deletion is performed by a daily cleanup job, so a record may remain until the next scheduled run after it crosses the threshold (up to roughly one additional day).",
        "Backups may retain deleted data for a limited period, typically up to 90 days, before being overwritten or deleted.",
        "We may retain limited data longer where necessary for legal compliance, security, dispute resolution, or abuse prevention.",
      ],
    },
    {
      heading: "Your Rights",
      body: [
        "Depending on your location and applicable law, you may have the right to access, correct, delete, export, restrict, or object to the processing of your personal data, and to withdraw consent where processing is based on consent.",
        `You may request account deletion or deletion of your cloud-saved data by contacting us at ${SERVICE_CONTACT_EMAIL}.`,
        "We may need to verify your identity before processing a request. We will respond within the timeframe required by applicable law.",
        "If your resume content is encrypted and you have lost your key, passphrase, recovery key, or local device key, we may be unable to decrypt or export the encrypted content for you.",
      ],
    },
    {
      heading: "Security",
      body: [
        "We use reasonable technical and organizational measures to protect personal data, such as HTTPS, authentication controls, access controls, database security rules, encryption where appropriate, rate limits, and abuse-prevention measures.",
        "No system is perfectly secure. You are responsible for keeping your account, device, browser, recovery key, and password secure.",
      ],
    },
    {
      heading: "Children",
      body: [
        "The service is not intended for children under 16. We do not knowingly collect personal data from children under 16.",
        `If you believe a child has provided personal data through the service, contact us at ${SERVICE_CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: "Public Channels",
      body: [
        "If you post information in public places, such as GitHub issues, pull requests, discussions, or public community channels, that information may be visible to others and handled by the relevant platform.",
        "Do not post private resume content, passwords, recovery keys, or sensitive personal data in public channels.",
      ],
    },
    {
      heading: "Changes",
      body: [
        "We may update this Privacy Policy from time to time. If changes are material, we will take reasonable steps to notify users, such as posting a notice or updating the effective date.",
      ],
    },
    {
      heading: "Contact",
      body: [
        `For privacy questions or requests, contact ${SERVICE_OPERATOR}.`,
        `Email: ${SERVICE_CONTACT_EMAIL}`,
        `Website: ${SERVICE_WEBSITE}`,
      ],
    },
  ],
};

export const termsAcceptanceSummary = [
  "Cloud storage syncs CV data to Supabase. Encrypted cloud storage encrypts CV body content in your browser, but titles and metadata may remain visible.",
  "If you lose an encryption password or trusted-device key, encrypted CV content may not be recoverable.",
  "The service is provided as-is. Keep your own backups of important CV data and exported files.",
];

function providerAnnexSection(
  title: string,
  manifest: (typeof aiProviderLegalManifests)[number],
): LegalSection {
  return {
    id: `provider-annex-${manifest.displayKey}`,
    heading: `Provider Annex: ${title}`,
    body: [
      `Manifest ID: ${manifest.manifestId}; display key: ${manifest.displayKey}; reviewed: ${manifest.reviewedAt}.`,
      `Provider: ${manifest.provider}. Gateway/operator: ${manifest.gatewayOperator}. Model vendor: ${manifest.modelVendor}. Models: ${manifest.models.join(", ")}. Upstream: ${manifest.upstream}.`,
      `Submitted data: ${manifest.submittedData.join("; ")}. Provider subject ID: ${manifest.providerSubjectId}`,
      `Processing region: ${manifest.processingRegion}`,
      `Caching: ${manifest.cache}`,
      `Retention: ${manifest.retention}`,
      `Training/service improvement: ${manifest.training}`,
      `Transfer mechanism: ${manifest.transfer}`,
      `Unresolved: ${manifest.unknowns.join("; ")}. Database configuration and product copy must not turn these unknowns into guarantees.`,
      "Sources reviewed:",
    ],
    links: manifest.sources.map((href, index) => ({
      kind: "external",
      label: `Official source ${index + 1}: ${href}`,
      href,
    })),
  };
}

export const aiTermsDocument: LegalDocument = {
  title: "AI Service Terms",
  effectiveDate: AI_TERMS_EFFECTIVE_DATE,
  intro: [
    `These AI Service Terms govern your use of the AI polish feature of ${SERVICE_NAME} at ${SERVICE_WEBSITE}. They supplement the Terms of Use and the Privacy Policy and apply together with them.`,
    "We chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, legal-bundle version, and timestamp to demonstrate authorization. This is the service operator's chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.",
    "This version consists of a neutral body and the immutable DeepSeek and MiMo provider annexes below. The actual route used for a request is disclosed read-only before transmission; the interface does not provide a provider selector.",
  ],
  sections: [
    {
      heading: "The AI Polish Feature",
      body: [
        "AI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.",
        "When you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).",
        "Routing is determined by server-side configuration and request time. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request.",
      ],
    },
    {
      heading: "What Is Sent",
      body: [
        "We do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.",
        "We never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.",
        "Before each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:",
      ],
      bullets: [
        "Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.",
        "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.",
        "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels.",
      ],
    },
    {
      heading: "What We Store",
      body: [
        "We do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.",
        "We keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, the AI provider's request ID, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.",
        "Request metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account.",
      ],
    },
    {
      heading: "Usage Limits, Quota, and Cancellation",
      body: [
        "AI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.",
        "Quota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service's settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider.",
      ],
    },
    {
      heading: "Providers, Routing, and Policy Changes",
      body: [
        "The current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.",
        "Each third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.",
        "If we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle.",
      ],
    },
    {
      heading: "AI Output Requires Your Review",
      body: [
        "AI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.",
        "Polished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.",
      ],
    },
    {
      heading: "Encryption and AI Polish",
      body: [
        "End-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish.",
        "When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.",
      ],
    },
    providerAnnexSection("Official DeepSeek Open Platform", deepseekLegalManifest),
    providerAnnexSection(
      "Official MiMo API (mainland-China profile)",
      mimoLegalManifest,
    ),
    {
      heading: "Changes",
      body: [
        "We may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again.",
      ],
    },
    {
      heading: "Contact",
      body: [
        `For questions about these AI Service Terms, contact ${SERVICE_OPERATOR}.`,
        `Email: ${SERVICE_CONTACT_EMAIL}`,
        `Website: ${SERVICE_WEBSITE}`,
      ],
    },
  ],
};
