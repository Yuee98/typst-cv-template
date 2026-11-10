import { describe, expect, it, vi } from "vitest";
import { errorMessage } from "./cv-utils";

describe("errorMessage", () => {
  it("preserves native Error and string messages, including empty messages", () => {
    expect(errorMessage(new Error("Cloud sync failed"))).toBe("Cloud sync failed");
    expect(errorMessage(new TypeError("Network unavailable"))).toBe("Network unavailable");
    expect(errorMessage(new Error())).toBe("");
    expect(errorMessage("Already formatted")).toBe("Already formatted");
    expect(errorMessage("")).toBe("");
  });

  it("extracts only the plain Supabase message without formatting details, hints or the whole object", () => {
    const toJSON = vi.fn(() => ({ private: "synthetic-private-value" }));
    const toString = vi.fn(() => "synthetic-private-details");
    const error = {
      code: "42501",
      message: "Cloud sync is temporarily unavailable.",
      details: "synthetic-private-details",
      hint: "synthetic-private-hint",
    };
    expect(errorMessage(error)).toBe(error.message);
    expect(errorMessage({ ...error, toJSON, toString })).toBe(error.message);
    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, 42, {}, [], "", " \t\n"].map(message => ({ message })))("uses a generic fallback for an invalid object message: $message", ({ message }) => {
    const toString = vi.fn(() => "synthetic-private-fallback");
    expect(errorMessage({ message, details: "synthetic-private-details", toString })).toBe("An unexpected error occurred.");
    expect(toString).not.toHaveBeenCalled();
  });

  it("does not execute a message accessor or inherited message", () => {
    const getter = vi.fn(() => { throw new Error("synthetic-private-getter"); });
    expect(errorMessage(Object.defineProperty({}, "message", { get: getter }))).toBe("An unexpected error occurred.");
    expect(getter).not.toHaveBeenCalled();
    expect(errorMessage(Object.create({ message: "synthetic-private-inherited-message" }))).toBe("An unexpected error occurred.");
  });

  it("contains hostile object inspection without leaking its thrown error", () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() { throw new Error("synthetic-private-prototype"); },
      getOwnPropertyDescriptor() { throw new Error("synthetic-private-descriptor"); },
      get() { throw new Error("synthetic-private-property"); },
    });
    expect(errorMessage(hostile)).toBe("An unexpected error occurred.");
  });

  it.each([null, undefined, false, 42])("retains primitive formatting for %s", value => {
    expect(errorMessage(value)).toBe(String(value));
  });
});
