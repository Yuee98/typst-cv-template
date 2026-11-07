// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminRecordActions } from "./record-actions";
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
    revision: "9007199254740993",
    user_daily_limit: "20",
    global_daily_limit: "2000",
    user_minute_limit: "3"
  },
  legal: {}
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("admin operation form", () => {
  it("retains exactly the same key and payload after an uncertain response", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(init.body);
      throw new Error("lost response");
    }));
    render(<AdminRecordActions section="controls" context={context} accessToken="token" locale="en" onCommitted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: {
        value: "Emergency stop"
      }
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Submit"
    }));
    await screen.findByText(/Result unknown/);
    fireEvent.click(screen.getByRole("button", {
      name: "Retry same operation"
    }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toBe(requests[0]);
    expect(JSON.parse(requests[0]).expected_revision).toBe("9007199254740993");
    expect(JSON.parse(requests[0]).database_instance_id).toBe(context.database_instance_id);
  });
  it("allows only complete current policy candidates and explicit defaults", () => {
    render(<AdminRecordActions section="policies" context={context} accessToken="token" locale="en" onCommitted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Action"), {
      target: {
        value: "admin_policy_version_create"
      }
    });
    expect(screen.getByLabelText("options")).toBeTruthy();
    expect(screen.getByLabelText("rules")).toBeTruthy();
  });
});
