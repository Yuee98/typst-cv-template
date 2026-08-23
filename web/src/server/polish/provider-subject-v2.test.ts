import { describe, expect, it } from "vitest";
import {
  buildProviderSubjectV2Message,
  deriveProviderSubjectIdV2,
  parseProviderSubjectIdV2,
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
  });
});
