// Port-router tests: the firewall predicates (Autono background.js:113/5593 ports)
// and the router's connect/disconnect/broadcast/message flow against stub ports.
import { describe, expect, it, vi } from "vitest";
import {
  PANEL_PORT_NAME,
  PortRouter,
  contentMessageAllowed,
  isApprovalResponseMessage,
  isContentScriptSender,
  isExtPage,
  panelMessageAllowed,
  type PortLike,
} from "./port-router";

const EXT_ID = "ocjlcgidjeodnjicogfmmicpkookeabb";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

type TestPort = PortLike & {
  inbound: unknown[];
  __emit(msg: unknown): void;
  __close(): void;
};

function stubPort(opts: { name?: string; url?: string; inTab?: boolean } = {}): TestPort {
  const listeners: ((msg: unknown, port: PortLike) => void)[] = [];
  const disconnects: ((port: PortLike) => void)[] = [];
  const port = {
    name: opts.name ?? PANEL_PORT_NAME,
    sender: {
      id: opts.url === undefined ? undefined : EXT_ID,
      url: opts.url,
      tab: opts.inTab ? { id: 1 } : undefined,
      frameId: opts.inTab ? 0 : undefined,
    },
    inbound: [] as unknown[],
    postMessage: vi.fn((msg: unknown) => {
      port.inbound.push(msg);
    }),
    disconnect: vi.fn(),
    onMessage: { addListener: (cb) => listeners.push(cb), removeListener: () => {} },
    onDisconnect: { addListener: (cb) => disconnects.push(cb) },
    __emit(msg: unknown) {
      listeners.forEach((cb) => cb(msg, port));
    },
    __close() {
      disconnects.forEach((cb) => cb(port));
    },
  } as TestPort;
  return port;
}

describe("firewall predicates", () => {
  it("isExtPage accepts only our extension pages (Autono background.js:113 port)", () => {
    expect(isExtPage({ id: EXT_ID, url: `${EXT_ORIGIN}/sidepanel.html` }, EXT_ID, EXT_ORIGIN)).toBe(
      true,
    );
    expect(
      isExtPage({ id: EXT_ID, url: `${EXT_ORIGIN}-evil/sidepanel.html` }, EXT_ID, EXT_ORIGIN),
    ).toBe(false);
    expect(
      isExtPage({ id: "another-extension", url: `${EXT_ORIGIN}/x.html` }, EXT_ID, EXT_ORIGIN),
    ).toBe(false);
    // Content scripts carry the PAGE url, never the extension one.
    expect(isExtPage({ id: EXT_ID, url: "https://example.com/" }, EXT_ID, EXT_ORIGIN)).toBe(false);
    expect(isExtPage(undefined, EXT_ID, EXT_ORIGIN)).toBe(false);
    expect(isExtPage({ id: EXT_ID }, EXT_ID, EXT_ORIGIN)).toBe(false);
  });

  it("isContentScriptSender demands a tab and the top frame", () => {
    expect(isContentScriptSender({ tab: { id: 1 }, frameId: 0 })).toBe(true);
    expect(isContentScriptSender({ tab: { id: 1 }, frameId: 2 })).toBe(false); // iframe
    expect(isContentScriptSender({ frameId: 0 })).toBe(false); // no tab = page sender
  });

  it("panel messages are privileged; content scripts are limited to the 3-type allowlist", () => {
    const page = { id: EXT_ID, url: `${EXT_ORIGIN}/sidepanel.html` };
    expect(panelMessageAllowed("approval_response", page, EXT_ID, EXT_ORIGIN)).toBe(true);
    expect(panelMessageAllowed("init_state", page, EXT_ID, EXT_ORIGIN)).toBe(false);
    expect(panelMessageAllowed("approval_response", { tab: { id: 1 } }, EXT_ID, EXT_ORIGIN)).toBe(
      false,
    );
    const inTab = { id: EXT_ID, url: "https://example.com/", tab: { id: 1 }, frameId: 0 };
    for (const t of ["pick_response", "overlay_action", "content_ready"]) {
      expect(contentMessageAllowed(t, inTab)).toBe(true);
    }
    expect(contentMessageAllowed("approval_response", inTab)).toBe(false);
    expect(contentMessageAllowed("pick_response", { ...inTab, frameId: 1 })).toBe(false);
  });
});

