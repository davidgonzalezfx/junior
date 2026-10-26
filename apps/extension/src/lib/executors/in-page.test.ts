// In-page executor tests: juniorActionInPage runs DIRECTLY against jsdom — the
// same function executeScript will serialize into the tab (self-containment means
// there is exactly one implementation to test). jsdom quirks handled here:
// zero rects (stubbed per element), no scrollIntoView (prototype noop), no
// PointerEvent (the in-page code falls back to MouseEvent), no innerText
// (textContent fallback inside the resolver).
/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeVisible, stubJsdomElementBasics } from "@junior/testkit/jsdom";
import { juniorActionInPage, type InPageClickFacts, type InPageFieldFacts } from "./in-page";

beforeAll(() => {
  stubJsdomElementBasics();
});

function setBody(html: string): void {
  document.body.innerHTML = html;
  document.body.querySelectorAll("*").forEach(makeVisible);
}

function hide(selector: string): void {
  const el = document.body.querySelector(selector);
  if (el) (el as HTMLElement).style.display = "none";
}

/** jsdom implements XPath via document.evaluate — assert it exists so a future
 * jsdom regression fails loudly here instead of silently skipping strategy 3. */
const supportsXPath = typeof document.evaluate === "function";

describe("resolver strategies", () => {
  beforeEach(() => {
    const win = window as unknown as {
      __junior_dom_map?: Map<number, Element>;
      __junior_dom_map_url?: string;
    };
    delete win.__junior_dom_map;
    delete win.__junior_dom_map_url;
  });

  it("1. index match via __junior_dom_map only (the attribute can be stale)", async () => {
    setBody(`<button data-highlight-index="7">Save</button>`);
    const res = await juniorActionInPage({ op: "click", target: "[7]", expect: null });
    expect(res.ok).toBe(false);

    const mapped = document.createElement("button");
    mapped.textContent = "Mapped";
    document.body.appendChild(mapped);
    makeVisible(mapped);
    // The map is trusted only while its build-time URL stamp matches (M3-2).
    const win = window as unknown as {
      __junior_dom_map?: Map<number, Element>;
      __junior_dom_map_url?: string;
    };
    win.__junior_dom_map = new Map([[3, mapped]]);
    win.__junior_dom_map_url = window.location.href;
    expect((await juniorActionInPage({ op: "probe", mode: "click", target: "#3" })).ok).toBe(true);
  });

  it("2. CSS selector", async () => {
    setBody(`<button id="signup">Sign up</button>`);
    expect((await juniorActionInPage({ op: "probe", mode: "click", target: "#signup" })).ok).toBe(
      true,
    );
  });

  (supportsXPath ? it : it.skip)("3. XPath locator", async () => {
    setBody(`<button id="xp">XPath target</button>`);
    expect(
      (await juniorActionInPage({ op: "probe", mode: "click", target: "//button[@id='xp']" })).ok,
    ).toBe(true);
  });

  it("4. semantic attributes (aria-label, placeholder, data-testid, name)", async () => {
    setBody(`
      <button aria-label="Close dialog">X</button>
      <input placeholder="Search the docs">
      <button data-testid="submit-order">Go</button>
      <input name="newsletter">
    `);
    expect(
      (await juniorActionInPage({ op: "probe", mode: "click", target: "close dialog" })).ok,
    ).toBe(true);
    expect((await juniorActionInPage({ op: "probe", mode: "type", target: "search the" })).ok).toBe(
      true,
    );
    expect(
      (await juniorActionInPage({ op: "probe", mode: "click", target: "submit-order" })).ok,
    ).toBe(true);
    expect((await juniorActionInPage({ op: "probe", mode: "type", target: "newsletter" })).ok).toBe(
      true,
    );
  });

  it("5. associated <label> text resolves the field", async () => {
    setBody(`<label for="email">Email address</label><input id="email">`);
    const res = await juniorActionInPage({ op: "probe", mode: "type", target: "email address" });
    expect(res.ok).toBe(true);
    if (res.ok && res.facts && "id" in res.facts) expect(res.facts.id).toBe("email");
  });

  it("6. visible text match (exact beats substring); hidden elements are skipped", async () => {
    setBody(`
      <button aria-label="exact-one">Subscribe</button>
      <button aria-label="long-one">Subscribe to newsletter</button>
    `);
    // "Subscribe" is an exact text match, so it must win over the longer button.
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: "Subscribe" });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.facts) return fail("expected facts");
    expect(res.facts.ariaLabel).toBe("exact-one");

    setBody(`<button>Only one</button><button style="display:none">Hidden</button>`);
    hide("button:nth-child(2)");
    expect((await juniorActionInPage({ op: "probe", mode: "click", target: "Hidden" })).ok).toBe(
      false,
    );
  });

  it("7. heuristic interactivity via class when the pool misses", async () => {
    setBody(`<div class="btn btn-primary">Confirm plan</div>`);
    expect(
      (await juniorActionInPage({ op: "probe", mode: "click", target: "confirm plan" })).ok,
    ).toBe(true);
  });

  it("8. input fallback: focused field, else the single visible input", async () => {
    setBody(`<input type="text">`);
    const input = document.body.querySelector("input") as HTMLInputElement;
    input.focus();
    expect((await juniorActionInPage({ op: "probe", mode: "type", target: "" })).ok).toBe(true);

    (document.activeElement as HTMLElement | null)?.blur?.();
    // two visible inputs and no focus → unresolvable
    setBody(`<input type="text"><input type="text">`);
    expect((await juniorActionInPage({ op: "probe", mode: "type", target: "" })).ok).toBe(false);
  });

  it("returns a not-found response with a clipped target", async () => {
    setBody(`<button>Nothing relevant</button>`);
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: "x".repeat(100) });
    expect(res).toEqual({ ok: false, error: `Element not found: "${"x".repeat(60)}".` });
  });
});

