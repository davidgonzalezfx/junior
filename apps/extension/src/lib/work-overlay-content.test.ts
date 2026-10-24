// Work-overlay content tests: the REAL overlay module in jsdom — show/hide DOM,
// pause visuals, the trusted-gesture interception contract, and the install
// guard. jsdom's isTrusted is an own non-configurable getter and cannot be
// faked, so the module takes a gesture predicate (prod: e.isTrusted); trusted
// tests inject () => true and the UNTRUSTED tests run the DEFAULT predicate —
// proving jsdom's real false is what blocks the synthetic click.
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkOverlay,
  installWorkOverlay,
  type OverlayToSwMessage,
} from "./work-overlay-content";

/** Every overlay created in this file — hidden afterEach so its window capture
 * interceptors don't leak into the next test. */
const created: Array<{ handleMessage(msg: unknown): void }> = [];

function makeOverlay(gesture?: (e: Event) => boolean) {
  const send = vi.fn<(msg: OverlayToSwMessage) => void>();
  const overlay =
    gesture === undefined
      ? createWorkOverlay(send) // default predicate: real e.isTrusted
      : createWorkOverlay(send, gesture);
  created.push(overlay);
  return { overlay, send };
}

afterEach(() => {
  for (const o of created) o.handleMessage({ type: "overlay_hide" });
  created.length = 0;
});

const trusted = () => true;

beforeEach(() => {
  document.body.innerHTML = "";
  // The overlay attaches to documentElement (Autono does the same), so body
  // reset alone would leak it across tests.
  document.documentElement
    .querySelectorAll("#__junior_work_overlay, #__junior_work_frame")
    .forEach((el) => el.remove());
  delete (window as { __juniorOverlayInstalled?: boolean }).__juniorOverlayInstalled;
});

describe("createWorkOverlay — show/hide", () => {
  it("show builds the frame + pill; the label says Junior is working", () => {
    const { overlay } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show" });
    expect(overlay.visible).toBe(true);
    expect(document.getElementById("__junior_work_frame")).not.toBeNull();
    expect(document.getElementById("__junior_work_overlay")).not.toBeNull();
    expect(overlay.parts?.label.textContent).toBe("Junior is working");
    expect(overlay.parts?.pauseBtn.textContent).toBe("⏸ Pause");
  });

  it("show with a custom title uses it", () => {
    const { overlay } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show", title: "Filling the form" });
    expect(overlay.parts?.label.textContent).toBe("Filling the form");
  });

  it("a second show refreshes instead of stacking a second overlay", () => {
    const { overlay } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show" });
    overlay.handleMessage({ type: "overlay_show", title: "Updated" });
    expect(document.querySelectorAll("#__junior_work_overlay").length).toBe(1);
    expect(overlay.parts?.label.textContent).toBe("Updated");
  });

  it("overlay_show carries the initial paused state (SW-driven)", () => {
    const { overlay } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show", paused: true });
    expect(overlay.paused).toBe(true);
    expect(overlay.parts?.label.textContent).toBe("Paused: inspecting the page");
  });

  it("hide removes the DOM and clears the parts", () => {
    const { overlay } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show" });
    overlay.handleMessage({ type: "overlay_hide" });
    expect(overlay.visible).toBe(false);
    expect(overlay.parts).toBeNull();
    expect(document.getElementById("__junior_work_frame")).toBeNull();
    expect(document.getElementById("__junior_work_overlay")).toBeNull();
  });

  it("hide while hidden does not throw; show again after hide works", () => {
    const { overlay } = makeOverlay(trusted);
    expect(() => overlay.handleMessage({ type: "overlay_hide" })).not.toThrow();
    overlay.handleMessage({ type: "overlay_show" });
    expect(overlay.visible).toBe(true);
  });

  it("garbage messages are ignored", () => {
    const { overlay } = makeOverlay(trusted);
    expect(() => overlay.handleMessage("nope")).not.toThrow();
    expect(() => overlay.handleMessage({ type: "overlay_paused", paused: "yes" })).not.toThrow();
    expect(overlay.visible).toBe(false);
  });
});

