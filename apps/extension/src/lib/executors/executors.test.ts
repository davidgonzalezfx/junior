// Runner integration tests: executeAction drives the REAL juniorActionInPage
// against jsdom through a fake ExecutorEnv — probe, guard verdict and act all run
// the shipping code path; only the chrome.* boundary is faked.
/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  BLOCKED_SENSITIVE_TEXT,
  USER_DENIED_TEXT,
  type ApprovalRequest,
  type BrowserAction,
} from "@junior/protocol";
import { executeAction, isRestrictedUrl, type ExecutorEnv } from "./index";
import { juniorActionInPage, type InPageRequest } from "./in-page";
import { juniorReadTextInPage, type BuildDomTreeArgs, type ReadTextRequest } from "./read-page";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

function makeEnv(
  opts: {
    dom?: string;
    tabUrl?: string;
    mode?: "ask" | "auto" | "none";
    overrides?: Partial<ExecutorEnv>;
  } = {},
): ExecutorEnv {
  document.body.innerHTML = opts.dom ?? "";
  document.body.querySelectorAll("*").forEach((el) => {
    el.getBoundingClientRect = () =>
      ({
        width: 100,
        height: 20,
        top: 0,
        left: 0,
        right: 100,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return {
    getActiveTab: vi.fn(async () => ({
      id: 1,
      url: opts.tabUrl ?? "https://example.com/",
      title: "Example",
      status: "complete",
    })),
    runInPage: vi.fn(async (_tabId: number, args: InPageRequest) => await juniorActionInPage(args)),
    runReadInPage: vi.fn(
      async (_tabId: number, args: ReadTextRequest) => await juniorReadTextInPage(args),
    ),
    runBuildDomTree: vi.fn(async (_tabId: number, _args: BuildDomTreeArgs) => null),
    captureVisibleTab: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
    permissionMode: vi.fn(async () => opts.mode ?? "auto"),
    blockedOrigins: vi.fn(async () => ["http://127.0.0.1:8620" as const]),
    navigateTab: vi.fn(async () => {}),
    ...opts.overrides,
  };
}

describe("click", () => {
  it("probe → guard → act with the shipping code (auto mode, benign)", async () => {
    const env = makeEnv({ dom: `<button id="go">Do it</button>`, mode: "auto" });
    const res = await executeAction({ kind: "click", target: "Do it" }, env);
    expect(res.status).toBe("ok");
    expect(String(res.result)).toContain("Click performed on");
    expect(env.runInPage).toHaveBeenCalledTimes(2); // probe + act
  });

  it("ask mode with no panel answer default-denies before acting (§6.3-3)", async () => {
    const env = makeEnv({ dom: `<button>Do it</button>`, mode: "ask" });
    const res = await executeAction({ kind: "click", target: "Do it" }, env);
    expect(res.status).toBe("denied");
    expect(res.error).toBe(USER_DENIED_TEXT);
    expect(env.runInPage).toHaveBeenCalledTimes(1); // probe only, never the act
  });

  it("an ask() that approves lets the click through", async () => {
    const env = makeEnv({ dom: `<button>Do it</button>`, mode: "ask" });
    const ask = vi.fn(async (_approval: ApprovalRequest) => "once" as const);
    const res = await executeAction({ kind: "click", target: "Do it" }, env, { ask });
    expect(res.status).toBe("ok");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      pageUrl: "https://example.com/",
      siteDomain: "example.com",
    });
  });

  it("not-found elements are an error, not a crash", async () => {
    const env = makeEnv({ dom: `<p>nothing clickable</p>`, mode: "auto" });
    const res = await executeAction({ kind: "click", target: "missing" }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("Element not found");
  });
});

describe("type", () => {
  it("types into a benign field in auto mode", async () => {
    const env = makeEnv({ dom: `<input id="q" name="query">`, mode: "auto" });
    const res = await executeAction({ kind: "type", target: "query", text: "hello" }, env);
    expect(res.status).toBe("ok");
    const input = document.body.querySelector("#q") as HTMLInputElement;
    expect(input.value).toBe("hello");
  });

  it("refuses secret fields in every mode, before any act", async () => {
    for (const mode of ["ask", "auto", "none"] as const) {
      const env = makeEnv({ dom: `<input type="password" name="pw">`, mode });
      const res = await executeAction({ kind: "type", target: "pw", text: "hunter2" }, env);
      expect(res.status).toBe("denied");
      expect(res.error).toBe(BLOCKED_SENSITIVE_TEXT);
      expect(env.runInPage).toHaveBeenCalledTimes(1);
    }
  });
});

describe("tab gate", () => {
  it("refuses restricted pages before any injection", async () => {
    const env = makeEnv({ tabUrl: "chrome://settings" });
    const res = await executeAction({ kind: "click", target: "x" }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("internal Chrome pages");
    expect(env.runInPage).not.toHaveBeenCalled();
  });

  it("errors when there is no active tab", async () => {
    const env = makeEnv({ overrides: { getActiveTab: vi.fn(async () => null) } });
    const res = await executeAction({ kind: "scroll", direction: "down" }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("No active browser tab");
  });

  it("isRestrictedUrl covers the Autono list", () => {
    for (const url of [
      "chrome://settings",
      "about:blank",
      "file:///etc/passwd",
      "data:text/html,x",
      undefined as unknown as string,
    ]) {
      expect(isRestrictedUrl(url)).toBe(true);
    }
    expect(isRestrictedUrl("https://example.com/")).toBe(false);
  });
});

describe("navigate", () => {
  it("navigates to a valid public URL", async () => {
    const env = makeEnv();
    const res = await executeAction({ kind: "navigate", url: "https://example.com/docs" }, env);
    expect(res.status).toBe("ok");
    expect(env.navigateTab).toHaveBeenCalledWith(1, "https://example.com/docs");
  });

  it("denies non-http(s) and blocked-origin targets (extension-side mirror)", async () => {
    const env = makeEnv();
    const fileRes = await executeAction({ kind: "navigate", url: "file:///etc/passwd" }, env);
    expect(fileRes.status).toBe("denied");
    expect(fileRes.error).toContain("Navigation blocked");

    const bridgeRes = await executeAction(
      { kind: "navigate", url: "http://127.0.0.1:8620/api/status" },
      env,
    );
    expect(bridgeRes.status).toBe("denied");
    expect(env.navigateTab).not.toHaveBeenCalled();
  });
});

describe("scroll", () => {
  it("passes direction and amount to the page", async () => {
    const env = makeEnv({ dom: `<p>x</p>` });
    const res = await executeAction({ kind: "scroll", direction: "up", amount: 250 }, env);
    expect(res.status).toBe("ok");
    expect(res.result).toBe("Scrolled up");
  });
});

describe("screenshot + get_active_tab + read_page", () => {
  it("returns a size-capped data URL", async () => {
    const env = makeEnv();
    const res = await executeAction({ kind: "screenshot" }, env);
    expect(res.status).toBe("ok");
    expect((res.result as { dataUrl: string }).dataUrl.startsWith("data:image/")).toBe(true);
  });

  it("errors when capture fails", async () => {
    const env = makeEnv({
      overrides: {
        captureVisibleTab: vi.fn(async () => {
          throw new Error("no active window");
        }),
      },
    });
    const res = await executeAction({ kind: "screenshot" }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("no active window");
  });

  it("errors on oversized captures (§6.3-6)", async () => {
    const env = makeEnv({
      overrides: {
        captureVisibleTab: vi.fn(async () => `data:image/jpeg;base64,${"A".repeat(3_100_000)}`),
      },
    });
    const res = await executeAction({ kind: "screenshot" }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("too large");
  });

  it("T1: reveals the resolved tab and captures its window", async () => {
    const seen: number[] = [];
    const captured: Array<number | undefined> = [];
    const env = makeEnv({
      overrides: {
        getActiveTab: vi.fn(async () => ({
          id: 9,
          url: "https://fixture.junior.test/",
          title: "t",
          status: "complete",
          windowId: 4,
        })),
        revealTab: vi.fn(async (tabId: number) => {
          seen.push(tabId);
        }),
        captureVisibleTab: vi.fn(async (windowId?: number) => {
          captured.push(windowId);
          return "data:image/jpeg;base64,AAAA";
        }),
      },
    });
    const res = await executeAction({ kind: "screenshot" }, env);
    expect(res.status).toBe("ok");
    expect(seen).toEqual([9]);
    expect(captured).toEqual([4]);
  });

  it("T1: errors when there is no tab to screenshot", async () => {
    const env = makeEnv({ overrides: { getActiveTab: vi.fn(async () => null) } });
    const res = await executeAction({ kind: "screenshot" }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("No browser tab to screenshot");
  });

  it("get_active_tab returns capped page facts", async () => {
    const env = makeEnv();
    const res = await executeAction({ kind: "get_active_tab" } as BrowserAction, env);
    expect(res.status).toBe("ok");
    expect(res.result).toEqual({
      title: "Example",
      url: "https://example.com/",
      status: "complete",
    });
  });

  it("read_page text returns capped body text via the shipping in-page fn", async () => {
    const env = makeEnv({ dom: `<body><p>hello   world</p></body>` });
    const res = await executeAction({ kind: "read_page", mode: "text", maxChars: 8000 }, env);
    expect(res.status).toBe("ok");
    expect(res.result).toBe("hello world");
  });

  it("read_page on a restricted page is refused (§6.3)", async () => {
    const env = makeEnv({ tabUrl: "chrome://version/" });
    const res = await executeAction({ kind: "read_page", mode: "text", maxChars: 8000 }, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("not permitted on internal Chrome pages");
  });
});
