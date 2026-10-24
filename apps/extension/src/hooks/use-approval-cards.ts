// useApprovalCards — panel side of the Port channel (plan §5.2 item 5, §5.3
// approval cards). Connects to the SW with the router's port name, holds one
// card per pending approval (Map keyed by id — cards coexist), and exposes
// respond(). The 120 s deadline computed here is DISPLAY: the SW broker's timer
// is authoritative and its approval_resolved removes the card either way.
import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import {
  PANEL_PORT_NAME,
  type ApprovalRequestMessage,
  type ApprovalResponseMessage,
  type ApprovalResolvedMessage,
  type InitStateMessage,
  type TaskStatusMessage,
} from "@/lib/port-router";

export interface PendingCard {
  id: string;
  approval: ApprovalRequestMessage["approval"];
  /** Epoch ms at which the card expires (deny) — drives the countdown ring. */
  deadline: number;
  totalMs: number;
}

export type AgentStatus = TaskStatusMessage["state"];

export interface AgentChannelState {
  cards: PendingCard[];
  respond: (id: string, decision: "once" | "site" | "deny") => void;
  status: AgentStatus | null;
  init: InitStateMessage | null;
}

export function useApprovalCards(): AgentChannelState {
  const [cardsById, setCardsById] = useState<Map<string, PendingCard>>(new Map());
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [init, setInit] = useState<InitStateMessage | null>(null);
  const respondRef = useRef<(id: string, decision: ApprovalResponseMessage["decision"]) => void>(
    () => {},
  );

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let port: ReturnType<typeof browser.runtime.connect> | null = null;

    const removeCard = (id: string) =>
      setCardsById((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });

    const connect = () => {
      if (closed) return;
      port = browser.runtime.connect({ name: PANEL_PORT_NAME });
      port.onMessage.addListener((msg: unknown) => {
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as { type?: string };
        if (m.type === "init_state") setInit(msg as InitStateMessage);
        else if (m.type === "approval_request") {
          const req = msg as ApprovalRequestMessage;
          setCardsById((prev) =>
            new Map(prev).set(req.id, {
              id: req.id,
              approval: req.approval,
              deadline: Date.now() + req.remainingMs,
              totalMs: req.remainingMs,
            }),
          );
        } else if (m.type === "approval_resolved") {
          removeCard((msg as ApprovalResolvedMessage).id);
        } else if (m.type === "task_status") {
          setStatus((msg as TaskStatusMessage).state);
        }
      });
      // SW restarted or dropped the port — reconnect after a beat.
      port.onDisconnect.addListener(() => {
        if (!closed) retry = setTimeout(connect, 1000);
      });
    };

    connect();
    respondRef.current = (id, decision) => {
      removeCard(id); // don't wait for approval_resolved — the click already decided
      port?.postMessage({
        type: "approval_response",
        id,
        decision,
      } satisfies ApprovalResponseMessage);
    };
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      port?.disconnect();
    };
  }, []);

  return {
    cards: [...cardsById.values()],
    respond: (id, decision) => respondRef.current(id, decision),
    status,
    init,
  };
}
