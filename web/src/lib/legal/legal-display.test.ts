import { describe, expect, it } from "vitest";
import { legalDisplaySchema } from "./legal-display";
import { legalDisplayFixture } from "./test-fixtures";
describe("current exact legal display", () => {
  it("accepts separate common/provider audited documents", () => expect(legalDisplaySchema.parse(legalDisplayFixture())).toEqual(legalDisplayFixture()));
  it("rejects old/incomplete shapes and cross-kind documents", () => {
    expect(legalDisplaySchema.safeParse({
      contract: "cv_app_db_1"
    }).success).toBe(false);
    const display = legalDisplayFixture();
    expect(legalDisplaySchema.safeParse({
      ...display,
      provider: display.common
    }).success).toBe(false);
  });
  it.each(["<script>bad()</script>", "![tracker](https://evil.test/pixel)", "[bad](javascript:alert)", "[bad](data:text/plain,payload)", "[bad](//evil.test)", "[bad](https://user:pass@evil.test)"])("rejects unsafe Markdown %s", en_body => {
    const display = legalDisplayFixture();
    display.provider.en_body = en_body;
    expect(legalDisplaySchema.safeParse(display).success).toBe(false);
  });
});
