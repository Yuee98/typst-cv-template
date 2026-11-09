import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <main className="cv-app-shell relative bg-bg text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-48 -left-40 size-[64rem] rounded-full bg-blue-600/0 blur-[128px] dark:bg-blue-600/[0.18]" />
        <div className="absolute -bottom-56 -right-40 size-[64rem] rounded-full bg-rose-500/0 blur-[128px] dark:bg-rose-500/[0.14]" />
      </div>
      <div className="cv-app-shell-inner relative mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-4 pb-4">
        {children}
      </div>
    </main>
  );
}

export function Workspace({
  library,
  editor,
  preview,
}: {
  library?: ReactNode;
  editor: ReactNode;
  preview: ReactNode;
}) {
  return (
    <div className="workspace flex min-w-0 gap-4">
      {library}
      <div className="workspace-panes flex min-w-0 flex-1 flex-wrap gap-4">
        <div id="cv-editor" tabIndex={-1} className="editor-column min-w-0 outline-none">{editor}</div>
        <div id="cv-preview" tabIndex={-1} className="preview-column min-w-0 outline-none">{preview}</div>
      </div>
    </div>
  );
}
