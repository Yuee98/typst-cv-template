// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthoringSelect } from "./authoring-select";
import { adminMessages } from "./messages";
const item = (id: string, parentId: string | null = null) => ({ id, label: `Label ${id}`, parentId, status: "available", latestVersion: null, wireApiKind: null });
const page = (items: ReturnType<typeof item>[], nextCursor: string | null = null, kind = "providers") => Response.json({ schemaVersion: "admin_authoring_options_v1", kind, items, nextCursor });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads later pages and separately resolves an off-page selected reference", async () => {
  const fetcher = vi.fn(async (url: string) => { const query = new URL(url, "http://local.test").searchParams; return query.has("id") ? page([item("selected")]) : query.has("after") ? page([item("second")]) : page([item("first")], "first"); });
  vi.stubGlobal("fetch", fetcher);
  render(<AuthoringSelect accessToken="admin" kind="providers" label="Provider" value="selected" onChange={vi.fn()} t={adminMessages.en} />);
  await screen.findByRole("option", { name: "Label selected · available" });
  fireEvent.click(screen.getByRole("button", { name: adminMessages.en.nextPage }));
  await screen.findByRole("option", { name: "Label second · available" });
  expect(screen.getByRole("option", { name: "Label first · available" })).toBeTruthy();
  expect(screen.getByLabelText("Provider")).toHaveProperty("value", "selected");
});
it("discards a late lookup after the parent or authenticated session changes", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => new URL(url, "http://local.test").searchParams.get("parent") === "old" ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(page([item("current", "new")], null, "prices"))));
  const props = { kind: "prices" as const, label: "Price", value: "", onChange: vi.fn(), t: adminMessages.en };
  const view = render(<AuthoringSelect {...props} accessToken="old-token" parent="old" />);
  view.rerender(<AuthoringSelect {...props} accessToken="new-token" parent="new" />);
  await screen.findByRole("option", { name: "Label current · available" });
  finish(page([item("stale", "old")], null, "prices"));
  await waitFor(() => expect(screen.queryByRole("option", { name: /Label stale/ })).toBeNull());
});
