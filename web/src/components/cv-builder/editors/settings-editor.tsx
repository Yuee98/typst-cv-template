"use client";

import { X } from "lucide-react";
import { useFormContext } from "react-hook-form";

import { useLocalFonts, loadLocalFontData } from "@/lib/typst/font-access";
import { addFontFromData } from "@/lib/typst/render";
import type { CvData } from "@/lib/cv/schema";

const CUSTOM_FONT_SENTINEL = "__custom__";

export function FontSettingsEditor() {
  const { setValue, watch } = useFormContext<CvData>();
  const bodyFont = watch("bodyFont");
  const { supported: fontApiSupported, fonts: localFonts } = useLocalFonts();

  const isCustom = fontApiSupported && (bodyFont === CUSTOM_FONT_SENTINEL || !!bodyFont);

  const selectedFamilies = new Set(
    bodyFont && bodyFont !== CUSTOM_FONT_SENTINEL
      ? bodyFont.split(",").map((f) => f.trim()).filter(Boolean)
      : [],
  );

  const handleModeChange = (custom: boolean) => {
    setValue("bodyFont", custom ? CUSTOM_FONT_SENTINEL : undefined, { shouldDirty: true });
  };

  const handleFontToggle = (family: string, checked: boolean) => {
    const next = new Set(selectedFamilies);
    if (checked) {
      next.add(family);
    } else {
      next.delete(family);
    }

    const fontValue = next.size === 0 ? CUSTOM_FONT_SENTINEL : [...next].join(", ");
    setValue("bodyFont", fontValue, { shouldDirty: true });

    if (next.size > 0) {
      void loadLocalFontData([...next]).then((dataArray) => {
        for (const data of dataArray) void addFontFromData(data);
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Font</div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="bodyFontMode"
              checked={!isCustom}
              onChange={() => handleModeChange(false)}
              className="accent-slate-900"
            />
            Liberation Serif + Noto Serif CJK SC
          </label>
          {fontApiSupported && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="bodyFontMode"
                checked={isCustom}
                onChange={() => handleModeChange(true)}
                className="accent-slate-900"
              />
              Custom font
            </label>
          )}
        </div>
      </div>

      {isCustom && (
        <div className="space-y-3 pl-6">
          {fontApiSupported && localFonts.length > 0 ? (
            <>
              <p className="text-xs text-slate-400">
                Select fonts from your device. Pick one for Latin + one for CJK, or type below.
              </p>
              <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-slate-200 p-2">
                {localFonts.map((f) => (
                  <label key={f.family} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedFamilies.has(f.family)}
                      onChange={(e) => handleFontToggle(f.family, e.target.checked)}
                      className="accent-slate-900"
                    />
                    {f.family}
                  </label>
                ))}
              </div>
              {selectedFamilies.size > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {[...selectedFamilies].map((family) => (
                    <span
                      key={family}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700"
                    >
                      {family}
                      <button
                        type="button"
                        onClick={() => handleFontToggle(family, false)}
                        className="text-slate-400 hover:text-slate-700"
                        aria-label={`Remove ${family}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-slate-400">
              Font Access API not available. Use Chrome for local font selection.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
