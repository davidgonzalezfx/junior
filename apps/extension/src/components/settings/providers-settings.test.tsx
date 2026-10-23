// M2-4 — Settings→Providers UI over stubbed fetch: masked view renders, the Save PUT
// carries only keys the user typed (absent = keep, plan §5.3/decisions.md), the chain
// is filtered to configured ids, and the Test button surfaces the bridge's verdict.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvidersSettings } from "@/components/settings/providers-settings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = {
  anthropicKeyMasked: "…abcd",
  openaiCompatible: [
    {
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      hasApiKey: true,
    },
  ],
  fallbackChain: ["anthropic", "openrouter"],
};

interface Put {
  url: string;
  body: Record<string, unknown>;
}

let puts: Put[] = [];
let testResults: Array<Record<string, unknown>> = [];

function stubFetch() {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/config") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(VIEW), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/config") && init?.method === "PUT") {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/config/test")) {
      return new Response(
        JSON.stringify(testResults.shift() ?? { ok: true, models: ["m1", "m2"] }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
}

describe("ProvidersSettings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    puts = [];
    testResults = [];
  });

  it("renders the masked view; saving sends typed keys only + a configured chain", async () => {
    await browser.storage.local.set({ junior_bridge_token: "t".repeat(64) });
    vi.stubGlobal("fetch", stubFetch());

    render(<ProvidersSettings onBack={() => {}} />);
    await screen.findByText("Settings — Providers");

    // Masked state is shown, never a raw key.
    expect(screen.getByText(/stored — type to replace/)).toBeTruthy();

    // Type a NEW anthropic key; leave the openrouter entry's key untouched.
    fireEvent.change(screen.getByLabelText("API key (stored — type to replace)"), {
      target: { value: "sk-brand-new" },
    });
    fireEvent.change(screen.getByLabelText("Label for openrouter"), {
      target: { value: "Renamed" },
    });

    // An http-to-public base URL is refused inline (§5.3 validation) — and blocks nothing
    // except itself: fix it before saving.
    fireEvent.change(screen.getByLabelText("Base URL for openrouter"), {
      target: { value: "http://api.example.com/v1" },
    });
    expect(screen.getByText(/plain http is only allowed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Base URL for openrouter"), {
      target: { value: "https://openrouter.ai/api/v1" },
    });

    // Remove anthropic from the chain, then save.
    fireEvent.click(screen.getByLabelText("Remove anthropic from chain"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    const body = puts[0]!.body as { providers: Record<string, unknown> };
    expect(body.providers.anthropicKey).toBe("sk-brand-new");
    expect(body.providers.fallbackChain).toEqual(["openrouter"]);
    const entries = body.providers.openaiCompatible as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "openrouter",
      label: "Renamed",
      baseUrl: "https://openrouter.ai/api/v1",
      // no apiKey field — the user never typed one, so the bridge keeps the stored key
    });
    expect(screen.getByText("Saved ✓")).toBeTruthy();
  });

  it("the Test button shows the bridge's models verdict", async () => {
    await browser.storage.local.set({ junior_bridge_token: "t".repeat(64) });
    testResults.push({ ok: false, error: "401" });
    vi.stubGlobal("fetch", stubFetch());

    render(<ProvidersSettings onBack={() => {}} />);
    await screen.findByText("Settings — Providers");
    fireEvent.click(screen.getAllByRole("button", { name: /Test/ })[0]!);
    await waitFor(() => {
      expect(screen.getByText(/failed: 401/)).toBeTruthy();
    });
  });
});
