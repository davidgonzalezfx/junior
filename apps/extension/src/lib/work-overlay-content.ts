// lib/work-overlay-content.ts — the in-page work overlay (plan §5.2 item 6):
// a trimmed port of Autono content/content.js:17–276 (§6.1 copy list) — thin
// 2px border + "Junior is working" pill with Pause/Resume, Autono's glows and
// branding stripped, no Write button (instructions live in the panel) and no ✕
// (task cancel is M4-5). Kept from Autono, per plan §5.2: the e.isTrusted
// interception (physical user clicks are blocked while the agent works — the
// executors' synthetic clicks pass through untouched) and the closed shadow
// root (page scripts can't reach the banner controls).
//
// The overlay is injected on demand as the unlisted script `overlay.js`
// (executeScript — M2-1 keeps the manifest free of static content_scripts), so
// createWorkOverlay is dependency-free DOM code that runs in jsdom tests, and
// installWorkOverlay (entrypoints/overlay.ts) is the only chrome wiring.

/** SW → overlay commands (tabs.sendMessage). */
export type OverlayCommand =
  | { type: "overlay_show"; title?: string; paused?: boolean }
  | { type: "overlay_hide" }
  | { type: "overlay_paused"; paused: boolean };

/** Overlay → SW messages (runtime.sendMessage; the port-router allowlist). */
export type OverlayToSwMessage =
  { type: "content_ready" } | { type: "overlay_action"; action: "pause" | "resume" };

const WORKING_TITLE = "Junior is working";
const PAUSED_TITLE = "Paused: inspecting the page";
const WORKING_BORDER = "rgba(56, 189, 248, 0.85)";
const PAUSED_BORDER = "rgba(34, 197, 94, 0.75)";

export interface OverlayParts {
  host: HTMLDivElement;
  frame: HTMLDivElement;
  label: HTMLSpanElement;
  pauseBtn: HTMLButtonElement;
}

export interface JuniorWorkOverlay {
  handleMessage(msg: unknown): void;
  readonly visible: boolean;
  readonly paused: boolean;
  /** Live element references (null while hidden) — jsdom tests drive these;
   * the closed shadow root hides them from page scripts. */
  readonly parts: OverlayParts | null;
}

