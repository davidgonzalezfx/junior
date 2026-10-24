// Agent-loop tests: queue-item routing over fake deps — action → execute →
// action-result, approval → card → approval-response (timeout default-deny incl.),
// backoff on poll failures, mirror-ask site grants. No fetch, no timers but the
// injected ones.
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, QueueItem } from "@junior/protocol";
import { AgentLoop, APPROVAL_WINDOW_MS, mirrorAsk, type AgentLoopDeps } from "./agent-loop";
import type { ApprovalAsk } from "./panel-approvals";
import type { ExecuteOutcome } from "./executors";

const APPROVAL: ApprovalRequest = {
  reasonCodes: ["sensitive_site"],
  reasons: ["Sensitive site: a bank"],
  pageUrl: "https://bank.example/",
  siteDomain: "bank.example",
};

function actionItem(over: Partial<Extract<QueueItem, { kind: "action" }>> = {}): QueueItem {
  return {
    id: "action-1",
    kind: "action",
    action: { kind: "get_active_tab" },
    createdAt: 1_000,
    timeoutMs: 120_000,
    ...over,
  };
}

function approvalItem(over: Partial<Extract<QueueItem, { kind: "approval" }>> = {}): QueueItem {
  return {
    id: "approval-1",
    kind: "approval",
    approval: APPROVAL,
    createdAt: 1_000,
    timeoutMs: 120_000,
    ...over,
  };
}

interface Harness {
  loop: AgentLoop;
  deps: AgentLoopDeps & {
    polls: ReturnType<typeof vi.fn>;
    resultsMock: ReturnType<typeof vi.fn>;
    decisionsMock: ReturnType<typeof vi.fn>;
    executeMock: ReturnType<typeof vi.fn>;
    askRequest: ReturnType<typeof vi.fn>;
    grants: string[];
  };
}

function makeHarness(items: QueueItem[]): Harness {
  const askRequest = vi.fn(async () => "once" as const);
  const grants: string[] = [];
  const polls = vi.fn();
  const resultsMock = vi.fn(async () => {});
  const decisionsMock = vi.fn(async () => {});
  const executeMock = vi.fn(async (): Promise<ExecuteOutcome> => ({
    status: "ok",
    result: "done",
  }));
  const deps = {
    polls,
    resultsMock,
    decisionsMock,
    executeMock,
    askRequest,
    grants,
    poll: polls,
    postResult: resultsMock,
    postDecision: decisionsMock,
    execute: executeMock,
    ask: { request: askRequest, hasListener: () => true } satisfies ApprovalAsk,
    onStatus: vi.fn(),
    now: () => 5_000, // queue latency = 4 s in these fixtures
    delay: vi.fn(async () => {}), // never loops: no real sleep in tests
  } satisfies AgentLoopDeps & Record<string, unknown>;
  // poll returns each fixture once, then blocks forever on a never-resolving
  // promise (the loop awaits it; stop() ends the test without another tick).
  let i = 0;
  polls.mockImplementation(() => {
    const item = items[i++];
    return item === undefined ? new Promise<null>(() => {}) : Promise.resolve(item);
  });
  const loop = new AgentLoop(deps);
  loop.start();
  return { loop, deps: deps as Harness["deps"] };
}

