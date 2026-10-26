// T5b: fallback labels for controls with no readable text, through the REAL
// vendored buildDomTree.js + the Junior-owned label hook, on a fixture that
// mimics a Udemy-style player control bar (icon-only buttons, one shadow host).
/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stubJsdomElementBasics, stubStackedLayout } from "@junior/testkit/jsdom";
import { juniorActionInPage } from "./in-page";
import { juniorBuildOutlineInPage } from "./outline";

const VENDOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../public/vendor/buildDomTree.js",
);

const CONTROL_BAR = `
  <div data-purpose="video-controls">
    <button type="button" data-purpose="play-button"><svg><use href="#icon-play"></use></svg></button>
    <button type="button" aria-label="Rewind 5 seconds"><svg><use xlink:href="#icon-rewind"></use></svg></button>
    <button type="button" title="Mute"><svg></svg></button>
    <button type="button"><span class="ud-icon ud-icon-settings"></span></button>
    <button type="button" aria-pressed="false" data-testid="captions-toggle"><svg></svg></button>
    <button type="button">1.5x</button>
    <div id="host"></div>
  </div>`;

beforeAll(() => {
  stubJsdomElementBasics({ offsetSize: true });
});

beforeEach(() => {
  const win = window as unknown as Record<string, unknown>;
  delete win.__junior_dom_map;
  delete win.__junior_dom_map_url;
  delete win.__junior_label_of;
  delete win.buildDomTree;
  document.body.innerHTML = CONTROL_BAR;
  const root = document.getElementById("host")!.attachShadow({ mode: "open" });
  root.innerHTML = `<button type="button" aria-label="Fullscreen"><svg></svg></button>`;
  stubStackedLayout(document);
  const inner = root.querySelector("button")!;
  const rect = { width: 100, height: 20, top: 600, left: 0, right: 100, bottom: 620 } as DOMRect;
  inner.getBoundingClientRect = () => rect;
  inner.getClientRects = () => [rect] as unknown as DOMRectList;
  new Function(readFileSync(VENDOR_PATH, "utf8"))();
});

function outline(mode: "outline" | "interactive" = "outline"): string[] {
  const res = juniorBuildOutlineInPage({ mode, maxChars: 8000 }) as { text: string };
  return res.text.split("\n");
}

describe("outline fallback labels", () => {
  it("icon-only controls get labels from data-purpose, icons, aria, title and state", () => {
    const lines = outline();
    expect(lines).toContain('[0] button data-purpose="play-button" icon="play"');
    expect(lines).toContain('[1] button aria-label="Rewind 5 seconds" icon="rewind"');
    expect(lines).toContain('[2] button title="Mute"');
    expect(lines).toContain('[3] button icon="settings"');
    expect(lines).toContain('[4] button data-testid="captions-toggle" pressed=false');
    // Real text stays as before — no label noise.
    expect(lines).toContain('[5] button "1.5x"');
  });

  it("controls inside an open shadow root are listed and labeled", () => {
    expect(outline()).toContain('[6] button aria-label="Fullscreen"');
  });

  it("interactive mode carries the same labels", () => {
    expect(outline("interactive")).toContain(
      '[0] button type=button data-purpose="play-button" icon="play"',
    );
  });

  it("a labeled index clicks the control it names", async () => {
    outline();
    const res = await juniorActionInPage({ op: "click", target: "[0]", expect: null });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.message).toContain("<button>");
    const byLabel = await juniorActionInPage({
      op: "probe",
      mode: "click",
      target: "Rewind 5 seconds",
    });
    expect(byLabel).toMatchObject({ ok: true, facts: { ariaLabel: "Rewind 5 seconds" } });
  });
});
