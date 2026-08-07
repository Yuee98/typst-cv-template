// @vitest-environment jsdom

import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  loadTrustDeviceMock,
  renderCloudSync,
  sessionB,
  supabase,
} from "./harness";

describe("useCvCloudSync session boundaries", () => {
  it("clears cloud-only state on sign-out", () => {
    const h = renderCloudSync({ sessionValue: null });

    expect(h.removeCloudSummaries).toHaveBeenCalledTimes(1);
    expect(h.termsGate.reset).toHaveBeenCalledTimes(1);
    expect(h.setTermsAccepted).toHaveBeenCalledWith(false);
    expect(h.setCloudStatus).toHaveBeenCalledWith("idle");
    expect(h.refetchDocuments).not.toHaveBeenCalled();
  });

  it("restores trusted-device state and refreshes documents only after terms acceptance", async () => {
    loadTrustDeviceMock.mockReturnValue(true);
    const h = renderCloudSync();

    await waitFor(() => expect(h.refetchDocuments).toHaveBeenCalledTimes(1));

    expect(loadTrustDeviceMock).toHaveBeenCalledWith("user-1");
    expect(h.setTrustDevice).toHaveBeenCalledWith(true);
    expect(h.termsGate.refresh).toHaveBeenCalledWith(supabase);
    expect(h.setCloudStatus).toHaveBeenCalledWith("loading");
    expect(h.setCloudStatus).toHaveBeenCalledWith("ready");
  });

  it("removes cloud summaries when current terms are not accepted", async () => {
    const h = renderCloudSync({ termsRefresh: false });

    await waitFor(() => expect(h.removeCloudSummaries).toHaveBeenCalledTimes(2));
    expect(h.refetchDocuments).not.toHaveBeenCalled();
    expect(h.setCloudStatus).toHaveBeenCalledWith("idle");
  });

  it("ignores a late terms result after unmount", async () => {
    let resolveTerms!: (accepted: boolean) => void;
    const termsRefresh = new Promise<boolean>((resolve) => {
      resolveTerms = resolve;
    });
    const h = renderCloudSync({ termsRefresh });
    h.hook.unmount();

    await act(async () => resolveTerms(true));
    expect(h.refetchDocuments).not.toHaveBeenCalled();
  });

  it("resets account-owned state on a direct signed-in user switch", async () => {
    const h = renderCloudSync({ termsRefresh: false });
    await waitFor(() => expect(h.termsGate.refresh).toHaveBeenCalledTimes(1));
    h.removeCloudSummaries.mockClear();
    h.layoutBoundaryObservations.length = 0;
    h.termsGate.reset.mockClear();
    h.setCloudStatus.mockClear();

    h.rerenderSession(sessionB);

    expect(h.layoutBoundaryObservations[0]).toBe(1);
    expect(h.removeCloudSummaries).toHaveBeenCalled();
    expect(h.termsGate.reset).toHaveBeenCalledTimes(1);
    expect(h.setTermsAccepted).toHaveBeenLastCalledWith(false);
    expect(h.setCloudStatus).toHaveBeenCalledWith("idle");
    expect(loadTrustDeviceMock).toHaveBeenLastCalledWith("user-2");
  });

  it("ignores user A terms completion after switching directly to user B", async () => {
    let resolveTerms!: (accepted: boolean) => void;
    const pendingTerms = new Promise<boolean>((resolve) => {
      resolveTerms = resolve;
    });
    const h = renderCloudSync({ termsRefresh: pendingTerms });

    h.termsGate.refresh.mockResolvedValueOnce(false);
    h.rerenderSession(sessionB);
    await act(async () => resolveTerms(true));

    expect(h.refetchDocuments).not.toHaveBeenCalled();
    expect(h.setCloudStatus).not.toHaveBeenCalledWith("ready");
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("ignores user A document refresh completion after switching directly to user B", async () => {
    let rejectRefetch!: (error: Error) => void;
    const pendingRefetch = new Promise<never>((_resolve, reject) => {
      rejectRefetch = reject;
    });
    const h = renderCloudSync();
    h.refetchDocuments.mockImplementationOnce(() => pendingRefetch);

    await waitFor(() => expect(h.refetchDocuments).toHaveBeenCalledTimes(1));
    h.termsGate.refresh.mockResolvedValueOnce(false);
    h.rerenderSession(sessionB);
    await act(async () => rejectRefetch(new Error("stale user A refresh")));

    expect(h.setCloudStatus).not.toHaveBeenCalledWith("error");
    expect(h.onError).not.toHaveBeenCalledWith("stale user A refresh");
    expect(h.setCloudStatus).not.toHaveBeenCalledWith("ready");
  });
});
