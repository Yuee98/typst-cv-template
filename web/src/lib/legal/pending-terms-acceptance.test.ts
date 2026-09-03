// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { AI_TERMS_VERSION, TERMS_VERSION } from "@/content/legal";
import {
  claimPendingTermsAcceptance,
  clearPendingTermsAcceptance,
  createTermsAcceptanceFlowId,
  markPendingTermsAcceptance,
} from "@/lib/legal/pending-terms-acceptance";

const storageKey = "typst-cv-builder:pending-terms-acceptance";

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/en");
});

describe("pending terms acceptance", () => {
  it("stores only a digest for password and OAuth signup identifiers", async () => {
    await markPendingTermsAcceptance({ userId: "user-a" });
    const passwordMarker = window.sessionStorage.getItem(storageKey);

    expect(passwordMarker).not.toContain("user-a");
    expect(JSON.parse(passwordMarker ?? "{}")).toEqual({
      kind: "password",
      userIdHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      version: TERMS_VERSION,
    });

    await markPendingTermsAcceptance({ oauthFlowId: "oauth-flow-a" });
    const oauthMarker = window.sessionStorage.getItem(storageKey);

    expect(oauthMarker).not.toContain("oauth-flow-a");
    expect(JSON.parse(oauthMarker ?? "{}")).toEqual({
      kind: "oauth",
      oauthFlowHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      version: TERMS_VERSION,
    });
    expect(TERMS_VERSION).not.toBe(AI_TERMS_VERSION);
  });

  it("lets only the matching password account consume the marker", async () => {
    await markPendingTermsAcceptance({ userId: "user-a" });

    await expect(claimPendingTermsAcceptance("user-b")).resolves.toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    await expect(claimPendingTermsAcceptance("user-a")).resolves.toBe(true);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("requires the matching OAuth callback flow before consuming the marker", async () => {
    await markPendingTermsAcceptance({ oauthFlowId: "oauth-flow-a" });
    window.history.replaceState({}, "", "/en?terms_acceptance_flow=oauth-flow-b");

    await expect(claimPendingTermsAcceptance("callback-user")).resolves.toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();

    window.history.replaceState({}, "", "/en?terms_acceptance_flow=oauth-flow-a");
    await expect(claimPendingTermsAcceptance("callback-user")).resolves.toBe(true);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("serializes competing claims so a marker can be consumed only once", async () => {
    await markPendingTermsAcceptance({ userId: "user-a" });

    await expect(Promise.all([
      claimPendingTermsAcceptance("user-a"),
      claimPendingTermsAcceptance("user-a"),
    ])).resolves.toEqual([true, false]);
  });

  it("clears malformed, stale, and explicitly abandoned markers", async () => {
    window.sessionStorage.setItem(storageKey, "not-json");
    await expect(claimPendingTermsAcceptance("user-a")).resolves.toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();

    window.sessionStorage.setItem(storageKey, JSON.stringify({
      kind: "password",
      userIdHash: "stale",
      version: "stale-version",
    }));
    await expect(claimPendingTermsAcceptance("user-a")).resolves.toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();

    await markPendingTermsAcceptance({ userId: "user-a" });
    clearPendingTermsAcceptance();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("creates opaque, unique OAuth flow identifiers", () => {
    const first = createTermsAcceptanceFlowId();
    const second = createTermsAcceptanceFlowId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).not.toBe(first);
  });
});
