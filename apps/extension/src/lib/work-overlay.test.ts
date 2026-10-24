// Work-overlay SW controller tests: injection/show/hide/pause relay over a stub
// env, plus the firewall on inbound content-script messages (the REAL
// contentMessageAllowed — top frame, 3-type allowlist). M4-5: the ✕ cancel
// action and SW-crash recovery (storage-recorded tab, hidden on the next wake).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { WorkOverlayController, type OverlayEnv } from "./work-overlay";
import type { OverlayCommand } from "./work-overlay-content";
import type { SenderLike } from "./port-router";

function makeHarness() {
  const inject = vi.fn(async (_tabId: number) => {});
  const send = vi.fn(async (_tabId: number, _msg: OverlayCommand) => {});
  const env: OverlayEnv & { inject: typeof inject; send: typeof send } = {
    inject,
    send,
    injectOverlay: (tabId) => inject(tabId),
    sendToTab: (tabId, msg) => send(tabId, msg),
  };
  const onOverlayAction = vi.fn<(action: "pause" | "resume" | "cancel") => void>();
  const controller = new WorkOverlayController(env, { onOverlayAction });
  return { controller, env, onOverlayAction };
}

function contentSender(tabId: number, frameId = 0): SenderLike {
  return { id: "ext", tab: { id: tabId }, frameId };
}

describe("WorkOverlayController — show/hide", () => {
  it("show messages the tab directly when its listener is live", async () => {
    const { controller, env } = makeHarness();
    await controller.show(5);
    expect(env.inject).not.toHaveBeenCalled(); // send succeeded — nothing to install
    expect(env.send).toHaveBeenCalledWith(5, {
      type: "overlay_show",
      title: undefined,
      paused: false,
    });
    expect(controller.showingTab).toBe(5);

    await controller.show(5, "Filling the form");
    expect(env.inject).not.toHaveBeenCalled();
    expect(env.send).toHaveBeenLastCalledWith(5, {
      type: "overlay_show",
      title: "Filling the form",
      paused: false,
    });
  });

  it("show falls back to injection when the page has no listener yet", async () => {
    const { controller, env } = makeHarness();
    env.send.mockRejectedValueOnce(new Error("Receiving end does not exist"));
    await controller.show(7);
    expect(env.inject).toHaveBeenCalledWith(7);
    // show() itself does not blind-resend: the fresh script announces
    // content_ready and the controller re-applies state from there.
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(controller.showingTab).toBe(7);
  });

  it("a restricted page (injection fails) is fine — the overlay is display-only", async () => {
    const { controller, env } = makeHarness();
    env.send.mockRejectedValueOnce(new Error("no listener"));
    env.inject.mockRejectedValueOnce(new Error("cannot access chrome:// url"));
    await expect(controller.show(9)).resolves.toBeUndefined();
    expect(controller.showingTab).toBe(9);
  });

  it("hide tells the tab and clears; hide with nothing shown is a no-op", async () => {
    const { controller, env } = makeHarness();
    await controller.hide(); // nothing shown
    expect(env.send).not.toHaveBeenCalled();

    await controller.show(5);
    env.send.mockClear();
    await controller.hide();
    expect(env.send).toHaveBeenCalledWith(5, { type: "overlay_hide" });
    expect(controller.showingTab).toBeNull();
  });
});

describe("WorkOverlayController — pause", () => {
  it("setPaused relays overlay_paused to the showing tab", async () => {
    const { controller, env } = makeHarness();
    await controller.setPaused(true); // nothing shown — state only
    expect(controller.paused).toBe(true);
    expect(env.send).not.toHaveBeenCalled();

    await controller.show(5);
    env.send.mockClear();
    await controller.setPaused(true);
    expect(env.send).toHaveBeenCalledWith(5, { type: "overlay_paused", paused: true });
    await controller.setPaused(false);
    expect(env.send).toHaveBeenLastCalledWith(5, { type: "overlay_paused", paused: false });
  });

  it("a validated overlay_action pause reaches onOverlayAction", () => {
    const { controller, onOverlayAction } = makeHarness();
    controller.handleContentMessage({ type: "overlay_action", action: "pause" }, contentSender(5));
    expect(onOverlayAction).toHaveBeenCalledWith("pause");
    expect(controller.paused).toBe(true);
    controller.handleContentMessage({ type: "overlay_action", action: "resume" }, contentSender(5));
    expect(onOverlayAction).toHaveBeenCalledWith("resume");
    expect(controller.paused).toBe(false);
  });
});

