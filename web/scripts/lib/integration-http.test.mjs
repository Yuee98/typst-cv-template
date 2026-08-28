import { describe, expect, it } from "vitest";

import { readJsonOrNull } from "./integration-http.mjs";

describe("integration HTTP body parsing", () => {
  it("returns parsed JSON and tolerates an ordinary non-JSON body", async () => {
    await expect(readJsonOrNull({ json: async () => ({ ok: true }) })).resolves.toEqual({ ok: true });
    await expect(readJsonOrNull({ json: async () => { throw new SyntaxError("not JSON"); } })).resolves.toBeNull();
  });

  it("rethrows a body-read failure after caller cancellation", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("caller aborted", "AbortError");
    let rejectBody;
    const reading = readJsonOrNull(
      { json: () => new Promise((_resolve, reject) => { rejectBody = reject; }) },
      controller.signal,
    );
    controller.abort();
    rejectBody(abortError);
    await expect(reading).rejects.toBe(abortError);
  });
});
