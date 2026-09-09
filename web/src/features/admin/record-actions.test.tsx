// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const newProfileId = "55555555-5555-4555-8555-555555555555";
  const newVersionId = "66666666-6666-4666-8666-666666666666";
  const provider = {
    id: user.id, defaultAdapterId: "deepseek_chat_v1", defaultEndpointUrl: "https://api.deepseek.com/chat/completions",
    defaultCredentialEnvName: "AI_PROVIDER_KEY_FUTURE", defaultModelId: "future-model",
    adapterOptions: [{ adapterId: "deepseek_chat_v1", displayName: "DeepSeek Chat", wireApiKind: "chat_completions_v1" }],
  };
  const panel = (name: string) => within(screen.getByRole("heading", { name }).closest("section")!);
  const response = (result: Record<string, unknown>) => new Response(JSON.stringify({ ...committed, result }), { status: 200 });
  const versionResult = { schemaVersion: "admin_profile_version_result_v1", profileVersionId: newVersionId, profileId: newProfileId, version: 1, status: "draft", configSha256: "a".repeat(64) };

  it("hands a new identity to its first version and that version to its first price", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ schemaVersion: "admin_profile_identity_result_v1", profileId: newProfileId, profileKey: "new.profile", providerId: provider.id }))
      .mockResolvedValueOnce(response(versionResult))
      .mockResolvedValueOnce(response({ schemaVersion: "admin_price_version_result_v1", priceVersionId: user.id, profileVersionId: newVersionId, pricingLane: "future", version: 1, sealed: false }));
    const refresh = vi.fn();
    render(<AdminRecordActions section="providers" row={provider} accessToken="admin" draftsEnabled writesEnabled={false} onRefresh={refresh} t={adminMessages.en} />);
    const identity = panel(adminMessages.en.createProfileIdentity);
    fireEvent.change(identity.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "create identity" } });
    fireEvent.click(identity.getByRole("button", { name: adminMessages.en.createProfileIdentity }));
    await screen.findByRole("heading", { name: adminMessages.en.firstVersion });
    expect(screen.getByLabelText(adminMessages.en.profileId)).toHaveProperty("value", newProfileId);
    const version = panel(adminMessages.en.firstVersion);
    fireEvent.change(version.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "first version" } });
    fireEvent.click(version.getByRole("button", { name: adminMessages.en.createSuccessor }));
    await screen.findByRole("heading", { name: adminMessages.en.firstPrice });
    const price = panel(adminMessages.en.firstPrice);
    expect(price.getByText(new RegExp(newVersionId))).toBeTruthy();
    fireEvent.change(price.getByLabelText(adminMessages.en.pricingLane), { target: { value: "future" } });
    fireEvent.change(price.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "first price" } });
    fireEvent.click(price.getByRole("button", { name: adminMessages.en.createSuccessor }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    const bodies = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[1]).toMatchObject({ operation: "profile_version_create", profileId: newProfileId, expectedLatestVersion: "0", adapterId: "deepseek_chat_v1", wireApiKind: "chat_completions_v1", endpointUrl: provider.defaultEndpointUrl });
    expect(bodies[2]).toMatchObject({ operation: "price_version_create", profileVersionId: newVersionId, pricingLane: "future", expectedLatestVersion: "0" });
    expect(price.getByText(new RegExp(`${adminMessages.en.priceVersionId}: ${user.id}`))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: adminMessages.en.transitionStatus })).toBeNull();
    expect(screen.queryByRole("heading", { name: adminMessages.en.sealPrice })).toBeNull();
  });

  it("resumes a zero-version identity using its stable Profile ID", async () => {
    vi.mocked(fetch).mockResolvedValue(response(versionResult));
    render(<AdminRecordActions section="providers" row={provider} accessToken="admin" draftsEnabled writesEnabled={false} onRefresh={vi.fn()} t={adminMessages.en} />);
    fireEvent.change(screen.getByLabelText(adminMessages.en.profileId), { target: { value: newProfileId } });
    fireEvent.click(panel(adminMessages.en.prepareFirstVersion).getByRole("button", { name: adminMessages.en.apply }));
    const version = panel(adminMessages.en.firstVersion);
    fireEvent.change(version.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "resume" } });
    fireEvent.click(version.getByRole("button", { name: adminMessages.en.createSuccessor }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ profileId: newProfileId, expectedLatestVersion: "0" });
  });

  it("moves first-price preparation from the opened version to a newly created successor", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ...versionResult, version: 2 }));
    render(<AdminRecordActions section="profiles" row={{ id: user.id, profileId: newProfileId, latestVersion: "1" }} accessToken="admin" draftsEnabled writesEnabled={false} onRefresh={vi.fn()} t={adminMessages.en} />);
    expect(panel(adminMessages.en.firstPrice).getByText(new RegExp(user.id))).toBeTruthy();
    fireEvent.change(panel(adminMessages.en.firstPrice).getByLabelText(adminMessages.en.pricingLane), { target: { value: "old-form" } });
    const version = panel(adminMessages.en.createSuccessor);
    fireEvent.change(version.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "successor" } });
    fireEvent.click(version.getByRole("button", { name: adminMessages.en.createSuccessor }));
    await waitFor(() => expect(panel(adminMessages.en.firstPrice).getByText(new RegExp(newVersionId))).toBeTruthy());
    expect(panel(adminMessages.en.firstPrice).getByLabelText(adminMessages.en.pricingLane)).toHaveProperty("value", "default");
    fireEvent.change(version.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "prepare another version" } });
    expect(panel(adminMessages.en.firstPrice).getByText(new RegExp(newVersionId))).toBeTruthy();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ profileId: newProfileId, expectedLatestVersion: "1" });
  });

  it.each(["providers", "profiles", "prices", "policies"] as const)("enables %s preparation while runtime writes remain disabled", section => {
    render(<AdminRecordActions section={section} row={{}} accessToken="admin" draftsEnabled writesEnabled={false} onRefresh={vi.fn()} t={adminMessages.en} />);
    const create = screen.getByRole("heading", { name: section === "providers" ? adminMessages.en.createProfileIdentity : adminMessages.en.createSuccessor }).closest("section")!;
    expect(create.querySelector("fieldset")!.disabled).toBe(false);
    if (section !== "providers") {
      const lifecycle = screen.getByRole("heading", { name: section === "prices" ? adminMessages.en.sealPrice : adminMessages.en.transitionStatus }).closest("section")!;
      expect(lifecycle.querySelector("fieldset")!.disabled).toBe(true);
    }
  });

  it("saves a policy draft without report IDs and displays its audited result", async () => {
    const row = { id: user.id, policyKey: "draft.policy", latestVersion: "1", rules: { schemaVersion: "routing_rules_v1", windows: [] }, defaultProfileVersionId: user.id, legalBundleVersion: "future.legal", runtimeContractId: "runtime.test" };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...committed, operationKind: "routing_policy_draft_create", result: { schemaVersion: "admin_routing_policy_draft_result_v1", policyVersionId: user.id, policyKey: row.policyKey, version: 2, status: "draft", configSha256: "a".repeat(64) } }), { status: 200 }));
    render(<AdminRecordActions section="policies" row={row} accessToken="admin" draftsEnabled writesEnabled={false} onRefresh={vi.fn()} t={adminMessages.en} />);
    const create = within(screen.getByRole("heading", { name: adminMessages.en.createSuccessor }).closest("section")!);
    expect(create.queryByPlaceholderText(adminMessages.en.validationReports)).toBeNull();
    fireEvent.change(create.getByPlaceholderText(adminMessages.en.mutationReason), { target: { value: "prepare now" } });
    fireEvent.click(create.getByRole("button", { name: adminMessages.en.createSuccessor }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ operation: "routing_policy_draft_create", expectedLatestVersion: "1", reason: "prepare now" });
    expect(body).not.toHaveProperty("validationReportIds");
    expect(await create.findByText(adminMessages.en.mutationCommitted)).toBeTruthy();
    expect(create.getByText(new RegExp(committed.auditId))).toBeTruthy();
  });

  it("submits a user-scoped mutation with the current bearer token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(committed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <AdminRecordActions draftsEnabled
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
      <AdminRecordActions draftsEnabled
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
      <AdminRecordActions draftsEnabled
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
