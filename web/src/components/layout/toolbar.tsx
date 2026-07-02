import type { ReactNode } from "react";

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 print:hidden">
      {children}
    </header>
  );
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function ToolbarTitle() {
  return (
    <div>
      <h1 className="text-base font-semibold text-slate-950">Typst CV Builder</h1>
      <p className="text-xs text-slate-500">Edit structured data, preview Typst SVG, print to PDF.</p>
    </div>
  );
}