describe("WorkOverlayController — content_ready + firewall", () => {
  it("content_ready from the overlay's tab re-applies the current state", async () => {
    const { controller, env } = makeHarness();
    await controller.show(5);
    await controller.setPaused(true);
    env.send.mockClear();
    controller.handleContentMessage({ type: "content_ready" }, contentSender(5));
    await vi.waitFor(() =>
      expect(env.send).toHaveBeenCalledWith(5, { type: "overlay_show", paused: true }),
    );
  });

  it("content_ready from another tab is ignored", async () => {
    const { controller, env } = makeHarness();
    await controller.show(5);
    env.send.mockClear();
    controller.handleContentMessage({ type: "content_ready" }, contentSender(6));
    expect(env.send).not.toHaveBeenCalled();
  });

  it("the firewall holds: non-top-frame and non-allowlisted types never dispatch", () => {
    const { controller, onOverlayAction } = makeHarness();
    controller.handleContentMessage(
      { type: "overlay_action", action: "pause" },
      contentSender(5, 1), // subframe — not top frame
    );
    controller.handleContentMessage(
      { type: "approval_response", id: "x", decision: "once" }, // privileged type
      contentSender(5),
    );
    controller.handleContentMessage(
      { type: "overlay_action", action: "pause" },
      undefined, // no tab at all
    );
    expect(onOverlayAction).not.toHaveBeenCalled();
    expect(controller.paused).toBe(false);
  });
});

describe("WorkOverlayController — ✕ cancel + SW-crash recovery (M4-5)", () => {
  beforeEach(() => fakeBrowser.reset());

  it("a validated cancel action reaches onOverlayAction without touching pause state", () => {
    const { controller, onOverlayAction } = makeHarness();
    controller.handleContentMessage({ type: "overlay_action", action: "cancel" }, contentSender(5));
    expect(onOverlayAction).toHaveBeenCalledWith("cancel");
    expect(controller.paused).toBe(false);
  });

  it("show records the tab in storage; hide clears the record", async () => {
    const { controller } = makeHarness();
    await controller.show(9);
    await expect(fakeBrowser.storage.local.get("junior_overlay_tab")).resolves.toEqual({
      junior_overlay_tab: 9,
    });
    await controller.hide();
    await expect(fakeBrowser.storage.local.get("junior_overlay_tab")).resolves.toEqual({});
  });

  it("recoverAfterRestart hides the tab a dead SW left showing, then clears the record", async () => {
    const dead = makeHarness(); // the SW that died mid-task
    await dead.controller.show(9);
    // ...SW dies; a fresh SW wakes with a NEW controller but the SAME storage.
    const fresh = makeHarness();
    await fresh.controller.recoverAfterRestart();
    expect(fresh.env.send).toHaveBeenCalledWith(9, { type: "overlay_hide" });
    expect(fresh.controller.showingTab).toBeNull();
    // A second wake finds no record — no stray overlay_hide.
    const next = makeHarness();
    await next.controller.recoverAfterRestart();
    expect(next.env.send).not.toHaveBeenCalled();
  });

  it("recoverAfterRestart with no record is a no-op", async () => {
    const { env, controller } = makeHarness();
    await controller.recoverAfterRestart();
    expect(env.send).not.toHaveBeenCalled();
    expect(controller.showingTab).toBeNull();
  });
});
