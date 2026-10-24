// read_page tests (M3-2): juniorReadTextInPage (text/section) against jsdom, the
// runner's read_page routing, and the REAL vendored buildDomTree.js evaluated in
// jsdom with stubbed layout — outline/interactive output, __junior_dom_map
// population, URL invalidation, and resolver integration (click "[1]" via map).
/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserActionSchema, type BrowserAction, type PermissionMode } from "@junior/protocol";
import { executeAction, type ExecutorEnv } from "./index";
import { juniorActionInPage } from "./in-page";
import { juniorReadTextInPage, type BuildDomTreeArgs, type ReadTextRequest } from "./read-page";

const VENDOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../public/vendor/buildDomTree.js",
);

// ── jsdom layout stubs (M3-1 pattern, extended for buildDomTree's machinery):
// distinct y-stacked rects per element so document.elementFromPoint can resolve
// honestly, and offsetWidth/Height on the prototype for isElementVisible. ──
function stubLayout() {
  const els = Array.from(document.body.querySelectorAll("*"));
  els.forEach((el, i) => {
    const top = (i + 1) * 30; // body itself (i=0 in other stubs) stays at index order
    const rect = {
      width: 100,
      height: 20,
      top,
      left: 0,
      right: 100,
      bottom: top + 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
    el.getBoundingClientRect = () => rect;
    el.getClientRects = () => [rect] as unknown as DOMRectList;
  });
  document.elementFromPoint = ((x: number, y: number) => {
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  }) as unknown as Document["elementFromPoint"];
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  for (const prop of ["offsetWidth", "offsetHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      get: () => 100,
      configurable: true,
    });
  }
});

beforeEach(() => {
  document.body.innerHTML = "";
  const win = window as unknown as Record<string, unknown>;
  delete win.__junior_dom_map;
  delete win.__junior_dom_map_url;
  delete win.buildDomTree;
});

// ── juniorReadTextInPage (text / section) ────────────────────────────────────

