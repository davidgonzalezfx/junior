// M5-1: the bridge-offline banner (plan §5.3, gap #12 — bridge down must never be a
// silent failure). Online renders the quiet green bar; offline renders a banner with
// the start command + a manual re-check wired to the hook's backoff-bypassing recheck.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BridgeStatusBar } from "@/components/bridge-status-bar";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => fakeBrowser.reset());

function healthStub(mode: "ok" | "fail"): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).endsWith("/api/health")) {
      if (mode === "ok") return new Response(JSON.stringify({ ok: true }));
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
}

describe("BridgeStatusBar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("online: the quiet green bar", async () => {
    vi.stubGlobal("fetch", healthStub("ok"));
    render(<BridgeStatusBar />);
    expect(await screen.findByText("Bridge connected")).toBeTruthy();
    expect(document.querySelector("[data-bridge-offline]")).toBeNull();
  });

  it("offline: a banner with the start command and a Try-again that re-polls", async () => {
    let mode: "ok" | "fail" = "fail";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).endsWith("/api/health")) {
          if (mode === "ok") return new Response(JSON.stringify({ ok: true }));
          throw new TypeError("fetch failed");
        }
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      }),
    );
    render(<BridgeStatusBar />);

    const banner = await screen.findByRole("status");
    expect(banner.getAttribute("data-bridge-offline")).not.toBeNull();
    expect(banner.textContent).toContain("Bridge offline");
    expect(banner.textContent).toContain("junior-bridge serve");

    // Recovery: flip the stub, then the banner's Try-again bypasses the backoff.
    mode = "ok";
    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Bridge connected")).toBeTruthy());
    await waitFor(() => {
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });
    expect(document.querySelector("[data-bridge-offline]")).toBeNull();
  });
});
