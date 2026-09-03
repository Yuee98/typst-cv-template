import { describe, expect, it } from "vitest";
import {
  buildProviderSubjectV2Message,
  type DeriveProviderSubjectIdV2Input,
  deriveProviderSubjectIdV2,
  parseProviderSubjectIdV2,
  ProviderSubjectV2Error,
  PROVIDER_SUBJECT_V2_ALGORITHM,
  PROVIDER_SUBJECT_V2_DERIVATION_MESSAGE_SCHEMA,
  PROVIDER_SUBJECT_V2_SECRET_CLASS,
} from "./provider-subject-v2";

const PROFILE_VERSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const AUTHENTICATED_USER_ID = "a8098c1a-f86e-11da-bd1a-00112444be1e";

const ASCII_MESSAGE =
  "provider-subject-v2\nprofile_version_id:123e4567-e89b-42d3-a456-426614174000\nuser_id:a8098c1a-f86e-11da-bd1a-00112444be1e";
const ASCII_MESSAGE_HEX =
  "70726f76696465722d7375626a6563742d76320a70726f66696c655f76657273696f6e5f69643a31323365343536372d653839622d343264332d613435362d3432363631343137343030300a757365725f69643a61383039386331612d663836652d313164612d626431612d303031313234343462653165";
const ASCII_HMAC_SHA256 = "0bcfde32bc107edee4d5f73f013b629088dcbeb6128b29af65571a2460a4a432";

const MULTIBYTE_PROFILE_VERSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const MULTIBYTE_AUTHENTICATED_USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const MULTIBYTE_MESSAGE_HEX =
  "70726f76696465722d7375626a6563742d76320a70726f66696c655f76657273696f6e5f69643a35353065383430302d653239622d343164342d613731362d3434363635353434303030300a757365725f69643a36626137623831302d396461642d313164312d383062342d303063303466643433306338";
const MULTIBYTE_HMAC_SHA256 =
  "2d3f10762cc32243f9cd603df200a2d80147de7315b802ec9cb500e02d5e4392";

function deriveWith(overrides: Partial<DeriveProviderSubjectIdV2Input> = {}): string {
  return deriveProviderSubjectIdV2({
    profileVersionId: PROFILE_VERSION_ID,
    authenticatedUserId: AUTHENTICATED_USER_ID,
    secret: "ascii-secret",
    ...overrides,
  });
}

