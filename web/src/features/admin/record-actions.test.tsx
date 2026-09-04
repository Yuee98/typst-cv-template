// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./messages";
import { AdminRecordActions } from "./record-actions";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "user@example.test",
  isAdmin: false,
  revision: null,
};
const committed = {
  schemaVersion: "admin_committed_operation_v1",
  operationId: "22222222-2222-4222-8222-222222222222",
  operationKind: "admin_membership_set",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  result: {
    schemaVersion: "admin_membership_result_v1",
    userId: user.id,
    enabled: true,
    revision: "1",
  },
  auditId: "44444444-4444-4444-8444-444444444444",
  committedAt: "2026-09-04T00:00:00.000Z",
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminRecordActions", () => {
  it("submits a user-scoped mutation with the current bearer token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(committed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <AdminRecordActions
        section="users"
        row={user}
        accessToken="current-user-token"
        writesEnabled
        onRefresh={vi.fn()}
        t={adminMessages.en}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(adminMessages.en.mutationReason), {
      target: { value: "grant reviewed access" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: adminMessages.en.grantAdmin }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer current-user-token",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operation: "membership_set",
      targetUserId: user.id,
      enabled: true,
      expectedRevision: "0",
      reason: "grant reviewed access",
    });
    expect(await screen.findByText(adminMessages.en.mutationCommitted)).toBeTruthy();
    expect(screen.getByText(new RegExp(committed.auditId))).toBeTruthy();
  });

  it("retains the same idempotency key after response loss", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("response lost"));
    render(
      <AdminRecordActions
        section="users"
        row={user}
        accessToken="current-user-token"
        writesEnabled
        onRefresh={vi.fn()}
        t={adminMessages.en}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(adminMessages.en.mutationReason), {
      target: { value: "grant reviewed access" },
    });
    const button = screen.getByRole("button", {
      name: adminMessages.en.grantAdmin,
    });
    fireEvent.click(button);
    await screen.findByText(adminMessages.en.retryOriginal);
    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const bodies = vi.mocked(fetch).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as { idempotencyKey: string },
    );
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
  });

  it("keeps controls disabled while DB authority is dark", () => {
    render(
      <AdminRecordActions
        section="users"
        row={user}
        accessToken="current-user-token"
        writesEnabled={false}
        onRefresh={vi.fn()}
        t={adminMessages.zh}
      />,
    );
    expect(screen.getByText(adminMessages.zh.writesUnavailable)).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: adminMessages.zh.grantAdmin,
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
