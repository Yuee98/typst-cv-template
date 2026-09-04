import { describe, expect, it } from "vitest";
import { adminMessages } from "./messages";
import { buildAdminQuery, localizedAdminValue } from "./admin-app";

describe("admin display helpers", () => {
  it("keeps list query bounded to search, cursor and limit", () => {
    expect(
      buildAdminQuery({ search: "model", after: "cursor", limit: 50 }),
    ).toBe("?search=model&after=cursor&limit=50");
  });

  it("localizes boolean values", () => {
    expect(localizedAdminValue(true, "en", adminMessages.en)).toBe("Yes");
    expect(localizedAdminValue(false, "zh", adminMessages.zh)).toBe("否");
  });
});
