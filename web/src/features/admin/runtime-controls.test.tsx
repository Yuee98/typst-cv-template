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
function mount(enabled = false) {
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
    return actor.ready ? <AdminRuntimeControls client={client} actor={actor} context={context} locale="en" onCommitted={onCommitted} /> : null;
  }
  render(<Harness />);
  return {
    onCommitted,
    context
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
  it("retains settings when the live server requires TOTP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "STEP_UP_REQUIRED"
      }
    }), {
      status: 403
    })));
    mount();
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
    await screen.findByText("STEP_UP_REQUIRED");
    expect((screen.getByLabelText("Requests per user / UTC day") as HTMLInputElement).value).toBe("25");
  });
});
