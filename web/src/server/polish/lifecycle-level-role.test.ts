import { describe, expect, it } from "vitest";
import { validRequestBody, postRequest, DepMocks, makeDeps, handlersOf } from "./lifecycle-fixtures";

describe("POST /api/polish — server-side level-role trimming (Invariant 3)", () => {
  const SIBLING = "SIBLING-SENTINEL-ALLOWED";
  const SCOPE = "SCOPE-META-SENTINEL-ALLOWED";
  const PROFILE = "PROFILE-SENTINEL-NEVER-SENT";
  const SKILL = "SKILL-SENTINEL-NEVER-SENT";

  function leveledBody(level: 1 | 2) {
    return validRequestBody({
      context: {
        level,
        references: [
          { role: "sibling", text: `${SIBLING} 兄弟条目内容` },
          { role: "scope_metadata", text: `${SCOPE} 区块元数据` },
          { role: "profile", text: `${PROFILE} profile 摘要` },
          { role: "skill", text: `${SKILL} 技能标签` },
        ],
      },
    });
  }

  function allProviderText(mocks: DepMocks): string {
    return mocks.providerCalls
      .flatMap((call) => call.request.messages.map((message) => message.content))
      .join("\n");
  }

  it("level 1: profile/skill references are dropped BEFORE prompt construction and never reach the provider", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(leveledBody(1)) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.providerCalls).toHaveLength(1);
    const sent = allProviderText(mocks);
    expect(sent).toContain(SIBLING);
    expect(sent).toContain(SCOPE);
    expect(sent).not.toContain(PROFILE);
    expect(sent).not.toContain(SKILL);
  });

  it("level 2: profile/skill references are allowed through", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(
      postRequest({ rawBody: JSON.stringify(leveledBody(2)) }),
    );

    expect(response.status).toBe(200);
    const sent = allProviderText(mocks);
    expect(sent).toContain(SIBLING);
    expect(sent).toContain(SCOPE);
    expect(sent).toContain(PROFILE);
    expect(sent).toContain(SKILL);
  });
});

// ---------------------------------------------------------------------------
// GET /api/polish/quota
// ---------------------------------------------------------------------------

