// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

import {
  cloudSummary,
  mockActiveDocumentQuery,
  renderCloudSync,
} from "./harness";

describe("useCvCloudSync data and error handling", () => {
  it("lets the newest same-user refresh win when requests settle in reverse order", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const h = renderCloudSync({ sessionInitialized: false });
    h.refetchDocuments
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    let firstRefresh!: Promise<void>;
    let secondRefresh!: Promise<void>;

    act(() => {
      firstRefresh = h.hook.result.current.refreshCloudDocuments({ skipTermsCheck: true });
    });
    act(() => {
      secondRefresh = h.hook.result.current.refreshCloudDocuments({ skipTermsCheck: true });
    });

    await act(async () => {
      resolveSecond();
      await secondRefresh;
    });
    expect(h.setCloudStatus).toHaveBeenLastCalledWith("ready");

    await act(async () => {
      rejectFirst(new Error("older refresh failed"));
      await firstRefresh;
    });
    expect(h.setCloudStatus).toHaveBeenLastCalledWith("ready");
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("loads a restored draft while retaining server data as the baseline", () => {
    const serverData = cloneCvData(sampleCvDataEn);
    const draft = cloneCvData(sampleCvDataEn);
    draft.header.name = "Unsaved draft";
    mockActiveDocumentQuery({ data: { ...cloudSummary("cloud-1"), data: serverData }, error: null });
    const restored = renderCloudSync({ documentsData: [cloudSummary("cloud-1")], draft });

    expect(restored.upsertDocumentSummary).toHaveBeenCalledWith(expect.objectContaining({ id: "cloud-1" }));
    expect(restored.loadDataIntoForm).toHaveBeenCalledWith("cloud-1", draft, { baselineData: serverData });
    expect(restored.clearDraft).not.toHaveBeenCalled();
  });

  it("drops a draft that is identical to the server document", () => {
    const serverData = cloneCvData(sampleCvDataEn);
    mockActiveDocumentQuery({ data: { ...cloudSummary("cloud-1"), data: serverData }, error: null });
    const h = renderCloudSync({ documentsData: [cloudSummary("cloud-1")], draft: serverData });

    expect(h.clearDraft).toHaveBeenCalledWith("cloud-1");
    expect(h.loadDataIntoForm).toHaveBeenCalledWith("cloud-1", serverData, { baselineData: serverData });
  });

  it("reports active-query and explicit refresh failures", async () => {
    mockActiveDocumentQuery({ data: undefined, error: new Error("query failed") });
    const h = renderCloudSync({ sessionInitialized: false, refetchError: new Error("refresh failed") });

    expect(h.onError).toHaveBeenCalledWith("query failed");
    await act(async () => h.hook.result.current.refreshCloudDocuments());

    expect(h.setCloudStatus).toHaveBeenCalledWith("error");
    expect(h.onError).toHaveBeenCalledWith("refresh failed");
  });
});
