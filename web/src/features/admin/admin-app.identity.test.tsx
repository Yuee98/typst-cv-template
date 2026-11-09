// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminContextFixture, configurationFixture } from "./admin-test-fixtures";
import { legalDisplayFixture } from "@/lib/legal/test-fixtures";
const state = vi.hoisted(() => ({
  client: null as unknown,
  listener: null as null | ((event: string, session: unknown) => void)
}));
// Theme/locale controls are exercised in the browser; this suite isolates
// administrator identity, draft ownership and query-cache transitions.
vi.mock("@/components/layout/toolbar/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/layout/toolbar/locale-switcher", () => ({ LocaleSwitcher: () => null }));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: () => state.client,
  getSupabaseConfig: () => ({
    url: "http://127.0.0.1:54321"
  })
}));
import AdminApp from "./admin-app";
const session = (user = "A", token = user) => ({
  access_token: token,
  user: {
    id: user,
    email: `${user}@example.test`
  }
});
const caches: QueryClient[] = [];
let getSession: ReturnType<typeof vi.fn>, signInWithOAuth: ReturnType<typeof vi.fn>;
let context = adminContextFixture(),
  configuration = configurationFixture();
let gate: Promise<void> | null,
  rejectRead = false;
function response(data: unknown) {
  return new Response(JSON.stringify({
    context,
    data
  }));
}
function view(element: ReactNode, cache = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false
    }
  }
})) {
  caches.push(cache);
  const rendered = render(<QueryClientProvider client={cache}>{element}</QueryClientProvider>);
  return {
    ...rendered,
    cache,
    rerender: (next: ReactNode) => rendered.rerender(<QueryClientProvider client={cache}>{next}</QueryClientProvider>)
  };
}
beforeEach(() => {
  context = adminContextFixture();
  configuration = configurationFixture();
  gate = null;
  rejectRead = false;
  getSession = vi.fn().mockResolvedValue({
    data: {
      session: session()
    },
    error: null
  });
  signInWithOAuth = vi.fn();
  state.client = {
    auth: {
      getSession,
      onAuthStateChange: vi.fn(callback => {
        state.listener = callback;
        return {
          data: {
            subscription: {
              unsubscribe: vi.fn()
            }
          }
        };
      }),
      signOut: vi.fn(),
      signInWithOAuth,
      signInWithPassword: vi.fn()
    }
  };
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (gate) await gate;
    if (rejectRead) return new Response(JSON.stringify({
      error: {
        code: "FORBIDDEN"
      }
    }), {
      status: 403
    });
    const query = new URL(String(input), "http://local.test").searchParams;
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        operation_id: "10",
        operation: payload.operation.slice("admin_".length),
        entity_kind: payload.operation === "admin_rule_save" ? "rules" : "configurations",
        entity_id: payload.id ?? "1",
        revision: "2",
        time_committed: "2026-11-08T00:00:00Z"
      }));
    }
    const section = query.get("section"),
      kind = query.get("kind");
    if (section === "controls") return response(null);
    if (kind === "adapters") return response({
      records: [{
        id: 1,
        name: "DeepSeek Responses"
      }],
      next_cursor: null
    });
    if (kind === "legal_documents") {
      const display = legalDisplayFixture();
      return response({
        records: [display.common, display.provider],
        next_cursor: null
      });
    }
    if (section === "disclosures") return response(query.has("id") ? legalDisplayFixture().provider : { records: [legalDisplayFixture().provider], next_cursor: null });
    if (section === "configurations") return response(query.has("id") ? configuration : {
      records: [configuration],
      next_cursor: null
    });
    if (section === "users") return response({
      records: [{
        email: `users-${kind}`,
        auth_user_id: "A"
      }],
      next_cursor: null
    });
    return response({
      records: [{
        id: "7",
        revision: "1",
        weekday: null,
        start_minute: null,
        end_minute: null,
        enabled: false,
        members: [{
          config_id: "1",
          is_default: true
        }]
      }],
      next_cursor: null
    });
  }));
});
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  vi.unstubAllGlobals();
});
async function edit() {
  await screen.findByRole("heading", {
    name: configuration.name
  });
  fireEvent.click(screen.getByRole("button", {
    name: "Edit"
  }));
  return screen.findByLabelText("Configuration name", {
    exact: true
  });
}
describe("Admin business-page identity and dialog lifetime", () => {
  it("mounts a cached list without a read or render loop", async () => {
    const first = view(<AdminApp locale="en" section="configurations" />);
    await screen.findByRole("heading", {
      name: configuration.name
    });
    first.unmount();
    view(<AdminApp locale="en" section="configurations" />, first.cache);
    await screen.findByRole("heading", {
      name: configuration.name
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });
  it.each(["same-user", "different-user", "different-instance"] as const)("preserves an actual dialog draft only for the same owner (%s)", async transition => {
    view(<AdminApp locale="en" section="configurations" />);
    const input = await edit();
    await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    fireEvent.change(input, {
      target: {
        value: "Unsubmitted connection name"
      }
    });
    let release!: () => void;
    gate = new Promise(done => {
      release = done;
    });
    act(() => state.listener!("TOKEN_REFRESHED", session(transition === "different-user" ? "B" : "A", "new-token")));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => (init?.headers as {
      Authorization?: string;
    })?.Authorization === "Bearer new-token")).toBe(true));
    if (transition === "same-user") {
      expect((screen.getByLabelText("Configuration name") as HTMLInputElement).value).toBe("Unsubmitted connection name");
      expect(screen.getByLabelText("Configuration name").matches(":disabled")).toBe(true);
    }
    if (transition === "different-instance") context = adminContextFixture("00000000-0000-4000-8000-000000000002");
    await act(async () => {
      gate = null;
      release();
    });
    await waitFor(() => expect(screen.getByRole("button", {
      name: "New",
      hidden: true
    }).matches(":disabled")).toBe(false));
    if (transition === "same-user") {
      expect((screen.getByLabelText("Configuration name") as HTMLInputElement).value).toBe("Unsubmitted connection name");
      await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    } else expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("discards a private draft after refreshed authorization is denied", async () => {
    view(<AdminApp locale="en" section="configurations" />);
    const input = await edit();
    fireEvent.change(input, {
      target: {
        value: "Private draft"
      }
    });
    rejectRead = true;
    act(() => state.listener!("TOKEN_REFRESHED", session("A", "new-token")));
    await screen.findByText("FORBIDDEN");
    expect(screen.queryByDisplayValue("Private draft")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("preserves edits and their original CAS baseline after a conflict", async () => {
    view(<AdminApp locale="en" section="configurations" />);
    const input = await edit();
    await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    fireEvent.change(input, {
      target: {
        value: "My edit"
      }
    });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(new Response(JSON.stringify({
      error: {
        code: "CONFLICT"
      }
    }), {
      status: 409
    })) : original(input, init));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {
      name: "Save"
    }));
    await screen.findByText(/Your edits are preserved/);
    expect((input as HTMLInputElement).value).toBe("My edit");
    const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(call[1]!.body)).expected_revision).toBe("1");
  });
  it.each(["en", "zh"] as const)("explains configuration failures and the reference format in %s", async locale => {
    let failure = { code: "INVALID_REQUEST", reason: "CREDENTIAL_UNAVAILABLE" };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(new Response(JSON.stringify({ error: failure }), { status: 400 })) : original(input, init));
    view(<AdminApp locale={locale} section="configurations" />);
    await screen.findByRole("heading", { name: configuration.name }); fireEvent.click(screen.getByRole("button", { name: locale === "zh" ? "编辑" : "Edit" }));
    const credential = await screen.findByLabelText(locale === "zh" ? "凭据引用名称" : "Credential reference") as HTMLInputElement;
    await waitFor(() => expect(credential.matches(":disabled")).toBe(false));
    const hint = screen.getByText(locale === "zh" ? "填写服务器已配置的环境变量名，不是 API Key。" : "Enter the name of an environment variable configured on the server, not an API key.");
    expect(credential.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.change(credential, { target: { value: "not-an-env-name" } }); expect(credential.checkValidity()).toBe(false);
    fireEvent.change(credential, { target: { value: "AI_PROVIDER_KEY_TEST" } }); expect(credential.checkValidity()).toBe(true);
    const cases = [
      ["INVALID_REQUEST", "CREDENTIAL_UNAVAILABLE", "This credential reference is not configured on the server. Enter a configured environment variable name.", "服务器未配置此凭据引用，请填写已配置的环境变量名。"],
      ["INVALID_REQUEST", "ENDPOINT_INVALID", "The endpoint URL is invalid. Enter a canonical public HTTPS address.", "接入地址无效，请填写规范的公网 HTTPS 地址。"],
      ["INVALID_REQUEST", "ENDPOINT_UNREACHABLE", "The endpoint cannot be resolved to an available public address. Check the URL and server network.", "接入地址无法解析到可用的公网地址，请检查地址与服务器网络。"],
    ];
    for (const [code, reason, en, zh] of cases) {
      failure = { code, reason };
      fireEvent.click(screen.getByRole("button", { name: locale === "zh" ? "保存" : "Save" }));
      await screen.findByText(locale === "zh" ? zh : en);
      expect(screen.queryByText(code)).toBeNull(); await waitFor(() => expect(credential.matches(":disabled")).toBe(false));
    }
  });

  it("requires explicit prices for new configurations instead of defaulting to free", async () => {
    view(<AdminApp locale="en" section="configurations" />);
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    const input = await screen.findByLabelText("Configuration name"); await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    for (const name of ["Input", "Cache read", "Cache write", "Output"]) { const rate = screen.getByLabelText(name) as HTMLInputElement; expect(rate.value).toBe(""); expect(rate.required).toBe(true); expect(rate.checkValidity()).toBe(false); }
    fireEvent.change(input, { target: { value: "Explicit-price service" } }); fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Public service" } }); fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: configuration.endpoint_url } }); fireEvent.change(screen.getByLabelText("Model"), { target: { value: configuration.model_id } }); fireEvent.change(screen.getByLabelText("Credential reference"), { target: { value: configuration.credential_ref } }); fireEvent.change(screen.getByLabelText("Data-processing disclosure"), { target: { value: "3" } });
    fireEvent.submit(input.closest("form")!);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    for (const name of ["Input", "Cache read", "Cache write", "Output"]) fireEvent.change(screen.getByLabelText(name), { target: { value: "0" } });
    fireEvent.submit(input.closest("form")!); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")![1]!.body)); expect(body.price.output_nanos_per_million).toBe("0");
  });
  it("keeps configuration and price history together and invalidates both after save", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const query = new URL(String(input), "http://local.test").searchParams;
      if (query.get("section") === "audit") return Promise.resolve(response({ records: query.get("kind") === "prices" ? [{ audit_id: "52", operation_id: "50", config_id: "1", action: "UPDATE", currency: "EUR", input_standard_nanos_per_million: "1234567890", input_cache_read_nanos_per_million: "0", input_cache_write_nanos_per_million: "0", output_nanos_per_million: "0" }] : [{ audit_id: "51", operation_id: "50", id: "1", action: "UPDATE", name: "Previous service name" }], next_cursor: null }));
      return original(input, init);
    });
    const app = view(<AdminApp locale="en" section="configurations" />);
    await edit();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input), "http://local.test").searchParams.get("section") === "audit")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText("Previous service name");
    const prices = await screen.findByRole("region", { name: "Price changes" });
    await within(prices).findByText("1.23456789 EUR");
    const auditCalls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), "http://local.test").searchParams).filter(query => query.get("section") === "audit");
    expect(auditCalls.map(query => query.get("kind")).sort()).toEqual(["configurations", "prices"]); expect(auditCalls.every(query => query.get("entity_id") === "1")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" })); fireEvent.change(screen.getByLabelText("Input"), { target: { value: "2" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const cached = app.cache.getQueryCache().getAll().filter(query => query.queryKey[6] === "audit"); expect(cached).toHaveLength(2); expect(cached.every(query => query.state.isInvalidated)).toBe(true);
  });
  it("shows rule period and candidate/default changes in the same history", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    const rule = { id: "7", revision: "1", weekday: 1, start_minute: 540, end_minute: 1080, enabled: false, members: [{ config_id: "1", is_default: true }] };
    vi.mocked(fetch).mockImplementation((input, init) => {
      const query = new URL(String(input), "http://local.test").searchParams;
      if (query.get("section") === "rules" && query.has("id")) return Promise.resolve(response(rule));
      if (query.get("section") === "audit") return Promise.resolve(response({ records: query.get("kind") === "rule_members" ? [{ audit_id: "62", operation_id: "60", rule_id: "7", config_id: "1", is_default: true, action: "INSERT" }] : [{ ...rule, audit_id: "61", operation_id: "60", action: "UPDATE" }], next_cursor: null }));
      return original(input, init);
    });
    view(<AdminApp locale="en" section="rules" />); fireEvent.click(await screen.findByRole("button", { name: "View" })); fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByRole("region", { name: "Period changes" });
    const options = await screen.findByRole("region", { name: "Options and defaults" });
    await within(options).findByText("Configuration ID"); expect(within(options).getByText("1")).toBeTruthy(); expect(within(options).getByText("Default")).toBeTruthy(); expect(within(options).getByText("Yes")).toBeTruthy();
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), "http://local.test").searchParams).filter(query => query.get("section") === "audit"); expect(calls.map(query => query.get("kind")).sort()).toEqual(["rule_members", "rules"]); expect(calls.every(query => query.get("entity_id") === "7")).toBe(true);
  });
  it("marks an explicitly adopted latest baseline clean", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    view(<AdminApp locale="en" section="configurations" />);
    const input = await edit();
    await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    fireEvent.change(input, {
      target: {
        value: "Unsaved edits"
      }
    });
    configuration = {
      ...configuration,
      name: "Latest server name",
      revision: "2"
    };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(new Response(JSON.stringify({
      error: {
        code: "CONFLICT"
      }
    }), {
      status: 409
    })) : original(input, init));
    fireEvent.click(screen.getByRole("button", {
      name: "Save"
    }));
    await screen.findByText(/Your edits are preserved/);
    fireEvent.click(screen.getByRole("button", {
      name: "Refresh record"
    }));
    await waitFor(() => expect(screen.getByText("A newer record is available.")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Load latest"
    }).matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", {
      name: "Load latest"
    }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("Latest server name"));
    confirm.mockClear();
    fireEvent.click(screen.getByRole("button", {
      name: "Close",
      hidden: true
    }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    confirm.mockRestore();
  });
  it("preserves and disables the real runtime settings portal across token refresh", async () => {
    view(<AdminApp locale="en" />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Edit"
    }));
    const input = screen.getByLabelText("Requests per user / UTC day") as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        value: "25"
      }
    });
    let release!: () => void;
    gate = new Promise(done => {
      release = done;
    });
    act(() => state.listener!("TOKEN_REFRESHED", session("A", "new-token")));
    await waitFor(() => expect(input.matches(":disabled")).toBe(true));
    expect(screen.getByRole("button", {
      name: "Save"
    }).matches(":disabled")).toBe(true);
    await act(async () => {
      gate = null;
      release();
    });
    await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    expect(input.value).toBe("25");
  });
  it("keeps rule choices and the explicit default across selector pages", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const query = new URL(String(input), "http://local.test").searchParams;
      if (query.get("kind") === "configurations" && query.get("limit") === "100") return Promise.resolve(response({
        records: [query.has("after") ? {
          ...configuration,
          id: "2",
          name: "Next-page configuration"
        } : configuration],
        next_cursor: query.has("after") ? null : "1"
      }));
      return original(input, init);
    });
    view(<AdminApp locale="en" section="rules" />);
    fireEvent.click(await screen.findByRole("button", {
      name: "New"
    }));
    const first = await screen.findByLabelText("Current configuration · model-a");
    await waitFor(() => expect(first.matches(":disabled")).toBe(false));
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", {
      name: "Load more configurations"
    }));
    const second = await screen.findByLabelText("Next-page configuration · model-a");
    await waitFor(() => expect(second.matches(":disabled")).toBe(false));
    fireEvent.click(second);
    expect((screen.getByLabelText("Current configuration · model-a") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Default configuration"), {
      target: {
        value: "2"
      }
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Save"
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body)).members).toEqual([{
      config_id: "1",
      is_default: false
    }, {
      config_id: "2",
      is_default: true
    }]);
  });
  it("saves a Shanghai period, candidates and default atomically", async () => {
    view(<AdminApp locale="en" section="rules" />);
    fireEvent.click(await screen.findByRole("button", {
      name: "New"
    }));
    const dialog = screen.getByRole("dialog");
    const fallback = await within(dialog).findByLabelText("Fallback for other periods");
    await waitFor(() => expect(fallback.matches(":disabled")).toBe(false));
    fireEvent.click(fallback);
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: {
        value: "09:30"
      }
    });
    fireEvent.change(screen.getByLabelText("End time"), {
      target: {
        value: "18:00"
      }
    });
    fireEvent.click(screen.getByLabelText("Current configuration · model-a"));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Save"
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      operation: "admin_rule_save",
      id: null,
      expected_revision: null,
      weekday: 1,
      start_minute: 570,
      end_minute: 1080,
      members: [{
        config_id: "1",
        is_default: true
      }]
    });
  });
  it("clears the previous section kind when soft navigation reuses the component", async () => {
    const app = view(<AdminApp locale="en" section="users" />);
    await screen.findByRole("heading", {
      name: "users-accounts"
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Administrators"
    }));
    await screen.findByRole("heading", {
      name: "users-members"
    });
    app.rerender(<AdminApp locale="en" section="rules" />);
    await screen.findByRole("heading", {
      name: "Other periods"
    });
    expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain("kind=rules");
    const link = screen.getByRole("link", {
      name: "Back to editor"
    });
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("uses the clean OAuth callback after session restoration fails or is absent", async () => {
    getSession.mockResolvedValueOnce({
      data: {
        session: null
      },
      error: null
    });
    view(<AdminApp locale="en" section="users" />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Continue with GitHub"
    }));
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/en/admin`
      }
    });
  });
});

describe("independent data-processing disclosures", () => {
  function fillDisclosure() {
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "Independent supplier" } });
    fireEvent.change(screen.getByLabelText("Chinese title"), { target: { value: "供应商数据处理说明" } });
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Supplier data handling" } });
    fireEvent.change(screen.getByLabelText("Chinese content"), { target: { value: "## 数据处理\n\n选择的文字提交给供应商。" } });
    fireEvent.change(screen.getByLabelText("English content"), { target: { value: "## Data handling\n\nSelected text goes to the supplier." } });
  }
  it("creates a bilingual disclosure with safe previews and no technical scope fields", async () => {
    view(<AdminApp locale="en" section="disclosures" />);
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fillDisclosure();
    expect(screen.queryByLabelText("Adapter")).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByLabelText("Endpoint URL")).toBeNull();
    const preview = screen.getByRole("region", { name: "English preview" });
    expect(within(preview).getByRole("heading", { name: "Data handling" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("English content"), { target: { value: "[Unsafe](javascript:alert(1))" } });
    expect(within(preview).queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Complete both languages and use only supported Markdown with safe links.");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("English content"), { target: { value: "## Data handling\n\nSelected text goes to the supplier." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")![1]!.body));
    expect(sent).toEqual({ operation: "admin_legal_document_save", contract_code: "cv_app_db_2", database_instance_id: context.database_instance_id, operation_key: expect.any(String), reason: "Save data-processing disclosure", id: null, expected_revision: null, kind: "AI_PROVIDER", recipient_name: "Independent supplier", zh_title: "供应商数据处理说明", en_title: "Supplier data handling", zh_body: "## 数据处理\n\n选择的文字提交给供应商。", en_body: "## Data handling\n\nSelected text goes to the supplier.", effective_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), enabled: false });
  });
  it("keeps a disclosure's unknown operation frozen through retries", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let writes = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (init?.method === "POST" && ++writes === 1) return Promise.reject(new TypeError("Response lost"));
      if (init?.method === "POST" && writes === 2) return Promise.resolve(new Response(JSON.stringify({ error: { code: "INVALID_REQUEST" } }), { status: 400 }));
      return original(input, init);
    });
    view(<AdminApp locale="en" section="disclosures" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const body = await screen.findByLabelText("English content");
    fireEvent.change(body, { target: { value: "Changed disclosure." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Result unknown. Keep this dialog open and retry the same operation.");
    expect(body.matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same operation" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
    expect(body.matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same operation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
    expect(sent[1]).toEqual(sent[0]); expect(sent[2]).toEqual(sent[0]);
  });
  it("preserves a conflicting draft until the latest disclosure is explicitly adopted", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let latest = legalDisplayFixture().provider, conflict = true;
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.mocked(fetch).mockImplementation((input, init) => {
      const query = new URL(String(input), "http://local.test").searchParams;
      if (init?.method === "POST" && conflict) { conflict = false; latest = { ...latest, revision: "2", en_body: "Latest disclosure." }; return Promise.resolve(new Response(JSON.stringify({ error: { code: "CONFLICT" } }), { status: 409 })); }
      if (query.get("section") === "disclosures" && query.has("id")) return Promise.resolve(response(latest));
      return original(input, init);
    });
    view(<AdminApp locale="en" section="disclosures" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const body = await screen.findByLabelText("English content") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Unsaved disclosure." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/This disclosure changed/);
    expect(body.value).toBe("Unsaved disclosure.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh record" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load latest" }).matches(":disabled")).toBe(false));
    expect(body.value).toBe("Unsaved disclosure.");
    fireEvent.click(screen.getByRole("button", { name: "Load latest" }));
    expect(body.value).toBe("Latest disclosure.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const last = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").at(-1)!;
    expect(JSON.parse(String(last[1]!.body))).toMatchObject({ expected_revision: "2", en_body: "Latest disclosure." });
  });
  it("separates internal and public names and retains a manually selected document across connection changes", async () => {
    view(<AdminApp locale="en" section="configurations" />);
    const internal = await edit();
    fireEvent.change(internal, { target: { value: "Internal routing alias" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Friendly user name" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://another-supplier.example/responses" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "another-model" } });
    const selector = screen.getByLabelText("Data-processing disclosure") as HTMLSelectElement;
    expect(selector.value).toBe("3");
    expect(within(selector).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(call[1]!.body))).toMatchObject({ name: "Internal routing alias", display_name: "Friendly user name", endpoint_url: "https://another-supplier.example/responses", model_id: "another-model", legal_document_id: "3" });
  });
  it("clears the disclosure editor when the account changes", async () => {
    view(<AdminApp locale="en" section="disclosures" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const body = await screen.findByLabelText("English content");
    fireEvent.change(body, { target: { value: "Private unsaved draft." } });
    await act(async () => { state.listener?.("SIGNED_IN", session("B", "B-token")); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Private unsaved draft.")).toBeNull();
  });
});
