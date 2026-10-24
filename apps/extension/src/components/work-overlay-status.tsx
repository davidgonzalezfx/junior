// Work-overlay status chip (plan §5.3 work-overlay-status): mirrors the SW's
// task_status broadcasts (§5.2 item 5) in the panel header. The page-side
// overlay (§5.2 item 6) shows the same state on the page itself.
import type { AgentStatus } from "@/hooks/use-approval-cards";

const LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  working: "Junior is working",
  awaiting_approval: "Waiting for you",
  paused: "Paused",
};

const DOTS: Record<AgentStatus, string> = {
  idle: "bg-muted-foreground/40",
  working: "bg-sky-500 animate-pulse",
  awaiting_approval: "bg-amber-500",
  paused: "bg-green-500",
};

export function WorkOverlayStatus({ status }: { status: AgentStatus | null }) {
  const s: AgentStatus = status ?? "idle";
  return (
    <span
      data-testid="work-overlay-status"
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground"
    >
      <span className={`h-2 w-2 rounded-full ${DOTS[s]}`} aria-hidden />
      {LABELS[s]}
    </span>
  );
}
