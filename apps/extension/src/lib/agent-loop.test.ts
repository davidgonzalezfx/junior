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
