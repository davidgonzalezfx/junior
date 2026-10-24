// Approval cards (plan §5.3, M3-3): bottom-sheet stack, one card per pending
// approval. Every row shows REAL probed facts from the wire contract
// (ApprovalRequestSchema — background.js:1966–2010 contract, Junior fields) —
// never model text (§6.3-1). Countdown ring counts down to the SW broker's
// default-deny deadline; hitting zero answers deny (§6.3-3).
import { useEffect, useState } from "react";
import type { ApprovalRequest } from "@junior/protocol";
import { Button } from "@/components/ui/button";
import type { PendingCard } from "@/hooks/use-approval-cards";

const TICK_MS = 250;

function CountdownRing({ deadline, totalMs }: { deadline: number; totalMs: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));

  useEffect(() => {
    const timer = setInterval(() => setRemaining(Math.max(0, deadline - Date.now())), TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  const fraction = totalMs > 0 ? remaining / totalMs : 0;
  const R = 9;
  const C = 2 * Math.PI * R;
  const seconds = Math.ceil(remaining / 1000);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
      aria-label={`Auto-deny in ${seconds} seconds`}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle
          cx="11"
          cy="11"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2.5"
        />
        <circle
          cx="11"
          cy="11"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - fraction)}
          transform="rotate(-90 11 11)"
        />
      </svg>
      {seconds}s
    </span>
  );
}

function FactRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 break-words ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

/** True when the element fact points at a credential field (the guard refuses
 * typing into those, so `typed` never arrives — say so instead of nothing). */
function isSecretElement(approval: ApprovalRequest): boolean {
  return approval.element?.type?.toLowerCase() === "password";
}

export function ApprovalCardBody({ approval }: { approval: ApprovalRequest }) {
  const el = approval.element;
  return (
    <div className="flex flex-col gap-1.5">
      {approval.reasons.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-foreground">
          {approval.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <FactRow label="Page" value={approval.pageUrl} mono />
      {approval.destinationUrl && <FactRow label="Address" value={approval.destinationUrl} mono />}
      {el && (
        <FactRow
          label="Element"
          value={el.type ? `<${el.tag} type="${el.type}">` : `<${el.tag}>`}
          mono
        />
      )}
      {el?.text && <FactRow label="Text" value={el.text} />}
      {el?.href && <FactRow label="Link" value={el.href} mono />}
      {el?.formAction && <FactRow label="Form sends to" value={el.formAction} mono />}
      {approval.typed != null && <FactRow label="Will type" value={approval.typed} mono />}
      {approval.typed == null && isSecretElement(approval) && (
        <FactRow label="Will type" value="secret field (hidden)" mono />
      )}
    </div>
  );
}

export function ApprovalCard({
  card,
  respond,
}: {
  card: PendingCard;
  respond: (id: string, decision: "once" | "site" | "deny") => void;
}) {
  const { approval, id } = card;
  // Auto-deny at zero: the SW broker resolves the same way — whoever lands
  // first, the card just goes away (double answer is deduped by id both sides).
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() >= card.deadline) respond(id, "deny");
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [card.deadline, id, respond]);

  return (
    <div
      role="dialog"
      aria-label="Junior asks for approval"
      className="rounded-lg border bg-card p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Junior needs your approval</span>
        <CountdownRing deadline={card.deadline} totalMs={card.totalMs} />
      </div>
      <ApprovalCardBody approval={approval} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => respond(id, "once")}>
          Allow once
        </Button>
        {approval.siteDomain && (
          <Button size="sm" variant="outline" onClick={() => respond(id, "site")}>
            Allow {approval.siteDomain} for this session
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => respond(id, "deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

export function ApprovalCardStack({
  cards,
  respond,
}: {
  cards: PendingCard[];
  respond: (id: string, decision: "once" | "site" | "deny") => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t bg-background p-3" aria-label="Pending approvals">
      {cards.map((card) => (
        <ApprovalCard key={card.id} card={card} respond={respond} />
      ))}
    </div>
  );
}
