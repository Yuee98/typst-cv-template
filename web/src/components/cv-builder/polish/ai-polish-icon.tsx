/**
 * A three-part sparkle icon so each star can twinkle independently.
 * The overall silhouette stays close to Lucide's Sparkles icon while the
 * slightly wider spacing keeps the animation legible at the toolbar's 16px
 * icon size.
 */
export function AiPolishIcon() {
  return (
    <svg
      aria-hidden="true"
      className="ai-polish-icon"
      fill="none"
      focusable="false"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path
        className="ai-polish-icon__spark ai-polish-icon__spark--primary"
        d="M9.4 4.5c.36 3.2 2.5 5.34 5.7 5.7-3.2.36-5.34 2.5-5.7 5.7-.36-3.2-2.5-5.34-5.7-5.7 3.2-.36 5.34-2.5 5.7-5.7Z"
      />
      <path
        className="ai-polish-icon__spark ai-polish-icon__spark--upper"
        d="M18.5 2.1c.16 1.58 1.22 2.64 2.8 2.8-1.58.16-2.64 1.22-2.8 2.8-.16-1.58-1.22-2.64-2.8-2.8 1.58-.16 2.64-1.22 2.8-2.8Z"
      />
      <path
        className="ai-polish-icon__spark ai-polish-icon__spark--lower"
        d="M18.7 15.2c.16 1.58 1.22 2.64 2.8 2.8-1.58.16-2.64 1.22-2.8 2.8-.16-1.58-1.22-2.64-2.8-2.8 1.58-.16 2.64-1.22 2.8-2.8Z"
      />
    </svg>
  );
}
