// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminSecuritySettings } from "./security-settings";
import { adminMessages } from "./messages";

function createClient() {
  return {
    auth: {
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { all: [] }, error: null }),
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: { currentLevel: "aal1" }, error: null }),
        enroll: vi.fn().mockResolvedValue({ data: {
          id: "factor-1",
          totp: {
            secret: "do-not-persist-secret",
            uri: "otpauth://totp/example",
            qr_code: "data:image/png;base64,temporary",
          },
        }, error: null }),
        challenge: vi.fn().mockResolvedValue({ data: { id: "challenge-1" }, error: null }),
        verify: vi.fn().mockResolvedValue({ data: {}, error: null }),
        unenroll: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
      refreshSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
  };
}

describe("AdminSecuritySettings", () => {
  it("enrolls and verifies TOTP while keeping enrollment material in the component", async () => {
    const client = createClient();
    render(<AdminSecuritySettings client={client as never} t={adminMessages.en} />);
    await waitFor(() => expect(client.auth.mfa.listFactors).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: adminMessages.en.enrollTotp }));
    expect(await screen.findByText(/do-not-persist-secret/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(adminMessages.en.totpCode), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: adminMessages.en.verifyTotp }));
    await waitFor(() => expect(client.auth.mfa.verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    }));
    expect(screen.queryByText(/do-not-persist-secret/)).toBeNull();
    expect(client.auth.refreshSession).toHaveBeenCalled();
  });

  it("removes an enrolled factor and refreshes session assurance", async () => {
    const client = createClient();
    client.auth.mfa.listFactors.mockResolvedValue({ data: { all: [{ id: "factor-1", friendly_name: "Admin", factor_type: "totp", status: "verified" }] }, error: null });
    render(<AdminSecuritySettings client={client as never} t={adminMessages.zh} />);
    const remove = await screen.findByRole("button", { name: adminMessages.zh.unenroll });
    fireEvent.click(remove);
    await waitFor(() => expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: "factor-1" }));
    expect(client.auth.refreshSession).toHaveBeenCalled();
  });
});
