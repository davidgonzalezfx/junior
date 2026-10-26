// T5b strict targeting: an index, CSS selector or XPath that misses must fail —
// never fall through to fuzzy attribute/text matching (the Udemy run clicked a
// "Home" link for `[0]` and a "Photo & Video Editing Tools" banner for `video`).
/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeVisible, stubJsdomElementBasics } from "@junior/testkit/jsdom";
import { juniorActionInPage } from "./in-page";

type MapWindow = { __junior_dom_map?: Map<number, Element>; __junior_dom_map_url?: string };

beforeAll(() => {
  stubJsdomElementBasics();
});

beforeEach(() => {
  const win = window as unknown as MapWindow;
  delete win.__junior_dom_map;
  delete win.__junior_dom_map_url;
});

function setBody(html: string): void {
  document.body.innerHTML = html;
  document.body.querySelectorAll("*").forEach(makeVisible);
}

function setMap(entries: [number, Element][]): void {
  const win = window as unknown as MapWindow;
  win.__junior_dom_map = new Map(entries);
  win.__junior_dom_map_url = window.location.href;
}

/** Records every click on the page. */
function clicks(): string[] {
  const seen: string[] = [];
  document.body.addEventListener("click", (e) => {
    seen.push(((e.target as Element).textContent ?? "").trim());
  });
  return seen;
}

describe("index targets", () => {
  it("a stale data-highlight-index from an earlier read does not beat the current map", async () => {
    // Read 1 gave the header link index 0; read 2 (after a scroll) gave it to the
    // play overlay. buildDomTree never removes the old attribute.
    setBody(
      `<a href="/" data-highlight-index="0">Home</a><button id="play" data-highlight-index="0">Play</button>`,
    );
    setMap([[0, document.getElementById("play")!]]);
    const seen = clicks();
    const res = await juniorActionInPage({ op: "click", target: "[0]", expect: null });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["Play", "Play"]);
  });

  it("a missed index fails and clicks nothing", async () => {
    setBody(`<a href="/">Home</a><button>0</button><button>Play 5</button>`);
    setMap([[0, document.querySelector("a")!]]);
    const seen = clicks();
    const res = await juniorActionInPage({ op: "click", target: "5", expect: null });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/Index 5 not found.*read_page again/);
    expect(seen).toEqual([]);
  });

  it("an index with no map (or a map from another URL) fails instead of guessing", async () => {
    setBody(`<button>0</button>`);
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: "[0]" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("read_page again");

    setMap([[0, document.querySelector("button")!]]);
    (window as unknown as MapWindow).__junior_dom_map_url = "https://elsewhere.example/";
    const stale = await juniorActionInPage({ op: "probe", mode: "click", target: "[0]" });
    expect(stale).toMatchObject({ ok: false });
  });
});

describe("selector targets", () => {
  it("`video` does not match a banner whose text contains Video", async () => {
    setBody(`
      <a href="/courses/photo">Photo & Video Editing Tools</a>
      <video src="lecture.mp4"></video>
    `);
    // The player has not laid out yet: zero size.
    const video = document.querySelector("video")!;
    video.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    const seen = clicks();
    const res = await juniorActionInPage({ op: "click", target: "video", expect: null });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/matched nothing visible/);
    expect(seen).toEqual([]);
  });

  it("a valid CSS selector with no match does not fall back to text", async () => {
    setBody(
      `<a href="/x">Jump to #player</a><button title="[data-purpose=control-play]">x</button>`,
    );
    for (const target of [
      "#player",
      '[data-purpose="control-play"]',
      'button[aria-label*="play"]',
    ]) {
      const res = await juniorActionInPage({ op: "probe", mode: "click", target });
      expect(res, target).toMatchObject({ ok: false });
      if (!res.ok) expect(res.error, target).toMatch(/matched nothing visible/);
    }
  });

  it("an XPath with no match does not fall back to text", async () => {
    setBody(`<a href="/x">//button[@id='nope']</a>`);
    const res = await juniorActionInPage({
      op: "probe",
      mode: "click",
      target: "//button[@id='nope']",
    });
    expect(res).toMatchObject({ ok: false });
  });

  it("the first VISIBLE match wins, and open shadow roots are searched", async () => {
    setBody(`<button class="ctl" style="display:none">Hidden</button><div id="host"></div>`);
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button class="ctl" aria-label="Pause">II</button>`;
    makeVisible(root.querySelector("button")!);
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: ".ctl" });
    expect(res).toMatchObject({ ok: true, facts: { ariaLabel: "Pause" } });
    const byText = await juniorActionInPage({ op: "probe", mode: "click", target: "Pause" });
    expect(byText).toMatchObject({ ok: true, facts: { ariaLabel: "Pause" } });
  });
});

describe("free text", () => {
  it("an exact attribute match beats an earlier substring match", async () => {
    setBody(`<button aria-label="Play next video">A</button><button aria-label="Play">B</button>`);
    const res = await juniorActionInPage({ op: "probe", mode: "click", target: "Play" });
    expect(res).toMatchObject({ ok: true, facts: { ariaLabel: "Play" } });
  });

  it("text: forces text matching for a word that is also a tag name", async () => {
    setBody(`<button>video</button>`);
    expect(
      await juniorActionInPage({ op: "probe", mode: "click", target: "text:video" }),
    ).toMatchObject({ ok: true });
  });

  it("a lone digit inside a longer target never matches by reverse containment", async () => {
    setBody(`<a href="/">0</a>`);
    const res = await juniorActionInPage({
      op: "probe",
      mode: "click",
      target: "Episode 10 player",
    });
    expect(res).toMatchObject({ ok: false });
  });
});

describe("hit report", () => {
  it("click and type results say what they hit and how", async () => {
    setBody(`<a id="home" href="/home">Home</a><input id="q" name="q">`);
    setMap([[0, document.getElementById("home")!]]);
    const res = await juniorActionInPage({ op: "click", target: "[0]", expect: null });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toContain('<a> "Home"');
      expect(res.message).toContain(new URL("/home", document.baseURI).href);
      expect(res.message).toContain("matched by index");
    }
    const typed = await juniorActionInPage({
      op: "type",
      target: "#q",
      text: "x",
      expect: null,
      charDelayMs: 0,
    });
    if (typed.ok) expect(typed.message).toContain("<input>");
    expect(typed.ok && typed.message).toContain("matched by css");
  });
});
