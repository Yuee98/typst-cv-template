import {
  SERVICE_CONTACT_EMAIL,
  SERVICE_NAME,
  SERVICE_OPERATOR,
  SERVICE_WEBSITE,
} from "./constants";
import type { LegalDocument } from "./types";

export const LEGAL_EFFECTIVE_DATE = "July 3, 2026";

export const AI_TERMS_EFFECTIVE_DATE = "August 2, 2026";

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
  effectiveDate: LEGAL_EFFECTIVE_DATE,
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

export const aiTermsDocument: LegalDocument = {
  title: "AI Service Terms",
  effectiveDate: AI_TERMS_EFFECTIVE_DATE,
  intro: [
    `These AI Service Terms govern your use of the AI polish feature of ${SERVICE_NAME} at ${SERVICE_WEBSITE}. They apply in addition to the Terms of Use and the Privacy Policy.`,
    "You must accept these AI Service Terms before using AI polish. Your acceptance (user ID, document version, and timestamp) is recorded so we can demonstrate that consent was given.",
  ],
  sections: [
    {
      heading: "The AI Polish Feature",
      body: [
        "AI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.",
        "When you confirm a polish request, the text you selected, together with any surrounding context you choose to include, is sent through our server to a third-party AI provider for processing.",
      ],
    },
    {
      heading: "What Is Sent",
      body: [
        "We do not actively send the name, email address, or phone number from your resume header. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.",
        "Before each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share.",
      ],
    },
    {
      heading: "What We Store",
      body: [
        "We do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.",
        "We keep metadata logs about each request, such as timestamps, user ID, feature settings, request counts, token usage, latency, and status or error codes. These logs never include your resume text, the AI output, or your style instructions.",
        "Metadata logs are retained for up to 90 days and then deleted. Records of your acceptance of these AI Service Terms are kept until you delete your account.",
      ],
    },
    {
      heading: "Third-Party AI Provider",
      body: [
        "AI polish is powered by DeepSeek, a third-party AI provider. The content you send is processed by DeepSeek under its own terms and privacy policy, which we do not control.",
        "We do not make any representation or guarantee about how DeepSeek retains, uses, or deletes the content it receives, including whether that content is used to train models. If this is a concern, do not include sensitive information in polish requests, or do not use the feature.",
        "We may change the AI provider in the future. If we do, we will update these terms and, where required, ask you to accept the updated version before continuing to use the feature.",
      ],
    },
    {
      heading: "AI Output Requires Your Review",
      body: [
        "AI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.",
        "Polished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.",
        "Usage limits apply to AI polish, such as daily request limits and rate limits. We may suspend access in cases of abuse, excessive use, or risk to the service.",
      ],
    },
    {
      heading: "Encryption and AI Polish",
      body: [
        "End-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish.",
        "When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.",
      ],
    },
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
