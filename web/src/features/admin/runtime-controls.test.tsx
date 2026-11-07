// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminRuntimeControls } from "./runtime-controls";
import type { AdminContext } from "@/lib/admin/contract";
const context: AdminContext = {
  ready: true,
  capabilities: [],
  environment: "LOCAL",
  database_instance_id: "00000000-0000-4000-8000-000000000001",
  contract_code: "cv_app_db_1",
  member_id: "adm_0123456789AB",
  aal: "aal1",
  control: {
    enabled: false,
    active_policy_version_id: null,
    audience: "ALLOWLIST",
    generation: "1",
    close_cycle: "1",
    revision: "1",
    user_daily_limit: "20",
    global_daily_limit: "2000",
    user_minute_limit: "3"
  },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("readback", () => {
  it("requests server-produced evidence without letting the browser submit passed", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "NOT_READY"
      }
    }), {
      status: 409
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<AdminRuntimeControls context={context} accessToken="token" locale="en" onCommitted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", {
      name: "Check current policy"
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toEqual({
      operation: "readback",
      contract_code: "cv_app_db_1",
      database_instance_id: context.database_instance_id
    });
  });
});
