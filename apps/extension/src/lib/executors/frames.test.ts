// T5a frame routing over a fake env: target parsing, read composition across
// frames (budget, restricted frames, enumeration failure) and action routing.
import { describe, expect, it, vi } from "vitest";
import { BrowserActionSchema, type BrowserAction } from "@junior/protocol";
import { parseFrameTarget, type FrameInfo } from "./frames";
import { executeAction, type ExecutorEnv } from "./index";

const TOP: FrameInfo = { frameId: 0, url: "https://news.example/", coveredByParent: false };
const PLAYER: FrameInfo = { frameId: 7, url: "https://player.example/e/1", coveredByParent: false };
const SAME: FrameInfo = { frameId: 4, url: "https://news.example/c", coveredByParent: true };
const EXT: FrameInfo = {
  frameId: 9,
  url: "chrome-extension://abc/menu.html",
  coveredByParent: false,
};

function makeEnv(frames: FrameInfo[] | "throws" | "absent", over: Partial<ExecutorEnv> = {}) {
  const env: ExecutorEnv = {
    getActiveTab: async () => ({ id: 1, url: TOP.url, title: "t", status: "complete" }),
    runInPage: vi.fn(async (_t, args) =>
      args.op === "probe"
        ? {
            ok: true as const,
            message: "probed",
            facts: {
              tag: "button",
              type: "",
              text: "Play",
              ariaLabel: "",
              title: "",
              href: "",
              formAction: "",
              isSubmit: false,
            },
          }
        : { ok: true as const, message: `${args.op} done` },
    ),
    runReadInPage: vi.fn(async (_t, _a, frameId?: number) => ({
      ok: true as const,
      text: `text of ${frameId ?? "top"}`,
      url: "",
    })),
    runBuildDomTree: vi.fn(async (_t, _a, frameId?: number) => ({
      text: `[0] button "in ${frameId ?? "top"}"\n[1] a "x"`,
    })),
    captureVisibleTab: async () => "",
    permissionMode: async () => "auto",
    blockedOrigins: async () => [],
    navigateTab: async () => {},
    ...over,
  };
  if (frames === "throws") env.listFrames = async () => Promise.reject(new Error("no access"));
  else if (frames !== "absent") env.listFrames = async () => frames;
  return env;
}

const read = (mode: string, extra: object = {}): BrowserAction =>
  BrowserActionSchema.parse({ kind: "read_page", mode, ...extra });

describe("parseFrameTarget", () => {
  it.each([
    ["f7:12", { frameId: 7, target: "12" }],
    ["[f7:12]", { frameId: 7, target: "12" }],
    ["f7:[12]", { frameId: 7, target: "[12]" }],
    ["f7:Play video", { frameId: 7, target: "Play video" }],
    ["f0:3", { frameId: 0, target: "3" }],
    ["f7:", { frameId: 7, target: "" }],
  ])("%s", (raw, want) => expect(parseFrameTarget(raw)).toEqual(want));

  it.each(["12", "[12]", "#f7", "button.f7:hover", "Save f7:x", "f:1"])("%s → top frame", (raw) =>
    expect(parseFrameTarget(raw)).toBeNull(),
  );
});

