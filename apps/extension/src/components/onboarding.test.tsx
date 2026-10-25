// Onboarding flow (M5-2 polish): step dots, step-1 auto-check, pair → provider →
// done. bridge-client + pairing are module-mocked — this tests the component's
// step machine, not the wire (pairing decision tree has its own tests).
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Onboarding } from "@/components/onboarding";
import type { BridgeStatus } from "@junior/protocol";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => fakeBrowser.reset());

// CopyCommand writes to navigator.clipboard — jsdom has none.
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn(async () => {}) },
  configurable: true,
});

vi.mock("@/lib/bridge-client", async (importOriginal) => ({
  ...(await importOriginal<object>()), // keep BridgeUnreachableError real
  fetchHealth: vi.fn(async () => true),
  fetchStatus: vi.fn(async () => STATUS),
}));

vi.mock("@/lib/pairing", () => ({
  ensureToken: vi.fn(async () => "t".repeat(64)),
  pairWithBridge: vi.fn(async () => ({ status: "paired", alreadyPaired: true })),
}));

import { fetchHealth } from "@/lib/bridge-client";

const STATUS: BridgeStatus = {
  version: "0.0.0",
  apiLevel: 1,
  providers: [
    { id: "anthropic", kind: "anthropic", label: "Anthropic", available: true, models: [] },
  ],
  browserConnected: true,
  queueDepth: 0,
};

function renderOnboarding() {
  const onDone = vi.fn();
  render(<Onboarding onDone={onDone} />);
  return { onDone };
}

describe("Onboarding", () => {
  afterEach(() => cleanup());

  it("starts on step 1 of 3 and auto-advances to pairing when the bridge is up", async () => {
    const { onDone } = renderOnboarding();
    expect(screen.getByLabelText("Step 1 of 3")).toBeDefined();

    // Auto-check (no click): health ok → pair runs by itself → provider pick.
    await waitFor(() => {
      expect(screen.getByLabelText("Step 3 of 3")).toBeDefined();
    });
    expect(fetchHealth).toHaveBeenCalled();

    // ProviderStep fetches /api/status on mount — wait for its buttons.
    // ProviderStep fetches /api/status on mount — wait for its buttons.
    (await screen.findByRole("button", { name: /Anthropic/ })).click();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // The provider choice seeded the default.
    expect(await browser.storage.local.get("junior_default_provider")).toMatchObject({
      junior_default_provider: { providerId: "anthropic" },
    });
  });

  it("stays on step 1 with a hint when the bridge is down, then Check again advances", async () => {
    let up = false;
    vi.mocked(fetchHealth).mockImplementation(async () => up);
    renderOnboarding();
    expect(await screen.findByText(/Bridge not reachable/)).toBeDefined();
    expect(screen.getByLabelText("Step 1 of 3")).toBeDefined();

    up = true;
    screen.getByRole("button", { name: /Check again/ }).click();
    await waitFor(() => expect(screen.getByLabelText("Step 3 of 3")).toBeDefined());
  });

  it("Skip for now finishes from step 1 without touching providers", async () => {
    const { onDone } = renderOnboarding();
    screen.getByRole("button", { name: "Skip for now" }).click();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await browser.storage.local.get("junior_onboarded")).toMatchObject({
      junior_onboarded: true,
    });
  });
});
