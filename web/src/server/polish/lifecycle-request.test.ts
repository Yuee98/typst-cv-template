import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "@/lib/polish/contract";
import { VALID_ZH_TEXT, validRequestBody, postRequest, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

describe("POST /api/polish — bounded reader and request validation", () => {
  it("400 INVALID_REQUEST for a non-JSON content type", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ headers: { "content-type": "text/plain" } }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("413 PAYLOAD_TOO_LARGE when Content-Length exceeds the cap (body never read)", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ headers: { "content-length": String(MAX_BODY_BYTES + 1) } }),
    );

    await expectErrorShape(response, 413, "PAYLOAD_TOO_LARGE");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("413 PAYLOAD_TOO_LARGE when the streamed body grows past the cap without Content-Length", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 3 chunks × 32 KiB = 96 KiB > 64 KiB cap
        for (let index = 0; index < 3; index += 1) {
          controller.enqueue(encoder.encode("x".repeat(32 * 1024)));
        }
        controller.close();
      },
    });
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ bodyStream: stream }));

    await expectErrorShape(response, 413, "PAYLOAD_TOO_LARGE");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("400 INVALID_REQUEST for an empty body", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ rawBody: "" }));

    await expectErrorShape(response, 400, "INVALID_REQUEST");
  });

  it("400 INVALID_REQUEST for malformed JSON", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ rawBody: "{not json" }));

    await expectErrorShape(response, 400, "INVALID_REQUEST");
  });

  it.each([
    ["unknown top-level key", { ...validRequestBody(), path: "experience[0].items[0]" }],
    ["unknown items[].path key (RHF path must never cross the wire)", (() => {
      const body = validRequestBody();
      (body.items as Record<string, unknown>[])[0].path = "experience[0].items[0]";
      return body;
    })()],
    ["header PII attempt", { ...validRequestBody(), header: { name: "张三", email: "a@b.c" } }],
  ])("400 INVALID_REQUEST on strictObject rejection: %s", async (_label, body) => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(body) }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("400 INVALID_REQUEST when item granularity carries two items", async () => {
    const body = validRequestBody({
      items: [
        { id: "i0", kind: "experience_bullet", text: VALID_ZH_TEXT },
        { id: "i1", kind: "experience_bullet", text: "优化数据库查询，将响应时间缩短 30%。" },
      ],
    });
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(body) }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("400 INVALID_REQUEST for a whitespace-only item text", async () => {
    const body = validRequestBody({
      items: [{ id: "i0", kind: "experience_bullet", text: "  　  " }],
    });
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(body) }),
    );

    await expectErrorShape(response, 400, "INVALID_REQUEST");
  });
});