describe("juniorReadTextInPage", () => {
  async function read(args: ReadTextRequest) {
    return await juniorReadTextInPage(args);
  }

  it("text mode: body text, whitespace-collapsed", async () => {
    document.body.innerHTML = "<p>hello</p> <p>big\n\t world</p>";
    const res = await read({ mode: "text", maxChars: 8000 });
    expect(res).toMatchObject({ ok: true, text: "hello big world" });
  });

  it("text mode: caps at maxChars with a truncation note (§6.3-6)", async () => {
    document.body.innerHTML = `<p>${"ab ".repeat(500)}</p>`;
    const res = await read({ mode: "text", maxChars: 200 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.length).toBe(200);
    expect(res.text).toContain("[truncated at 200 chars");
  });

  it("text mode: selector targets a subtree", async () => {
    document.body.innerHTML = `<main>main text</main><footer>footer text</footer>`;
    const res = await read({ mode: "text", selector: "footer", maxChars: 8000 });
    expect(res).toMatchObject({ ok: true, text: "footer text" });
  });

  it("section mode: requires a selector", async () => {
    const res = await read({ mode: "section", maxChars: 8000 });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("requires a selector");
  });

  it("section mode: returns the querySelector subtree, capped", async () => {
    document.body.innerHTML = `<section id="s"><h2>Title</h2><p>Para one.</p><p>${"more ".repeat(100)}</p></section><p>outside</p>`;
    const res = await read({ mode: "section", selector: "#s", maxChars: 300 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("Title");
    expect(res.text).toContain("[truncated at 300 chars");
    expect(res.text).not.toContain("outside");
  });

  it("section mode: invalid selector and no-match are errors", async () => {
    const bad = await read({ mode: "section", selector: "a[href='#'", maxChars: 8000 });
    expect(bad).toMatchObject({ ok: false });
    const none = await read({ mode: "section", selector: "#missing", maxChars: 8000 });
    expect(none).toMatchObject({ ok: false });
  });
});

// ── Runner routing ───────────────────────────────────────────────────────────

describe("read_page routing in executeAction", () => {
  function makeEnv(overrides: Partial<ExecutorEnv> = {}): ExecutorEnv {
    document.body.innerHTML = "<p>body text</p>";
    return {
      getActiveTab: vi.fn(async () => ({
        id: 1,
        url: "https://example.com/",
        title: "Example",
        status: "complete",
      })),
      runInPage: vi.fn(async (_t: number, args: InPageReq) => await juniorActionInPage(args)),
      runReadInPage: vi.fn(
        async (_t: number, args: ReadTextRequest) => await juniorReadTextInPage(args),
      ),
      runBuildDomTree: vi.fn(async (_t: number, args: BuildDomTreeArgs) => ({
        text: `[1] a "Link" (https://example.com/x) mode=${args.mode} cap=${args.maxChars}`,
      })),
      captureVisibleTab: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
      permissionMode: vi.fn(async (): Promise<PermissionMode> => "auto"),
      blockedOrigins: vi.fn(async () => ["http://127.0.0.1:8620"]),
      navigateTab: vi.fn(async () => {}),
      ...overrides,
    };
  }
  type InPageReq = Parameters<typeof juniorActionInPage>[0];

  it("outline routes through runBuildDomTree with mode+maxChars", async () => {
    const env = makeEnv();
    const res = await executeAction(
      { kind: "read_page", mode: "outline", maxChars: 4000 } as BrowserAction,
      env,
    );
    expect(res.status).toBe("ok");
    expect(res.result).toBe('[1] a "Link" (https://example.com/x) mode=outline cap=4000');
  });

  it("interactive mode passes its maxChars default", async () => {
    const env = makeEnv();
    const res = await executeAction(
      BrowserActionSchema.parse({ kind: "read_page", mode: "interactive" }),
      env,
    );
    expect(res.status).toBe("ok");
    expect(res.result).toContain("mode=interactive cap=8000");
  });

  it("injection failure (null) is an error outcome", async () => {
    const env = makeEnv({ runBuildDomTree: vi.fn(async () => null) });
    const res = await executeAction({ kind: "read_page", mode: "outline" } as BrowserAction, env);
    expect(res.status).toBe("error");
    expect(res.error).toContain("reader injection failed");
  });

  it("section routes through runReadInPage with the selector", async () => {
    const env = makeEnv();
    document.body.innerHTML = `<article>inner article</article>`;
    const res = await executeAction(
      { kind: "read_page", mode: "section", selector: "article", maxChars: 8000 } as BrowserAction,
      env,
    );
    expect(res.status).toBe("ok");
    expect(env.runReadInPage).toHaveBeenCalledWith(expect.any(Number), {
      mode: "section",
      selector: "article",
      maxChars: 8000,
    });
    expect(res.result).toBe("inner article");
  });
});

// ── The REAL vendored buildDomTree.js in jsdom ──────────────────────────────

function loadVendoredBuildDomTree() {
  // Evaluates the vendored file in this realm — it defines window.buildDomTree.
  new Function(readFileSync(VENDOR_PATH, "utf8"))();
}

function buildDomTreeFn(): (args: Record<string, unknown>) => unknown {
  const fn = (window as unknown as Record<string, unknown>).buildDomTree;
  if (typeof fn !== "function") throw new Error("vendored buildDomTree.js did not define itself");
  return fn as (args: Record<string, unknown>) => unknown;
}

describe("vendored buildDomTree.js (real file, jsdom)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a href="https://example.com/link">A link</a>
      <button>Press me</button>
      <input type="text" name="query" placeholder="Search" value="hello">
      <input type="password" name="pw" value="hunter2">
    `;
    stubLayout();
    loadVendoredBuildDomTree();
  });

  it("outline: compact [index] tag text (href) lines, DOM order", () => {
    const out = buildDomTreeFn()({ mode: "outline", maxChars: 8000 }) as { text: string };
    const lines = out.text.split("\n");
    // Indexes are 0-based (upstream default startHighlightIndex: 0).
    expect(lines[0]).toBe('[0] a "A link" (https://example.com/link)');
    expect(lines[1]).toBe('[1] button "Press me"');
    expect(lines.some((l) => l.startsWith("[2] input"))).toBe(true);
    expect(out.text).not.toContain("hunter2"); // values never in outline mode
  });

  it("interactive: adds type/role/value; sensitive values masked", () => {
    const out = buildDomTreeFn()({ mode: "interactive", maxChars: 8000 }) as { text: string };
    expect(out.text).toContain('type=text value="hello"');
    expect(out.text).toContain("[PROTECTED_INPUT]");
    expect(out.text).not.toContain("hunter2");
  });

  it("caps output at maxChars with a note", () => {
    const out = buildDomTreeFn()({ mode: "outline", maxChars: 30 }) as { text: string };
    expect(out.text).toContain("[truncated at 30 chars");
  });

  it("populates __junior_dom_map, sets data-highlight-index, stamps the URL", () => {
    buildDomTreeFn()({ mode: "outline", maxChars: 8000 });
    const win = window as unknown as {
      __junior_dom_map?: Map<number, Element>;
      __junior_dom_map_url?: string;
    };
    expect(win.__junior_dom_map_url).toBe(window.location.href);
    const map = win.__junior_dom_map;
    expect(map).toBeInstanceOf(Map);
    expect(map!.size).toBeGreaterThanOrEqual(4);
    const link = map!.get(0);
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("data-highlight-index")).toBe("0");
  });

  it("resolver integration: click '[1]' resolves through the map; SPA URL change invalidates it", async () => {
    buildDomTreeFn()({ mode: "outline", maxChars: 8000 });
    // Remove the data-highlight-index attributes so only the map can resolve.
    document.body
      .querySelectorAll("[data-highlight-index]")
      .forEach((el) => el.removeAttribute("data-highlight-index"));

    const win = window as unknown as {
      __junior_dom_map?: Map<number, Element>;
      __junior_dom_map_url?: string;
    };
    let clicked: Element | null = null;
    const target = win.__junior_dom_map!.get(0)!;
    target.addEventListener("click", () => {
      clicked = target;
    });

    const before = await juniorActionInPage({ op: "click", target: "[0]", expect: null });
    expect(before.ok).toBe(true);
    expect(clicked).toBe(target);

    // SPA URL change without a rebuild → the stale map must not resolve.
    history.pushState({}, "", "/next-page");
    const after = await juniorActionInPage({ op: "click", target: "[0]", expect: null });
    expect(after.ok).toBe(false);

    // A rebuild at the new URL refreshes the map and resolution works again.
    buildDomTreeFn()({ mode: "outline", maxChars: 8000 });
    const healed = await juniorActionInPage({ op: "click", target: "[0]", expect: null });
    expect(healed.ok).toBe(true);
  });
});
