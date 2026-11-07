// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentActionDialogs } from "./use-document-action-dialogs";
import type { CvDocumentSummary } from "@/lib/cv/storage";

afterEach(cleanup);
const a: CvDocumentSummary = { id: "a", title: "A", storageKind: "local", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const b: CvDocumentSummary = { ...a, id: "b", title: "B" };
type Dialogs = ReturnType<typeof useDocumentActionDialogs>;
type Kind = "rename" | "duplicate" | "delete";
function open(dialogs: Dialogs, kind: Kind, id: string) {
  if (kind === "rename") dialogs.openRenameDialog(id);
  else if (kind === "duplicate") dialogs.openDuplicateDialog(id, "Copy");
  else dialogs.openDeleteDialog(id);
}
function submit(dialogs: Dialogs, kind: Kind) {
  if (kind === "rename") return dialogs.submitRenameDialog("Updated");
  if (kind === "duplicate") return dialogs.submitDuplicateDialog("Copy");
  return dialogs.confirmDeleteDialog();
}
function value(dialogs: Dialogs, kind: Kind) {
  return kind === "rename" ? dialogs.renameDialog : kind === "duplicate" ? dialogs.duplicateDialog : dialogs.deleteDialog;
}
describe("document action dialog completion ownership", () => {
  it.each(["rename", "duplicate", "delete"] as const)("returning to A cannot revive or complete its obsolete %s dialog", async kind => {
    let finish!: () => void;
    const pendingAction = new Promise<void>(resolve => { finish = resolve; });
    const onRename = vi.fn().mockResolvedValue(undefined), onDuplicate = vi.fn().mockResolvedValue(undefined), onDelete = vi.fn().mockResolvedValue(undefined);
    ({ rename: onRename, duplicate: onDuplicate, delete: onDelete })[kind].mockReturnValueOnce(pendingAction);
    const hook = renderHook(({ userId }: { userId: string }) => useDocumentActionDialogs({ userId, documents: [a, b], onRename, onDuplicate, onDelete }), { initialProps: { userId: "user-a" } });
    act(() => open(hook.result.current, kind, a.id));
    let pending!: Promise<void>;
    act(() => { pending = submit(hook.result.current, kind); });
    hook.rerender({ userId: "user-b" });
    hook.rerender({ userId: "user-a" });
    expect(value(hook.result.current, kind)).toBeNull();
    act(() => open(hook.result.current, kind, b.id));
    await act(async () => { finish(); await pending; });
    expect(value(hook.result.current, kind)?.documentId).toBe(b.id);
    await act(async () => { await submit(hook.result.current, kind); });
    expect(value(hook.result.current, kind)).toBeNull();
  });
  it.each(["rename", "duplicate", "delete"] as const)("A's late %s completion cannot close B's new dialog", async kind => {
    let finish!: () => void;
    const pendingAction = new Promise<void>(resolve => { finish = resolve; });
    const onRename = vi.fn().mockResolvedValue(undefined), onDuplicate = vi.fn().mockResolvedValue(undefined), onDelete = vi.fn().mockResolvedValue(undefined);
    ({ rename: onRename, duplicate: onDuplicate, delete: onDelete })[kind].mockReturnValueOnce(pendingAction);
    const hook = renderHook(({ userId, documents }: { userId: string | null; documents: CvDocumentSummary[] }) => useDocumentActionDialogs({ userId, documents, onRename, onDuplicate, onDelete }), {
      initialProps: { userId: "user-a" as string | null, documents: [a] }
    });
    act(() => open(hook.result.current, kind, a.id));
    let pending!: Promise<void>;
    act(() => { pending = submit(hook.result.current, kind); });
    hook.rerender({ userId: "user-b", documents: [b] });
    expect(value(hook.result.current, kind)).toBeNull();
    act(() => open(hook.result.current, kind, b.id));
    await act(async () => { finish(); await pending; });
    expect(value(hook.result.current, kind)?.documentId).toBe(b.id);
    await act(async () => { await submit(hook.result.current, kind); });
    expect(value(hook.result.current, kind)).toBeNull();
  });
  it.each(["rename", "duplicate", "delete"] as const)("an earlier signed-out local %s completion cannot close a newer dialog for the same owner", async kind => {
    let finish!: () => void;
    const pendingAction = new Promise<void>(resolve => { finish = resolve; });
    const onRename = vi.fn().mockResolvedValue(undefined), onDuplicate = vi.fn().mockResolvedValue(undefined), onDelete = vi.fn().mockResolvedValue(undefined);
    ({ rename: onRename, duplicate: onDuplicate, delete: onDelete })[kind].mockReturnValueOnce(pendingAction);
    const hook = renderHook(() => useDocumentActionDialogs({ userId: null, documents: [a, b], onRename, onDuplicate, onDelete }));
    act(() => open(hook.result.current, kind, a.id));
    let pending!: Promise<void>;
    act(() => { pending = submit(hook.result.current, kind); });
    act(() => open(hook.result.current, kind, b.id));
    await act(async () => { finish(); await pending; });
    expect(value(hook.result.current, kind)?.documentId).toBe(b.id);
    await act(async () => { await submit(hook.result.current, kind); });
    expect(value(hook.result.current, kind)).toBeNull();
  });
});
