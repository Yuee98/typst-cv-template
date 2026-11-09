// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AdminRuntimeControls } from "./runtime-controls";
import { useAdminSession } from "./admin-session";
import { adminContextFixture } from "./admin-test-fixtures";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(enabled = false, locale: "en" | "zh" = "en") {
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: "token",
            user: {
              id: "A"
            }
          }
        },
        error: null
      }),
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn()
          }
        }
      }))
    }
  } as unknown as SupabaseClient;
  const context = adminContextFixture();
  context.control.enabled = enabled;
  const onCommitted = vi.fn();
  function Harness() {
    const actor = useAdminSession(client);
    return actor.ready ? <AdminRuntimeControls client={client} actor={actor} context={context} locale={locale} onCommitted={onCommitted} /> : null;
  }
  const view = render(<Harness />);
  return {
    onCommitted,
    context,
    rerender: () => view.rerender(<Harness />)
  };
}
describe("runtime list and settings dialog", () => {
  it("keeps the list compact and edits settings in a dialog", async () => {
    mount();
    await screen.findByText("AI service settings");
    expect(screen.queryByLabelText("Audience")).toBeNull();
    fireEvent.click(screen.getByRole("button", {
      name: "View"
    }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByLabelText("Audience")).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {
      name: "Edit"
    }));
    expect(screen.getByLabelText("Audience")).toBeTruthy();
  });
  it("saves a current row once with automatic reason and hidden CAS", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      operation_id: "10",
      operation: "ai_update",
      entity_kind: "runtime_control",
      entity_id: "1",
      revision: "2",
      time_committed: "2026-11-08T00:00:00Z"
    })));
    vi.stubGlobal("fetch", fetcher);
    const {
      onCommitted
    } = mount();
    fireEvent.click(await screen.findByRole("button", {
      name: "Edit"
    }));
    fireEvent.change(screen.getByLabelText("Requests per user / UTC day"), {
      target: {
        value: "25"
      }
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Save"
    }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({
      operation: "admin_ai_update",
      user_daily_limit: "25",
      expected_revision: "1",
      reason: "Save runtime controls"
    });
    expect(body).not.toHaveProperty("readback_id");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("disables in one action using a dedicated idempotent operation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      operation_id: "11",
      operation: "ai_disable",
      entity_kind: "runtime_control",
      entity_id: "1",
      revision: "2",
      time_committed: "2026-11-08T00:00:00Z"
    })));
    vi.stubGlobal("fetch", fetcher);
    mount(true);
    fireEvent.click(await screen.findByRole("button", {
      name: "Emergency disable AI"
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      operation: "admin_ai_disable",
      reason: "Emergency disable AI"
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retains settings when the current revision conflicts", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "CONFLICT"
      }
    }), {
      status: 409
    })).mockResolvedValueOnce(new Response(JSON.stringify({ operation_id: "10", operation: "ai_update", entity_kind: "runtime_control", entity_id: "1", revision: "3", time_committed: "2026-11-09T00:00:00Z" })));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { context, onCommitted, rerender } = mount();
    fireEvent.click(await screen.findByRole("button", {
      name: "Edit"
    }));
    fireEvent.change(screen.getByLabelText("Requests per user / UTC day"), {
      target: {
        value: "25"
      }
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Save"
    }));
    await screen.findByText("These settings changed. Your edits are preserved. Refresh the settings and load the latest values before saving again.");
    expect((screen.getByLabelText("Requests per user / UTC day") as HTMLInputElement).value).toBe("25");
    fireEvent.click(screen.getByRole("button", { name: "Refresh settings" }));
    expect(onCommitted).toHaveBeenCalledOnce();
    context.control = { ...context.control, revision: "2", user_daily_limit: "30" };
    rerender();
    expect((screen.getByLabelText("Requests per user / UTC day") as HTMLInputElement).value).toBe("25");
    fireEvent.click(screen.getByRole("button", { name: "Load latest" }));
    expect((screen.getByLabelText("Requests per user / UTC day") as HTMLInputElement).value).toBe("30");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(2));
    const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(sent[0].expected_revision).toBe("1");
    expect(sent[1]).toMatchObject({ expected_revision: "2", user_daily_limit: "30" });
  });
  it.each([
    ["LEGAL_UNAVAILABLE", "The Terms of Use or AI Service Terms are unavailable. Check that both are enabled before enabling AI.", "使用条款或 AI 服务条款不可用，请先确认两者均已启用，再开启 AI。"],
    ["FALLBACK_REQUIRED", "Enable a fallback in Time rules before enabling AI.", "请先到“时间规则”配置并启用兜底规则，再开启 AI。"],
    ["INVALID_ROUTING_GRAPH", "An enabled time rule refers to a disabled configuration or an invalid data-processing disclosure. Check AI configurations and Time rules.", "已启用的时间规则引用了未启用的 AI 配置，或其数据处理说明无效。请检查“AI 配置”和“时间规则”。"]
  ])("explains %s in both languages", async (reason, english, chinese) => {
    for (const locale of ["en", "zh"] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "INVALID_REQUEST", reason } }), { status: 400 })));
      mount(false, locale);
      fireEvent.click(await screen.findByRole("button", { name: locale === "en" ? "Edit" : "编辑" }));
      fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Save" : "保存" }));
      await screen.findByText(locale === "en" ? english : chinese);
      cleanup();
    }
  });
  it("clears a failed enable message when unchecked and then saves the exact disabled payload", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "INVALID_REQUEST", reason: "INVALID_ROUTING_GRAPH" } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operation_id: "10", operation: "ai_update", entity_kind: "runtime_control", entity_id: "1", revision: "2", time_committed: "2026-11-09T00:00:00Z" })));
    vi.stubGlobal("fetch", fetcher);
    const { onCommitted, context } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Enable AI"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText("Enable AI"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    const expected = {
      operation: "admin_ai_update", contract_code: "cv_app_db_2", database_instance_id: context.database_instance_id,
      operation_key: expect.any(String), reason: "Save runtime controls", expected_revision: "1",
      enabled: false, audience: "ALLOWLIST", user_daily_limit: "20", global_daily_limit: "2000", user_minute_limit: "3"
    };
    expect(sent).toEqual([{ ...expected, enabled: true }, expected]);
    expect(sent[0].operation_key).not.toBe(sent[1].operation_key);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps an unknown save locked and retries the original operation without changing fields", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operation_id: "10", operation: "ai_update", entity_kind: "runtime_control", entity_id: "1", revision: "2", time_committed: "2026-11-09T00:00:00Z" })));
    vi.stubGlobal("fetch", fetcher);
    const { context, rerender } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Enable AI"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Result unknown. Keep this dialog open and retry the same operation.");
    expect(screen.getByLabelText("Enable AI").closest("fieldset")?.disabled).toBe(true);
    context.control = { ...context.control, revision: "2", enabled: false };
    rerender();
    expect((screen.getByRole("button", { name: "Load latest" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same operation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1].enabled).toBe(true);
  });
  it.each(["numeric", "audience"] as const)("uses a friendly generic message and clears it when %s changes", async field => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "INVALID_REQUEST" } }), { status: 400 })));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("These settings could not be saved. Check the values and try again.");
    fireEvent.change(screen.getByLabelText(field === "numeric" ? "Requests per user / UTC day" : "Audience"), { target: { value: field === "numeric" ? "25" : "ALL" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