describe("probe facts", () => {
  it("click probe reports real element facts (§6.3-1)", async () => {
    setBody(`
      <a href="/docs/page" title="Docs">Read the docs</a>
    `);
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: "read the docs" });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.facts) return fail("expected facts");
    const facts = res.facts as InPageClickFacts;
    expect(facts.tag).toBe("a");
    expect(facts.text).toBe("Read the docs");
    expect(facts.href).toBe(new URL("/docs/page", document.baseURI).href);
    expect(facts.isSubmit).toBe(false);
  });

  it("click probe marks submit buttons inside forms", async () => {
    setBody(`<form action="/buy"><button>Buy now</button></form>`);
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: "buy now" });
    if (!res.ok || !res.facts) return fail("expected facts");
    expect((res.facts as InPageClickFacts).isSubmit).toBe(true);
    expect((res.facts as InPageClickFacts).formAction).toContain("/buy");
  });

  it("type probe reports field facts including label text", async () => {
    setBody(
      `<label for="cc">Payment card</label><input id="cc" autocomplete="cc-number" placeholder="1234">`,
    );
    const res = await juniorActionInPage({ op: "probe", mode: "type", target: "payment card" });
    if (!res.ok || !res.facts) return fail("expected facts");
    expect(res.facts).toMatchObject({
      tag: "input",
      autocomplete: "cc-number",
      placeholder: "1234",
      labelText: "Payment card",
    });
  });
});

describe("click act", () => {
  it("dispatches the full pointer/mouse sequence and returns a capped label", async () => {
    setBody(
      `<button id="b">Long button label that goes on and on and should be clipped to sixty</button>`,
    );
    const el = document.body.querySelector("#b") as HTMLButtonElement;
    const seen: string[] = [];
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.addEventListener(t, () => seen.push(t));
    }
    const res = await juniorActionInPage({ op: "click", target: "#b", expect: null });
    expect(res.ok).toBe(true);
    // Synthetic sequence + a real el.click() — the second "click" is Autono's
    // ported behavior (background.js:4421–4428) for maximal site compatibility.
    expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click", "click"]);
    if (res.ok) expect(res.message.startsWith("Click performed on")).toBe(true);
  });

  it("refuses to act when the element changed between probe and act", async () => {
    setBody(`<button>Stable</button>`);
    const probe = await juniorActionInPage({ op: "probe", mode: "click", target: "Stable" });
    if (!probe.ok || !probe.facts) return fail("expected probe facts");
    setBody(`<button>Changed</button>`);
    const res = await juniorActionInPage({
      op: "click",
      target: "Changed",
      expect: probe.facts as InPageClickFacts,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("changed");
  });
});

describe("type act", () => {
  it("types per-character with input events, then change", async () => {
    setBody(`<input id="q" type="text">`);
    const el = document.body.querySelector("#q") as HTMLInputElement;
    let inputs = 0;
    el.addEventListener("input", () => inputs++);
    let changes = 0;
    el.addEventListener("change", () => changes++);

    const res = await juniorActionInPage({
      op: "type",
      target: "#q",
      text: "abc",
      expect: null,
      charDelayMs: 0,
    });
    expect(res.ok).toBe(true);
    expect(el.value).toBe("abc");
    expect(inputs).toBe(3);
    expect(changes).toBe(1);
  });

  it("typing through the native descriptor is visible to framework watchers", async () => {
    setBody(`<input id="w" type="text">`);
    const el = document.body.querySelector("#w") as HTMLInputElement;
    // React-style controlled input: the framework replaces the PROTOTYPE value
    // descriptor with a tracked setter (instance overrides would be bypassed —
    // which is exactly why the in-page code reads the prototype descriptor).
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    let tracked = "";
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      configurable: true,
      get() {
        return tracked;
      },
      set(v: string) {
        tracked = v;
        this.setAttribute("data-react-value", v);
      },
    });
    try {
      await juniorActionInPage({
        op: "type",
        target: "#w",
        text: "hi",
        expect: null,
        charDelayMs: 0,
      });
      expect(el.getAttribute("data-react-value")).toBe("hi");
      expect(el.value).toBe("hi"); // the tracker sees the final value too
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, "value", original as PropertyDescriptor);
    }
  });

  it("text ending in a newline submits the form (Enter)", async () => {
    setBody(`<form action="/search"><input id="s" type="text"></form>`);
    const form = document.body.querySelector("form") as HTMLFormElement;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;
    const res = await juniorActionInPage({
      op: "type",
      target: "#s",
      text: "query\n",
      expect: null,
      charDelayMs: 0,
    });
    expect(res.ok).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("expect-check refuses a swapped field", async () => {
    setBody(`<input id="a" name="first"><input id="b" name="second">`);
    const probe = await juniorActionInPage({ op: "probe", mode: "type", target: "first" });
    if (!probe.ok || !probe.facts) return fail("expected probe facts");
    const res = await juniorActionInPage({
      op: "type",
      target: "second",
      text: "x",
      expect: probe.facts as InPageFieldFacts,
      charDelayMs: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("changed");
  });
});

describe("scroll", () => {
  it("scrolls by amount or 70% of the viewport", async () => {
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;

    const down = await juniorActionInPage({ op: "scroll", direction: "down", amount: 300 });
    expect(down).toEqual({ ok: true, message: "Scrolled down" });
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 300, behavior: "smooth" });

    await juniorActionInPage({ op: "scroll", direction: "up" });
    expect(scrollBy).toHaveBeenLastCalledWith({
      top: -Math.round(window.innerHeight * 0.7),
      behavior: "smooth",
    });
  });
});

function fail(message: string): never {
  throw new Error(message);
}