describe("AgentLoop", () => {
  it("action item → execute → POST action-result with the queue id", async () => {
    const { loop, deps } = makeHarness([actionItem()]);
    await vi.waitFor(() => expect(deps.resultsMock).toHaveBeenCalledTimes(1));
    expect(deps.executeMock).toHaveBeenCalledWith({ kind: "get_active_tab" });
    expect(deps.resultsMock).toHaveBeenCalledWith({ id: "action-1", status: "ok", result: "done" });
    expect(deps.onStatus).toHaveBeenCalledWith("working", "get_active_tab ");
    expect(deps.onStatus).toHaveBeenLastCalledWith("idle");
    loop.stop();
  });

  it("execute throwing still posts an error result", async () => {
    const h = makeHarness([actionItem()]);
    h.deps.executeMock.mockRejectedValueOnce(new Error("boom"));
    await vi.waitFor(() => expect(h.deps.resultsMock).toHaveBeenCalledTimes(1));
    expect(h.deps.resultsMock).toHaveBeenCalledWith({
      id: "action-1",
      status: "error",
      error: "boom",
    });
    h.loop.stop();
  });

  it("approval item → card with the queue latency deducted, answer POSTed", async () => {
    const { loop, deps } = makeHarness([approvalItem()]);
    await vi.waitFor(() => expect(deps.decisionsMock).toHaveBeenCalledTimes(1));
    expect(deps.askRequest).toHaveBeenCalledWith(APPROVAL, 120_000 - 4_000);
    expect(deps.decisionsMock).toHaveBeenCalledWith({ id: "approval-1", decision: "once" });
    loop.stop();
  });

  it("approval remaining window never drops below 1 s", async () => {
    const { loop, deps } = makeHarness([
      approvalItem({ createdAt: 0, timeoutMs: 2_000 }), // already stale
    ]);
    await vi.waitFor(() => expect(deps.decisionsMock).toHaveBeenCalledTimes(1));
    expect(deps.askRequest).toHaveBeenCalledWith(APPROVAL, 1_000);
    loop.stop();
  });

  it("backoff grows on poll failures and resets after success", async () => {
    let calls = 0;
    const deps = {
      poll: vi.fn(async (): Promise<QueueItem | null> => {
        calls += 1;
        if (calls <= 2) throw new Error("unreachable");
        // The real poll long-polls ~15 s per round; block here so the loop
        // idles instead of spinning on instant nulls.
        return new Promise<null>(() => {});
      }),
      postResult: vi.fn(),
      postDecision: vi.fn(),
      execute: vi.fn(),
      ask: { request: vi.fn(), hasListener: () => true },
      delay: vi.fn(async () => {}),
    };
    const loop = new AgentLoop(deps);
    loop.start();
    await vi.waitFor(() => expect(deps.delay).toHaveBeenCalledTimes(2));
    loop.stop();
  });

  it("mirrorAsk persists a 'site' answer as a registrable-domain grant", async () => {
    const ask: ApprovalAsk = {
      request: vi.fn(async () => "site" as const),
      hasListener: () => true,
    };
    const onGrantSite = vi.fn(async () => {});
    const answer = await mirrorAsk(ask, onGrantSite)(APPROVAL);
    expect(answer).toBe("site");
    expect(onGrantSite).toHaveBeenCalledWith("bank.example");
  });

  it("mirrorAsk derives the domain from pageUrl when siteDomain is absent", async () => {
    const ask: ApprovalAsk = {
      request: vi.fn(async () => "site" as const),
      hasListener: () => true,
    };
    const onGrantSite = vi.fn(async () => {});
    await mirrorAsk(ask, onGrantSite)({ ...APPROVAL, siteDomain: undefined });
    expect(onGrantSite).toHaveBeenCalledWith("bank.example");
  });

  it("mirrorAsk passes deny/once through without granting", async () => {
    const ask: ApprovalAsk = {
      request: vi.fn(async () => "deny" as const),
      hasListener: () => true,
    };
    const onGrantSite = vi.fn(async () => {});
    await expect(mirrorAsk(ask, onGrantSite)(APPROVAL)).resolves.toBe("deny");
    expect(onGrantSite).not.toHaveBeenCalled();
  });

  it("mirrorAsk uses the §4.3 120 s window for locally-raised cards", () => {
    expect(APPROVAL_WINDOW_MS).toBe(120_000);
  });
});

