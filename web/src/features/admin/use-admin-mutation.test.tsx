// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useAdminSession } from "./admin-session";
import { useAdminMutation } from "./use-admin-mutation";
import { configurationFixture } from "./admin-test-fixtures";
const instance = "00000000-0000-4000-8000-000000000001";
const keys = ["00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"];
function payload(index: number) { const config = configurationFixture(); return { operation: "admin_configuration_save", contract_code: "cv_app_db_2", database_instance_id: instance, operation_key: keys[index], reason: "Save AI configuration", id: null, expected_revision: null, name: config.name, display_name: config.display_name, adapter_id: config.adapter_id, endpoint_url: config.endpoint_url, model_id: config.model_id, credential_ref: config.credential_ref, legal_document_id: config.legal_document_id, enabled: config.enabled, price: config.price }; }
function runtimePayload(index: number, enabled = true) {
  return {
    operation: "admin_ai_update", contract_code: "cv_app_db_2", database_instance_id: instance,
    operation_key: keys[index], reason: "Save runtime controls", expected_revision: "1",
    enabled, audience: "ALLOWLIST", user_daily_limit: "20", global_daily_limit: "2000", user_minute_limit: "3"
  };
}
function harness() {
  const client = { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "token", user: { id: "A" } } }, error: null }), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) } } as unknown as SupabaseClient;
  const onCommitted = vi.fn();
  return { ...renderHook(() => { const actor = useAdminSession(client); return { actor, mutation: useAdminMutation(client, actor, onCommitted) }; }), onCommitted };
}
const error = (code: string, status: number, reason?: string) => new Response(JSON.stringify({ error: { code, ...(reason ? { reason } : {}) } }), { status });
const success = () => new Response(JSON.stringify({ operation_id: "20", operation: "configuration_save", entity_kind: "configurations", entity_id: "3", revision: "1", time_committed: "2026-11-08T00:00:00Z" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Admin mutation retry identity", () => {
  it("keeps an unknown CREATE frozen through a retry's transient 4xx", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Response lost after commit")).mockResolvedValueOnce(error("INVALID_REQUEST", 400, "CREDENTIAL_UNAVAILABLE")).mockResolvedValueOnce(success()); vi.stubGlobal("fetch", fetcher);
    const h = harness(); await waitFor(() => expect(h.result.current.actor.ready).toBe(true));
    await act(() => h.result.current.mutation.submit(payload(0))); expect(h.result.current.mutation.uncertain).toBe(true);
    await act(() => h.result.current.mutation.submit(payload(1))); const stillUnknown = h.result.current.mutation.uncertain; const unresolvedError = h.result.current.mutation.error;
    await act(() => h.result.current.mutation.submit(payload(2)));
    const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body))); expect(sent).toHaveLength(3); expect(sent[1]).toEqual(sent[0]); expect(sent[2]).toEqual(sent[0]); expect(stillUnknown).toBe(true); expect(unresolvedError).toBe("RESULT_UNKNOWN"); expect(h.onCommitted).toHaveBeenCalledOnce(); expect(h.result.current.mutation.uncertain).toBe(false);
  });
  it.each(["CREDENTIAL_UNAVAILABLE", "ENDPOINT_INVALID", "ENDPOINT_UNREACHABLE"])("uses the safe configuration failure reason %s", async reason => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(error("INVALID_REQUEST", 400, reason)));
    const h = harness(); await waitFor(() => expect(h.result.current.actor.ready).toBe(true));
    await act(() => h.result.current.mutation.submit(payload(0)));
    expect(h.result.current.mutation.error).toBe(reason); expect(h.result.current.mutation.uncertain).toBe(false);
  });
  it.each(["UNRECOGNIZED_REASON", "Private stack at /internal/config", "CREDENTIAL_UNAVAILABLE\nextra text"])("does not expose arbitrary backend reason %s", async reason => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(error("INVALID_REQUEST", 400, reason)));
    const h = harness(); await waitFor(() => expect(h.result.current.actor.ready).toBe(true));
    await act(() => h.result.current.mutation.submit(payload(0)));
    expect(h.result.current.mutation.error).toBe("INVALID_REQUEST"); expect(h.result.current.mutation.uncertain).toBe(false);
  });
  it.each(["LEGAL_UNAVAILABLE", "FALLBACK_REQUIRED", "INVALID_ROUTING_GRAPH"])("uses the safe runtime failure reason %s", async reason => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(error("INVALID_REQUEST", 400, reason)));
    const h = harness(); await waitFor(() => expect(h.result.current.actor.ready).toBe(true));
    await act(() => h.result.current.mutation.submit(runtimePayload(0)));
    expect(h.result.current.mutation.error).toBe(reason);
    expect(h.result.current.mutation.uncertain).toBe(false);
  });
  it.each(["CREDENTIAL_UNAVAILABLE", "Private runtime state", "INVALID_ROUTING_GRAPH\nextra text"])("rejects out-of-scope or arbitrary runtime reason %s", async reason => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(error("INVALID_REQUEST", 400, reason)));
    const h = harness(); await waitFor(() => expect(h.result.current.actor.ready).toBe(true));
    await act(() => h.result.current.mutation.submit(runtimePayload(0)));
    expect(h.result.current.mutation.error).toBe("INVALID_REQUEST");
  });
  it("keeps an unknown runtime operation frozen through clearError and a later validation refusal", async () => {
    const receipt = new Response(JSON.stringify({ operation_id: "21", operation: "ai_update", entity_kind: "runtime_control", entity_id: "1", revision: "2", time_committed: "2026-11-09T00:00:00Z" }));
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Response lost after commit")).mockResolvedValueOnce(error("INVALID_REQUEST", 400, "FALLBACK_REQUIRED")).mockResolvedValueOnce(receipt);
    vi.stubGlobal("fetch", fetcher);
    const h = harness(); await waitFor(() => expect(h.result.current.actor.ready).toBe(true));
    await act(() => h.result.current.mutation.submit(runtimePayload(0)));
    act(() => h.result.current.mutation.clearError());
    expect(h.result.current.mutation.error).toBe("RESULT_UNKNOWN");
    expect(h.result.current.mutation.uncertain).toBe(true);
    await act(() => h.result.current.mutation.submit(runtimePayload(1, false)));
    expect(h.result.current.mutation.error).toBe("RESULT_UNKNOWN");
    expect(h.result.current.mutation.uncertain).toBe(true);
    await act(() => h.result.current.mutation.submit(runtimePayload(2, false)));
    const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(sent).toEqual([runtimePayload(0), runtimePayload(0), runtimePayload(0)]);
    expect(h.onCommitted).toHaveBeenCalledOnce();
    expect(h.result.current.mutation.uncertain).toBe(false);
  });
});