describe("read_page across frames", () => {
  it("qualifies child-frame indices, skips covered and restricted frames", async () => {
    const env = makeEnv([TOP, SAME, PLAYER, EXT]);
    const res = await executeAction(read("outline"), env);
    expect(res.result).toBe(
      [
        '[0] button "in top"',
        '[1] a "x"',
        "--- iframe f7 https://player.example/e/1 ---",
        '[f7:0] button "in 7"',
        '[f7:1] a "x"',
      ].join("\n"),
    );
    expect(env.runBuildDomTree).toHaveBeenCalledTimes(2);
  });

  it("text mode reads covered frames too (innerText never crosses an iframe)", async () => {
    const res = await executeAction(read("text"), makeEnv([TOP, SAME, PLAYER, EXT]));
    expect(res.result).toBe(
      [
        "text of top",
        "--- iframe f4 https://news.example/c ---",
        "text of 4",
        "--- iframe f7 https://player.example/e/1 ---",
        "text of 7",
      ].join("\n"),
    );
  });

  it("stays inside maxChars and says how many frames it skipped", async () => {
    const big = "x".repeat(150);
    const env = makeEnv([TOP, PLAYER], {
      runReadInPage: vi.fn(async () => ({ ok: true as const, text: big, url: "" })),
    });
    const res = await executeAction(read("text", { maxChars: 300 }), env);
    expect(res.result).toBe(`${big}\n--- 1 more iframe(s) not read: raise maxChars ---`);
  });

  it.each(["absent", "throws"] as const)("listFrames %s → top frame only, as before", async (f) => {
    const res = await executeAction(read("outline"), makeEnv(f));
    expect(res.result).toBe('[0] button "in top"\n[1] a "x"');
  });

  it("a scoped section never runs in a restricted frame", async () => {
    const env = makeEnv([TOP, EXT]);
    const res = await executeAction(read("section", { selector: "f9:#menu" }), env);
    expect(res).toMatchObject({ status: "error", error: expect.stringMatching(/not permitted/) });
    expect(env.runReadInPage).not.toHaveBeenCalled();
  });
});

describe("actions in frames", () => {
  it("routes probe and act to the frame with the in-frame target", async () => {
    const env = makeEnv([TOP, PLAYER]);
    const res = await executeAction({ kind: "click", target: "f7:3" }, env);
    expect(res.status).toBe("ok");
    const calls = vi.mocked(env.runInPage).mock.calls;
    expect(calls.map((c) => [c[1].op, "target" in c[1] ? c[1].target : null, c[2]])).toEqual([
      ["probe", "3", 7],
      ["click", "3", 7],
    ]);
  });

  it("plain and f0 targets run in the top frame without a frameIds target", async () => {
    const env = makeEnv([TOP, PLAYER]);
    await executeAction({ kind: "click", target: "3" }, env);
    await executeAction({ kind: "click", target: "f0:3" }, env);
    for (const call of vi.mocked(env.runInPage).mock.calls) {
      expect(call).toHaveLength(2);
      expect((call[1] as { target: string }).target).toBe("3");
    }
  });

  it("refuses restricted frames and frames that are gone", async () => {
    const env = makeEnv([TOP, EXT]);
    expect(await executeAction({ kind: "click", target: "f9:0" }, env)).toMatchObject({
      status: "error",
      error: expect.stringMatching(/not permitted inside this frame/),
    });
    expect(await executeAction({ kind: "type", target: "f5:0", text: "a" }, env)).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Frame f5 not found/),
    });
    expect(env.runInPage).not.toHaveBeenCalled();
  });

  it("frame targets fail closed when frames can't be enumerated", async () => {
    const env = makeEnv("absent");
    const res = await executeAction({ kind: "click", target: "f7:0" }, env);
    expect(res.status).toBe("error");
    expect(env.runInPage).not.toHaveBeenCalled();
  });

  it("the guard judges the frame's site as well as the page's", async () => {
    const env = makeEnv([TOP, { ...PLAYER, url: "https://www.chase.com/widget" }]);
    const ask = vi.fn(async () => "deny" as const);
    const res = await executeAction({ kind: "click", target: "f7:0" }, env, { ask });
    expect(res.status).toBe("denied");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ask.mock.calls[0])).toContain("chase.com");
    // A grant for the page doesn't cover the frame's own site.
    const granted = async (url: string) => url.startsWith(TOP.url);
    await executeAction({ kind: "click", target: "f7:0" }, env, { ask, granted });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("scroll honours the frame field", async () => {
    const env = makeEnv([TOP, PLAYER]);
    await executeAction(
      BrowserActionSchema.parse({ kind: "scroll", direction: "down", frame: "f7" }),
      env,
    );
    expect(vi.mocked(env.runInPage).mock.calls[0]?.[2]).toBe(7);
  });
});