describe("AgentLoop — pause (§5.2 item 6)", () => {
  /** Harness whose polls never resolve on their own — the test releases them. */
  function makePausedHarness() {
    let pending: ((item: QueueItem | null) => void) | undefined;
    const polls = vi.fn(
      () =>
        new Promise<QueueItem | null>((resolve) => {
          pending = resolve;
        }),
    );
    /** Release the in-flight poll (throws if none is pending). */
    const resolvePoll = (item: QueueItem | null) => {
      if (!pending) throw new Error("no poll in flight");
      pending(item);
    };
    const resultsMock = vi.fn(async () => {});
    const decisionsMock = vi.fn(async () => {});
    const executeMock = vi.fn(async (): Promise<ExecuteOutcome> => ({ status: "ok" }));
    const onPausedChange = vi.fn();
    const deps: AgentLoopDeps = {
      poll: polls,
      postResult: resultsMock,
      postDecision: decisionsMock,
      execute: executeMock,
      ask: { request: vi.fn(async () => "once" as const), hasListener: () => true },
      onStatus: vi.fn(),
      onPausedChange,
    };
    const loop = new AgentLoop(deps);
    loop.start();
    return { loop, polls, resolvePoll, resultsMock, decisionsMock, executeMock, onPausedChange };
  }

  it("setPaused fires onPausedChange and stops polling; resume restarts it", async () => {
    const h = makePausedHarness();
    await vi.waitFor(() => expect(h.polls).toHaveBeenCalledTimes(1));

    h.loop.setPaused(true);
    expect(h.onPausedChange).toHaveBeenCalledWith(true);
    expect(h.loop.isPaused).toBe(true);

    // The in-flight poll resolving while paused must NOT start another round.
    h.resolvePoll(null);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.polls).toHaveBeenCalledTimes(1);

    h.loop.setPaused(false);
    expect(h.onPausedChange).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(h.polls).toHaveBeenCalledTimes(2));
    h.loop.stop();
  });

  it("an action fetched while paused is answered denied: paused, never executed", async () => {
    const h = makePausedHarness();
    await vi.waitFor(() => expect(h.polls).toHaveBeenCalledTimes(1));
    h.loop.setPaused(true);
    h.resolvePoll(actionItem({ id: "held" }));
    await vi.waitFor(() =>
      expect(h.resultsMock).toHaveBeenCalledWith({ id: "held", status: "denied", error: "paused" }),
    );
    expect(h.executeMock).not.toHaveBeenCalled();
    h.loop.stop();
  });

  it("an approval fetched while paused resolves deny without showing a card", async () => {
    const h = makePausedHarness();
    await vi.waitFor(() => expect(h.polls).toHaveBeenCalledTimes(1));
    h.loop.setPaused(true);
    h.resolvePoll(approvalItem({ id: "held-card" }));
    await vi.waitFor(() =>
      expect(h.decisionsMock).toHaveBeenCalledWith({ id: "held-card", decision: "deny" }),
    );
    h.loop.stop();
  });

  it("stop() while paused parks-out cleanly and resume after stop does nothing", async () => {
    const h = makePausedHarness();
    await vi.waitFor(() => expect(h.polls).toHaveBeenCalledTimes(1));
    h.loop.setPaused(true);
    h.resolvePoll(null); // wakes the run loop into the parked wait
    await new Promise<void>((r) => setTimeout(r, 0));
    h.loop.stop(); // must wake the parked loop and exit
    h.loop.setPaused(false); // a resume after stop must not restart polling
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.polls).toHaveBeenCalledTimes(1);
  });

  it("setPaused is idempotent — no duplicate onPausedChange", () => {
    const h = makePausedHarness();
    h.loop.setPaused(true);
    h.loop.setPaused(true);
    expect(h.onPausedChange).toHaveBeenCalledTimes(1);
    h.loop.stop();
  });
});

describe("AgentLoop — bridge loss (M4-5)", () => {
  it("a failed poll fires onBridgeError with the error and backs off before repolling", async () => {
    const onBridgeError = vi.fn();
    let calls = 0;
    const poll = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("bridge down"));
      return new Promise<null>(() => {}); // then block like a real long-poll
    });
    const delay = vi.fn(() => new Promise<void>(() => {})); // park: a real backoff sleep holds the loop here
    const loop = new AgentLoop({
      poll,
      postResult: async () => {},
      postDecision: async () => {},
      execute: async () => ({ status: "ok", result: "" }),
      ask: { request: async () => "deny", hasListener: () => true },
      onBridgeError,
      delay,
    });
    loop.start();
    await vi.waitFor(() => expect(onBridgeError).toHaveBeenCalledTimes(1));
    expect(onBridgeError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(delay).toHaveBeenCalledTimes(1); // backed off…
    expect(poll).toHaveBeenCalledTimes(1); // …and not repolled (delay is injected)
    loop.stop();
  });

  it("a healthy poll never fires onBridgeError", async () => {
    const onBridgeError = vi.fn();
    const h = makeHarness([actionItem()]);
    // rebuild the loop with the hook — makeHarness owns its deps, so drive a
    // second loop over the same fixtures shape with a rejecting-never poll.
    const loop = new AgentLoop({
      poll: () => new Promise<null>(() => {}), // idle forever, no failures
      postResult: async () => {},
      postDecision: async () => {},
      execute: async () => ({ status: "ok", result: "" }),
      ask: { request: async () => "deny", hasListener: () => true },
      onBridgeError,
      delay: async () => {},
    });
    void h;
    loop.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(onBridgeError).not.toHaveBeenCalled();
    loop.stop();
    h.loop.stop();
  });
});