describe("createWorkOverlay — pause/resume", () => {
  it("a TRUSTED pause click flips to paused, recolors the frame, tells the SW", () => {
    const { overlay, send } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show" });
    overlay.parts!.pauseBtn.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(overlay.paused).toBe(true);
    expect(overlay.parts?.label.textContent).toBe("Paused: inspecting the page");
    expect(overlay.parts?.pauseBtn.textContent).toBe("▶ Resume");
    expect(overlay.parts?.frame.style.borderColor).toContain("34, 197, 94");
    expect(send).toHaveBeenCalledWith({ type: "overlay_action", action: "pause" });
  });

  it("an UNTRUSTED pause click is ignored — page scripts cannot pause the agent", () => {
    const { overlay, send } = makeOverlay(); // default predicate = real e.isTrusted
    overlay.handleMessage({ type: "overlay_show" });
    overlay.parts!.pauseBtn.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(overlay.paused).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("a second trusted click resumes and tells the SW", () => {
    const { overlay, send } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show" });
    const click = () =>
      overlay.parts!.pauseBtn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    click();
    click();
    expect(overlay.paused).toBe(false);
    expect(overlay.parts?.label.textContent).toBe("Junior is working");
    expect(send).toHaveBeenLastCalledWith({ type: "overlay_action", action: "resume" });
  });

  it("overlay_paused from the SW syncs visuals without messaging back", () => {
    const { overlay, send } = makeOverlay(trusted);
    overlay.handleMessage({ type: "overlay_show" });
    overlay.handleMessage({ type: "overlay_paused", paused: true });
    expect(overlay.paused).toBe(true);
    expect(overlay.parts?.label.textContent).toBe("Paused: inspecting the page");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createWorkOverlay — trusted-click interception", () => {
  it("physical user clicks are blocked while the agent works; released when paused", () => {
    const { overlay } = makeOverlay(trusted);
    const pageButton = document.createElement("button");
    document.body.appendChild(pageButton);
    const received: string[] = [];
    pageButton.addEventListener("click", () => received.push("click"));
    pageButton.addEventListener("mousedown", () => received.push("mousedown"));
    const click = (type: string) =>
      pageButton.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));

    overlay.handleMessage({ type: "overlay_show" });
    click("click"); // trusted user click
    click("mousedown");
    expect(received).toEqual([]); // the agent owns the page

    overlay.handleMessage({ type: "overlay_paused", paused: true });
    click("click"); // paused = the user may inspect and click the page
    expect(received).toEqual(["click"]);
  });

  it("with the DEFAULT predicate (real isTrusted), jsdom synthetic clicks pass through", () => {
    const { overlay } = makeOverlay(); // executors' clicks are isTrusted:false
    const pageButton = document.createElement("button");
    document.body.appendChild(pageButton);
    const onClick = vi.fn();
    pageButton.addEventListener("click", onClick);
    overlay.handleMessage({ type: "overlay_show" });
    pageButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("after hide the interception listeners are gone", () => {
    const { overlay } = makeOverlay(trusted);
    const pageButton = document.createElement("button");
    document.body.appendChild(pageButton);
    const onClick = vi.fn();
    pageButton.addEventListener("click", onClick);
    overlay.handleMessage({ type: "overlay_show" });
    overlay.handleMessage({ type: "overlay_hide" });
    pageButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("installWorkOverlay", () => {
  function makeRegister() {
    const listeners: Array<(msg: unknown) => void> = [];
    /** Dispatch to the (single) registered bridge; throws when none exists. */
    const dispatch = (msg: unknown) => {
      const l = listeners[0];
      if (!l) throw new Error("no onMessage bridge installed");
      l(msg);
    };
    return {
      dispatch,
      register: (cb: (msg: unknown) => void) => {
        listeners.push(cb);
      },
    };
  }

  it("installs the onMessage bridge and announces content_ready", () => {
    const send = vi.fn<(msg: OverlayToSwMessage) => void>();
    const { dispatch, register } = makeRegister();
    installWorkOverlay(send, register);
    expect(send).toHaveBeenCalledWith({ type: "content_ready" });

    const overlay = { handleMessage: dispatch }; // for afterEach cleanup
    created.push(overlay);
    overlay.handleMessage({ type: "overlay_show" });
    expect(document.getElementById("__junior_work_overlay")).not.toBeNull();
  });

  it("double injection is a no-op — the first DOM and listener survive", () => {
    const send = vi.fn<(msg: OverlayToSwMessage) => void>();
    const { dispatch, register } = makeRegister();
    installWorkOverlay(send, register);
    installWorkOverlay(send, register); // re-injected by the next action
    expect(send).toHaveBeenCalledTimes(1);
    created.push({ handleMessage: dispatch }); // for afterEach cleanup
    dispatch({ type: "overlay_show" });
    expect(document.querySelectorAll("#__junior_work_overlay").length).toBe(1);
  });
});
