"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PolishScope } from "./scope-builder";

/**
 * Bridge between the editor entry buttons and the polish wiring owned by
 * cv-builder.tsx (unit 3.5): the buttons deep inside the section editors
 * declare a scope; the single handler decides whether to open the
 * PolishDialog (signed in) or the sign-in guidance (signed out).
 *
 * The context is null when the wiring is absent (e.g. the flag-off build
 * does not mount the provider); the entry buttons render nothing in that
 * case, so a missing provider can never strand a visible dead button.
 */
export interface PolishEntryContextValue {
  requestPolish: (scope: PolishScope) => void;
}

const PolishEntryContext = createContext<PolishEntryContextValue | null>(null);

export function PolishEntryProvider({
  value,
  children,
}: {
  value: PolishEntryContextValue;
  children: ReactNode;
}) {
  return <PolishEntryContext.Provider value={value}>{children}</PolishEntryContext.Provider>;
}

export function usePolishEntry(): PolishEntryContextValue | null {
  return useContext(PolishEntryContext);
}
