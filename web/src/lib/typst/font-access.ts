"use client";

import { useSyncExternalStore } from "react";

export interface LocalFont {
  family: string;
  fullName: string;
  style: string;
}

interface FontAccessWindow extends Window {
  queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontFace[]>;
}

interface FontFace {
  family: string;
  fullName: string;
  style: string;
  blob(): Promise<Blob>;
}

function getFontWindow(): FontAccessWindow | null {
  if (typeof window === "undefined" || !("queryLocalFonts" in window)) return null;
  return window as FontAccessWindow;
}

export function isFontAccessSupported(): boolean {
  return getFontWindow()?.queryLocalFonts != null;
}

export async function enumerateLocalFonts(): Promise<LocalFont[]> {
  const win = getFontWindow();
  if (!win?.queryLocalFonts) return [];

  try {
    const fonts = await win.queryLocalFonts();
    const seen = new Set<string>();
    const result: LocalFont[] = [];

    for (const font of fonts) {
      if (seen.has(font.family)) continue;
      seen.add(font.family);
      result.push({
        family: font.family,
        fullName: font.fullName,
        style: font.style,
      });
    }

    return result.sort((a, b) => a.family.localeCompare(b.family));
  } catch {
    return [];
  }
}

export async function loadLocalFontData(families: string[]): Promise<Uint8Array[]> {
  const win = getFontWindow();
  if (!win?.queryLocalFonts) return [];

  try {
    const allFonts = await win.queryLocalFonts();
    const familySet = new Set(families);
    const fontData: Uint8Array[] = [];

    for (const font of allFonts) {
      if (!familySet.has(font.family)) continue;
      const blob = await font.blob();
      fontData.push(new Uint8Array(await blob.arrayBuffer()));
    }

    return fontData;
  } catch {
    return [];
  }
}

// Module-level font store with change notification
interface FontStore {
  supported: boolean;
  fonts: LocalFont[];
}

let fontStore: FontStore = { supported: false, fonts: [] };
let fontStoreInitialized = false;
const listeners = new Set<() => void>();

function initFontStore() {
  if (fontStoreInitialized) return;
  fontStoreInitialized = true;
  if (!isFontAccessSupported()) return;

  fontStore = { supported: true, fonts: [] };
  void enumerateLocalFonts().then((fonts) => {
    fontStore = { supported: true, fonts };
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void) {
  initFontStore();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return fontStore;
}

export function useLocalFonts() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