export function createWorkOverlay(
  send: (msg: OverlayToSwMessage) => void,
  /** Trusted-gesture predicate — `e.isTrusted` in production; jsdom's
   * isTrusted is an own non-configurable getter and cannot be faked, so tests
   * inject `() => true` / `() => false`. */
  isUserGesture: (e: Event) => boolean = (e) => e.isTrusted,
): JuniorWorkOverlay {
  let host: HTMLDivElement | null = null;
  let frame: HTMLDivElement | null = null;
  let label: HTMLSpanElement | null = null;
  let pauseBtn: HTMLButtonElement | null = null;
  let paused = false;
  let title = WORKING_TITLE;

  function applyVisuals(): void {
    if (!frame || !label || !pauseBtn) return;
    label.textContent = paused ? PAUSED_TITLE : title;
    frame.style.borderColor = paused ? PAUSED_BORDER : WORKING_BORDER;
    pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
    pauseBtn.style.background = paused ? "rgba(34, 197, 94, 0.22)" : "rgba(56, 189, 248, 0.16)";
    pauseBtn.style.color = paused ? "#4ade80" : "#38bdf8";
    pauseBtn.style.borderColor = paused ? "rgba(34, 197, 94, 0.55)" : "rgba(56, 189, 248, 0.45)";
  }

  // Port of Autono onUserManualIntervention (content.js:24–37): while the agent
  // works, physically-trusted clicks are stopped in the capture phase; the
  // executors' synthetic clicks (isTrusted false) and our own banner (events
  // retarget to the host) pass through. Released entirely while paused.
  function intercept(e: Event): void {
    if (!host || paused) return;
    if (e.target === host) return;
    if (isUserGesture(e)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function togglePause(e: Event): void {
    // The banner lives in a closed shadow root, but the trust check is what
    // stops a page script from pressing Pause via a synthetic click (Autono
    // content.js:150).
    if (!isUserGesture(e)) return;
    e.stopPropagation();
    paused = !paused;
    applyVisuals();
    send({ type: "overlay_action", action: paused ? "pause" : "resume" });
  }

  function show(opts: { title?: string; paused?: boolean }): void {
    if (opts.paused !== undefined) paused = opts.paused;
    if (opts.title) title = opts.title;
    if (host) {
      applyVisuals(); // already injected — just refresh the label/state
      return;
    }

    // Thin border frame (plan §5.2 item 6 — Autono's glow stack stripped).
    const frameEl = document.createElement("div");
    frameEl.id = "__junior_work_frame";
    Object.assign(frameEl.style, {
      position: "fixed",
      top: "10px",
      left: "10px",
      width: "calc(100vw - 20px)",
      height: "calc(100vh - 20px)",
      borderRadius: "12px",
      border: `2px solid ${WORKING_BORDER}`,
      background: "transparent",
      pointerEvents: "none",
      boxSizing: "border-box",
      zIndex: "2147483645",
      transition: "border-color 0.3s ease",
    });

    // Full-screen container: pointer-events none so page clicks reach the page.
    const hostEl = document.createElement("div");
    hostEl.id = "__junior_work_overlay";
    Object.assign(hostEl.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "2147483646",
      pointerEvents: "none",
      background: "transparent",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      paddingTop: "20px",
      boxSizing: "border-box",
      transition: "opacity 0.25s ease",
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      userSelect: "none",
    });

    const banner = document.createElement("div");
    Object.assign(banner.style, {
      background: "rgba(15, 17, 23, 0.94)",
      border: "1px solid rgba(56, 189, 248, 0.45)",
      borderRadius: "9999px",
      padding: "8px 20px",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      color: "#ffffff",
      fontSize: "13px",
      fontWeight: "500",
      pointerEvents: "all", // the banner (and only the banner) is interactive
      cursor: "default",
    });

    const dot = document.createElement("span");
    Object.assign(dot.style, {
      width: "9px",
      height: "9px",
      borderRadius: "50%",
      background: "#38bdf8",
      display: "inline-block",
      animation: "junior-overlay-pulse 1.4s infinite ease-in-out",
    });

    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, { color: "#f8fafc", letterSpacing: "0.2px", fontWeight: "600" });

    const btn = document.createElement("button");
    btn.type = "button";
    Object.assign(btn.style, {
      border: "1px solid rgba(56, 189, 248, 0.45)",
      borderRadius: "20px",
      padding: "4px 14px",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "all 0.15s ease",
    });
    btn.addEventListener("click", togglePause);

    banner.appendChild(dot);
    banner.appendChild(labelEl);
    banner.appendChild(btn);

    // Closed shadow root: page scripts cannot reach the banner controls (Autono
    // content.js:234).
    const shadow = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      @keyframes junior-overlay-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(0.85); }
      }
    `;
    shadow.appendChild(style);
    shadow.appendChild(banner);

    document.documentElement.appendChild(frameEl);
    document.documentElement.appendChild(hostEl);

    host = hostEl;
    frame = frameEl;
    label = labelEl;
    pauseBtn = btn;
    window.addEventListener("click", intercept, true);
    window.addEventListener("mousedown", intercept, true);
    applyVisuals();
  }

  function hide(): void {
    window.removeEventListener("click", intercept, true);
    window.removeEventListener("mousedown", intercept, true);
    host?.remove();
    frame?.remove();
    host = null;
    frame = null;
    label = null;
    pauseBtn = null;
  }

  return {
    handleMessage(msg: unknown): void {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: unknown; title?: unknown; paused?: unknown };
      if (m.type === "overlay_show") {
        show({
          title: typeof m.title === "string" ? m.title : undefined,
          paused: typeof m.paused === "boolean" ? m.paused : undefined,
        });
      } else if (m.type === "overlay_hide") {
        hide();
      } else if (m.type === "overlay_paused" && typeof m.paused === "boolean") {
        paused = m.paused;
        applyVisuals();
      }
    },
    get visible(): boolean {
      return host !== null;
    },
    get paused(): boolean {
      return paused;
    },
    get parts(): OverlayParts | null {
      if (!host || !frame || !label || !pauseBtn) return null;
      return { host, frame, label, pauseBtn };
    },
  };
}

/**
 * Entry wiring (called from entrypoints/overlay.ts): idempotent across
 * re-injection — the second executeScript({files}) is a no-op, so the first
 * injection's DOM and listeners survive. Announces content_ready so the SW can
 * re-apply its current state after a navigation brought a fresh page.
 */
export function installWorkOverlay(
  send: (msg: OverlayToSwMessage) => void,
  onMessage: (cb: (msg: unknown) => void) => void,
): void {
  const w = window as { __juniorOverlayInstalled?: boolean };
  if (w.__juniorOverlayInstalled) return;
  w.__juniorOverlayInstalled = true;
  const overlay = createWorkOverlay(send);
  onMessage((msg) => overlay.handleMessage(msg));
  send({ type: "content_ready" });
}