describe("PortRouter", () => {
  it("rejects wrong port names and non-extension senders by disconnecting", () => {
    const onApprovalResponse = vi.fn();
    const router = new PortRouter({
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      onApprovalResponse,
    });
    expect(router.attach(stubPort({ name: "other" }))).toBe(false);
    expect(router.attach(stubPort({ url: "https://example.com/" }))).toBe(false);
    expect(router.ports.size).toBe(0);
    const good = stubPort({ url: `${EXT_ORIGIN}/sidepanel.html` });
    expect(router.attach(good)).toBe(true);
    expect(router.hasListener()).toBe(true);
  });

  it("broadcasts to attached ports and drops dead ones", () => {
    const router = new PortRouter({
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      onApprovalResponse: vi.fn(),
    });
    const a = stubPort({ url: `${EXT_ORIGIN}/sidepanel.html` });
    const b = stubPort({ url: `${EXT_ORIGIN}/sidepanel.html` });
    router.attach(a);
    router.attach(b);
    router.broadcast({ type: "task_status", state: "working" });
    expect(a.inbound).toEqual([{ type: "task_status", state: "working" }]);
    expect(b.inbound).toEqual([{ type: "task_status", state: "working" }]);
    vi.mocked(b.postMessage).mockImplementation(() => {
      throw new Error("port closed");
    });
    router.broadcast({ type: "task_status", state: "idle" });
    expect(router.ports.size).toBe(1); // b evicted, a still served
    expect(a.inbound.length).toBe(2);
  });

  it("routes approval responses and ignores bad shapes / disconnected ports", () => {
    const onApprovalResponse = vi.fn();
    const router = new PortRouter({
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      onApprovalResponse,
    });
    const port = stubPort({ url: `${EXT_ORIGIN}/sidepanel.html` });
    router.attach(port);
    const emit = (m: unknown) => port.__emit(m);

    emit({ type: "approval_response", id: "x", decision: "once" });
    expect(onApprovalResponse).toHaveBeenCalledWith(
      { type: "approval_response", id: "x", decision: "once" },
      port,
    );

    onApprovalResponse.mockClear();
    emit({ type: "approval_response", id: "x", decision: "EVERYTHING" }); // bad decision
    emit({ type: "init_state", agentActive: true }); // privileged type from outside
    emit("garbage");
    expect(onApprovalResponse).not.toHaveBeenCalled();

    port.__close();
    emit({ type: "approval_response", id: "y", decision: "deny" }); // after disconnect
    expect(onApprovalResponse).not.toHaveBeenCalled();
  });

  it("isApprovalResponseMessage validates the full shape", () => {
    expect(
      isApprovalResponseMessage({ type: "approval_response", id: "x", decision: "site" }),
    ).toBe(true);
    expect(isApprovalResponseMessage({ type: "approval_response", id: 5, decision: "site" })).toBe(
      false,
    );
    expect(isApprovalResponseMessage(null)).toBe(false);
  });
});

describe("PortRouter — onPanelDisconnected (M5-9)", () => {
  function panelPort(): TestPort {
    return stubPort({ url: `${EXT_ORIGIN}/sidepanel.html` });
  }

  it("fires when the LAST panel port disconnects", () => {
    const onPanelDisconnected = vi.fn();
    const router = new PortRouter({
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      onApprovalResponse: vi.fn(),
      onPanelDisconnected,
    });
    const a = panelPort();
    const b = panelPort();
    expect(router.attach(a)).toBe(true);
    expect(router.attach(b)).toBe(true);

    a.__close();
    expect(onPanelDisconnected).not.toHaveBeenCalled(); // b can still answer

    b.__close();
    expect(onPanelDisconnected).toHaveBeenCalledTimes(1);
    expect(router.hasListener()).toBe(false);
  });

  it("fires on the only port's disconnect; a later reconnect cycles it again", () => {
    const onPanelDisconnected = vi.fn();
    const router = new PortRouter({
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      onApprovalResponse: vi.fn(),
      onPanelDisconnected,
    });
    const port = panelPort();
    router.attach(port);
    port.__close();
    expect(onPanelDisconnected).toHaveBeenCalledTimes(1);

    const again = panelPort();
    router.attach(again);
    again.__close();
    expect(onPanelDisconnected).toHaveBeenCalledTimes(2);
  });

  it("rejected ports never trigger it", () => {
    const onPanelDisconnected = vi.fn();
    const router = new PortRouter({
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      onApprovalResponse: vi.fn(),
      onPanelDisconnected,
    });
    expect(router.attach(stubPort({ name: "wrong-port" }))).toBe(false);
    expect(router.attach(stubPort({ url: "https://evil.example/" }))).toBe(false);
    expect(onPanelDisconnected).not.toHaveBeenCalled();
    expect(router.hasListener()).toBe(false);
  });
});
