import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col gap-4 px-4 pb-4">{children}</div>
    </main>
  );
}

export function Workspace({ editor, preview }: { editor: ReactNode; preview: ReactNode }) {
  return (
    <div className="workspace grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(520px,0.92fr)_minmax(620px,1.08fr)]">
      <div className="editor-column min-h-0">{editor}</div>
      <div className="preview-column min-h-0">{preview}</div>
    </div>
  );
}
