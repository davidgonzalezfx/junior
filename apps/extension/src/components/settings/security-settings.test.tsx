// SecuritySettings tests: mode radio persists through saveSettings; the matrix
// table's cells are exactly permissionDecision(mode, [code]) — display can't
// drift from the enforcement tables.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PERMISSION_MODES, permissionDecision, type GuardReasonCode } from "@junior/protocol";
import { SecuritySettings } from "./security-settings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

const ROWS: [string, GuardReasonCode][] = [
  ["Routine action", "routine_supervised"],
  ["First visit to a site", "new_site"],
  ["Sensitive site (bank, webmail, …)", "sensitive_site"],
  ["Sensitive-looking button/link", "sensitive_label"],
  ["Form submission", "form_submit"],
  ["Local/internal network address", "private_network"],
  ["Password / secret field", "secret_field"],
];

describe("SecuritySettings", () => {
  it("defaults the radio to §4.1's ask and persists a change", async () => {
    render(<SecuritySettings />);
    await waitFor(() => expect(screen.getByLabelText(/default/i)).toBeTruthy());
    const ask = screen.getByRole("radio", { name: /^ask /i }) as HTMLInputElement;
    expect(ask.checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /^auto/i }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const stored = await fakeBrowser.storage.local.get("junior_settings");
    expect((stored.junior_settings as { permissionMode: string }).permissionMode).toBe("auto");
  });

  it("renders the matrix by evaluating the pure permissionDecision", async () => {
    render(<SecuritySettings />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    for (const [label, code] of ROWS) {
      const row = screen.getByRole("row", { name: new RegExp(label.replace(/[()./]/g, "\\$&")) });
      const cells = row.querySelectorAll("td");
      // cells[0] is the label; the three mode cells follow.
      expect(cells).toHaveLength(PERMISSION_MODES.length + 1);
      PERMISSION_MODES.forEach((mode, i) => {
        expect(cells[i + 1]!.textContent).toBe(permissionDecision(mode, [code]));
      });
    }
  });

  it("keeps the §6.3-4 invariant visible: secret fields deny in every mode", async () => {
    render(<SecuritySettings />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    const row = screen.getByRole("row", { name: /Password \/ secret field/ });
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(PERMISSION_MODES.length + 1);
    PERMISSION_MODES.forEach((_, i) => {
      expect(cells[i + 1]!.textContent).toBe("deny");
    });
  });
});
