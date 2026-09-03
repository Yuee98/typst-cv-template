// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./messages";
import { AdminRuntimeControls } from "./runtime-controls";

const state = {
  schemaVersion: "admin_ai_control_state_v1" as const,
  aiEnabled: true,
  globalDailyLimit: 25,
  activePolicyVersionId: "11111111-1111-4111-8111-111111111111",
  configGeneration: "4",
  controlRevision: "7",
  closingCycleId: null,
  closedAt: null,
  reopenedAt: null,
  writesEnabled: true,
};
const committed = {
  schemaVersion: "admin_committed_operation_v1",
  operationId: "22222222-2222-4222-8222-222222222222",
  operationKind: "ai_disable",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  result: {
    schemaVersion: "admin_ai_control_result_v1",
    aiEnabled: false,
    controlRevision: "8",
    closingCycleId: "44444444-4444-4444-8444-444444444444",
    configGeneration: "4",
    activePolicyVersionId: state.activePolicyVersionId,
  },
  auditId: "55555555-5555-4555-8555-555555555555",
  committedAt: "2026-09-04T00:00:00.000Z",
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminRuntimeControls", () => {
  it("requires the exact environment confirmation and preserves bigint revisions", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(committed), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const refresh = vi.fn();
    render(<AdminRuntimeControls state={state} environment="production" locale="en" accessToken="current-admin-jwt" writesEnabled onRefresh={refresh} t={adminMessages.en} />);
    const group = screen.getByRole("group", { name: adminMessages.en.disableAi });
    const button = within(group).getByRole("button", { name: adminMessages.en.disableAi });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(group).getByLabelText(adminMessages.en.confirmation), { target: { value: "production" } });
    fireEvent.change(within(group).getByLabelText(adminMessages.en.mutationReason), { target: { value: "reviewed maintenance" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer current-admin-jwt");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operation: "disable_ai",
      expectedControlRevision: "7",
      reason: "reviewed maintenance",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(await within(group).findByText(adminMessages.en.mutationCommitted)).toBeTruthy();
  });

  it("keeps every runtime operation disabled when authority is dark", () => {
    render(<AdminRuntimeControls state={{ ...state, writesEnabled: false }} environment="preview" locale="zh" accessToken="token" writesEnabled={false} onRefresh={vi.fn()} t={adminMessages.zh} />);
    for (const name of [
      adminMessages.zh.setDailyLimit,
      adminMessages.zh.disableAi,
      adminMessages.zh.setPointer,
      adminMessages.zh.clearPointer,
      adminMessages.zh.recordReadback,
      adminMessages.zh.reopenAi,
    ]) {
      const group = screen.getByRole("group", { name });
      expect((within(group).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
