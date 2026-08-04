import { describe, expect, it, vi } from "vitest";
import {
  requirePolishUser,
  verifyBearerUser,
  type PolishAuthDeps,
} from "./auth";

const USER_ID = "9f1c2a34-0000-4abc-8def-0123456789ab";
const BEARER_HEADER = "Bearer valid-access-token";

function makeDeps(overrides: Partial<PolishAuthDeps> = {}): PolishAuthDeps {
  return {
    verifyAccessToken: vi.fn(async () => USER_ID),
    hasAcceptedCurrentAiTerms: vi.fn(async () => true),
    ...overrides,
  };
}

describe("requirePolishUser", () => {
  it("returns 401 UNAUTHORIZED when the Authorization header is missing", async () => {
    const deps = makeDeps();
    const outcome = await requirePolishUser(null, deps);

    expect(outcome).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", status: 401, message: expect.any(String) },
    });
    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
    expect(deps.hasAcceptedCurrentAiTerms).not.toHaveBeenCalled();
  });

  it.each([
    "Token abc",
    "Bearer",
    "Bearer ",
    "Bearer one two",
    "Basic dXNlcjpwYXNz",
    "",
  ])("returns 401 UNAUTHORIZED for malformed header %j", async (header) => {
    const deps = makeDeps();
    const outcome = await requirePolishUser(header, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("UNAUTHORIZED");
      expect(outcome.error.status).toBe(401);
    }
    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHORIZED for an invalid or expired token", async () => {
    const deps = makeDeps({ verifyAccessToken: vi.fn(async () => null) });
    const outcome = await requirePolishUser(BEARER_HEADER, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("UNAUTHORIZED");
      expect(outcome.error.status).toBe(401);
    }
    expect(deps.verifyAccessToken).toHaveBeenCalledWith("valid-access-token");
    expect(deps.hasAcceptedCurrentAiTerms).not.toHaveBeenCalled();
  });

  it("returns 403 AI_TERMS_REQUIRED when the current AI terms are not accepted", async () => {
    const deps = makeDeps({ hasAcceptedCurrentAiTerms: vi.fn(async () => false) });
    const outcome = await requirePolishUser(BEARER_HEADER, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("AI_TERMS_REQUIRED");
      expect(outcome.error.status).toBe(403);
    }
    expect(deps.hasAcceptedCurrentAiTerms).toHaveBeenCalledWith(USER_ID);
  });

  it("passes through with the verified user id when the AI terms are accepted", async () => {
    const deps = makeDeps();
    const outcome = await requirePolishUser(BEARER_HEADER, deps);

    expect(outcome).toEqual({ ok: true, userId: USER_ID });
    expect(deps.verifyAccessToken).toHaveBeenCalledWith("valid-access-token");
    expect(deps.hasAcceptedCurrentAiTerms).toHaveBeenCalledWith(USER_ID);
  });

  it("accepts a case-insensitive scheme and extra whitespace around the token", async () => {
    const deps = makeDeps();
    const outcome = await requirePolishUser("bearer   valid-access-token  ", deps);

    expect(outcome).toEqual({ ok: true, userId: USER_ID });
    expect(deps.verifyAccessToken).toHaveBeenCalledWith("valid-access-token");
  });

  it("returns 500 INTERNAL_ERROR when token verification throws", async () => {
    const deps = makeDeps({
      verifyAccessToken: vi.fn(async () => {
        throw new Error("auth service unreachable");
      }),
    });
    const outcome = await requirePolishUser(BEARER_HEADER, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INTERNAL_ERROR");
      expect(outcome.error.status).toBe(500);
    }
  });

  it("returns 500 INTERNAL_ERROR when the terms lookup throws", async () => {
    const deps = makeDeps({
      hasAcceptedCurrentAiTerms: vi.fn(async () => {
        throw new Error("database error");
      }),
    });
    const outcome = await requirePolishUser(BEARER_HEADER, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INTERNAL_ERROR");
      expect(outcome.error.status).toBe(500);
    }
  });
});

describe("verifyBearerUser (login-only, no AI-terms gate)", () => {
  it("passes through without consulting the terms dependency", async () => {
    const deps = makeDeps();
    const outcome = await verifyBearerUser(BEARER_HEADER, deps);

    expect(outcome).toEqual({ ok: true, userId: USER_ID });
    expect(deps.hasAcceptedCurrentAiTerms).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHORIZED when the header is missing or the token is invalid", async () => {
    const missing = await verifyBearerUser(null, makeDeps());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("UNAUTHORIZED");
      expect(missing.error.status).toBe(401);
    }

    const invalid = await verifyBearerUser(
      BEARER_HEADER,
      makeDeps({ verifyAccessToken: vi.fn(async () => null) }),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("UNAUTHORIZED");
      expect(invalid.error.status).toBe(401);
    }
  });
});
