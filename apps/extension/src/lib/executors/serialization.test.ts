// executeScript({func}) ships `func.toString()` into the page and nothing else.
// Each in-page function is rebuilt here from its source text alone, so a stray
// reference to module scope throws exactly as it does in Chrome (T1's
// "Injection returned no result" on text/section reads was this).
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { juniorFrameInfoInPage } from "./frames";
import { juniorActionInPage } from "./in-page";
import { juniorReadTextInPage } from "./read-page";

function reinject<F extends (...args: never[]) => unknown>(fn: F): F {
  return new Function(`return (${fn.toString()});`)() as F;
}

describe("in-page functions survive executeScript serialization", () => {
  it("juniorReadTextInPage text + truncated section", async () => {
    document.body.innerHTML = `<main id="m">${"word ".repeat(400)}</main>`;
    const read = reinject(juniorReadTextInPage);
    expect(await read({ mode: "text", maxChars: 8000 })).toMatchObject({ ok: true });
    const cut = await read({ mode: "section", selector: "#m", maxChars: 300 });
    expect(cut).toMatchObject({ ok: true });
    expect((cut as { text: string }).text).toContain("[truncated at 300 chars");
  });

  it("juniorActionInPage probe", async () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const b = document.getElementById("b")!;
    b.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
    const act = reinject(juniorActionInPage);
    expect(await act({ op: "probe", mode: "click", target: "#b" })).toMatchObject({ ok: true });
  });

  it("juniorFrameInfoInPage", () => {
    expect(reinject(juniorFrameInfoInPage)()).toMatchObject({ coveredByParent: false });
  });
});