describe("provider-subject-v2 contract", () => {
  it("publishes the reviewed algorithm, secret class, and derivation schema", () => {
    expect(PROVIDER_SUBJECT_V2_ALGORITHM).toBe("hmac-sha256");
    expect(PROVIDER_SUBJECT_V2_SECRET_CLASS).toBe(
      "utf8-trimmed-env:AI_USER_ID_HMAC_SECRET",
    );
    expect(PROVIDER_SUBJECT_V2_DERIVATION_MESSAGE_SCHEMA).toBe(
      "ASCII(provider-subject-v2\\nprofile_version_id:)+UUID36LOWER(profile_version_id)+ASCII(\\nuser_id:)+UUID36LOWER(user_id)",
    );
  });

  it("matches the independently frozen ASCII message and HMAC vector", () => {
    const identity = {
      profileVersionId: PROFILE_VERSION_ID.toUpperCase(),
      authenticatedUserId: AUTHENTICATED_USER_ID.toUpperCase(),
    };

    const message = buildProviderSubjectV2Message(identity);
    expect(message.toString("ascii")).toBe(ASCII_MESSAGE);
    expect(message.toString("hex")).toBe(ASCII_MESSAGE_HEX);
    expect(message.at(-1)).not.toBe(0x00);
    expect(message.at(-1)).not.toBe(0x0a);

    expect(deriveProviderSubjectIdV2({ ...identity, secret: "  ascii-secret  " })).toBe(
      ASCII_HMAC_SHA256,
    );
  });

  it("admits only the lowercase 64-hex persisted token grammar", () => {
    expect(parseProviderSubjectIdV2(ASCII_HMAC_SHA256)).toBe(ASCII_HMAC_SHA256);
    expect(() => parseProviderSubjectIdV2(ASCII_HMAC_SHA256.toUpperCase())).toThrow(
      /64 lowercase hexadecimal/,
    );
    expect(() => parseProviderSubjectIdV2(`hmac-sha256:${ASCII_HMAC_SHA256}`)).toThrow(
      /64 lowercase hexadecimal/,
    );
    expect(() => parseProviderSubjectIdV2(`${ASCII_HMAC_SHA256}\n`)).toThrow(
      /64 lowercase hexadecimal/,
    );
    expect(() => parseProviderSubjectIdV2(ASCII_HMAC_SHA256.slice(1))).toThrow(
      /64 lowercase hexadecimal/,
    );
    expect(() => parseProviderSubjectIdV2(null)).toThrow(ProviderSubjectV2Error);
  });

  it("matches the independently frozen multibyte UTF-8 secret vector", () => {
    const identity = {
      profileVersionId: MULTIBYTE_PROFILE_VERSION_ID,
      authenticatedUserId: MULTIBYTE_AUTHENTICATED_USER_ID,
    };

    expect(buildProviderSubjectV2Message(identity).toString("hex")).toBe(MULTIBYTE_MESSAGE_HEX);
    expect(
      deriveProviderSubjectIdV2({
        ...identity,
        secret: " \u3000密钥🔐\u00a0",
      }),
    ).toBe(MULTIBYTE_HMAC_SHA256);
  });

  it("trims Unicode edge whitespace but does not normalize the remaining key", () => {
    expect(deriveWith({ secret: "\u3000é\u00a0" })).toBe(deriveWith({ secret: "é" }));
    expect(deriveWith({ secret: "é" })).not.toBe(deriveWith({ secret: "e\u0301" }));
  });

  it.each(["", " ", "\t\r\n", "\u00a0\u3000"])(
    "rejects an empty UTF-8-trimmed secret %#",
    (secret) => {
      expect(() => deriveWith({ secret })).toThrow("secret must be non-empty after trimming");
    },
  );

  it.each([null, 42, Buffer.from("secret")])(
    "rejects a non-string secret %#",
    (secret) => {
      expect(() => deriveWith({ secret: secret as unknown as string })).toThrow(
        "secret must be a string",
      );
    },
  );

  it.each(["\ud800", "\udc00", "valid\ud800text", "valid\udc00text"])(
    "rejects a secret with a lone UTF-16 surrogate %#",
    (secret) => {
      expect(() => deriveWith({ secret })).toThrow(
        "secret must contain valid Unicode for UTF-8 encoding",
      );
    },
  );

  it.each([
    "123e4567e89b42d3a456426614174000",
    "{123e4567-e89b-42d3-a456-426614174000}",
    "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
    " 123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-72d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567-e89b-42d3-a456-42661417400g",
  ])("rejects a malformed profile UUID %#", (profileVersionId) => {
    expect(() => deriveWith({ profileVersionId })).toThrow(
      "profileVersionId must be an RFC 4122 8-4-4-4-12 UUID",
    );
  });

  it.each([
    "a8098c1af86e11dabd1a00112444be1e",
    "a8098c1a-f86e-11da-bd1a-00112444be1e\n",
    "a8098c1a-f86e-01da-bd1a-00112444be1e",
    "a8098c1a-f86e-11da-7d1a-00112444be1e",
  ])("rejects a malformed authenticated-user UUID %#", (authenticatedUserId) => {
    expect(() => deriveWith({ authenticatedUserId })).toThrow(
      "authenticatedUserId must be an RFC 4122 8-4-4-4-12 UUID",
    );
  });

  it("does not mutate inputs and returns independent message buffers", () => {
    const identity = Object.freeze({
      profileVersionId: PROFILE_VERSION_ID.toUpperCase(),
      authenticatedUserId: AUTHENTICATED_USER_ID.toUpperCase(),
    });
    const derivation = Object.freeze({ ...identity, secret: " ascii-secret " });

    expect(() => deriveProviderSubjectIdV2(derivation)).not.toThrow();
    expect(derivation).toEqual({ ...identity, secret: " ascii-secret " });

    const first = buildProviderSubjectV2Message(identity);
    first.fill(0);
    const second = buildProviderSubjectV2Message(identity);
    expect(second.toString("ascii")).toBe(ASCII_MESSAGE);
  });

  it("fails closed for malformed top-level inputs", () => {
    expect(() =>
      buildProviderSubjectV2Message(null as unknown as DeriveProviderSubjectIdV2Input),
    ).toThrow("provider subject identity input must be an object");
    expect(() =>
      deriveProviderSubjectIdV2([] as unknown as DeriveProviderSubjectIdV2Input),
    ).toThrow("provider subject derivation input must be an object");
  });
});
