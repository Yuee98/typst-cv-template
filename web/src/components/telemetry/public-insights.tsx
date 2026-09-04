"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { filterPublicEvent } from "./public-event";

// Mounted by public pages only. The callback remains a boundary even if an
// already-injected tracker survives a client navigation into a private page.
function beforeSend<T extends { url: string }>(event: T): T | null {
  return filterPublicEvent(event, window.location.href);
}

export function PublicInsights() {
  return <><Analytics beforeSend={beforeSend} /><SpeedInsights beforeSend={beforeSend} /></>;
}
