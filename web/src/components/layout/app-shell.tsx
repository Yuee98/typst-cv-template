import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <main className="h-full bg-slate-100 text-slate-950">
      <div className="mx-auto flex h-full w-full max-w-[1800px] flex-col gap-4 overflow-hidden px-4 pb-4">{children}</div>
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
    <div className="workspace flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      {library && <div className="library-column shrink-0">{library}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(500px,0.92fr)_minmax(600px,1.08fr)]">
        <div className="editor-column min-h-0">{editor}</div>
        <div className="preview-column min-h-0">{preview}</div>
      </div>
    </div>
  );
}
