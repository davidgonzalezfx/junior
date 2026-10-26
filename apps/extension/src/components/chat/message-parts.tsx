// Chat message part renderers (plan §5.3): collapsible tool-call cards (tool,
// args, result, duration), collapsible reasoning blocks, usage chips, and the empty
// state. Split from chat-panel.tsx so the panel keeps the wiring and these stay
// presentational. Collapsibles are native <details> — works in jsdom, no Radix.
import type { ChatMessageMetadata } from "@junior/protocol";
import { Button } from "@/components/ui/button";

/** The shape both tool part kinds share on the client (v7 docs: `tool-<name>` static
 * parts and `dynamic-tool` carry toolCallId/state/input/output/errorText alike). */
export interface ToolPartView {
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export function isToolPart(part: { type: string }): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

export function isToolPartView(part: unknown): part is ToolPartView & { type: string } {
  if (part === null || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  return typeof p.toolCallId === "string" && typeof p.state === "string";
}

/** One-line JSON summary for a card header — first scalar-ish field wins. */
function summarize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (entries.length > 0) return String(entries[0]![1]);
  }
  return "";
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallCard({
  toolName,
  part,
  durationMs,
}: {
  toolName: string;
  part: ToolPartView;
  /** Client-measured input→output gap; null when unobserved (restored sessions). */
  durationMs: number | null;
}) {
  const stateLabel =
    part.state === "output-error"
      ? "failed"
      : part.state === "output-available"
        ? "done"
        : part.state === "input-streaming"
          ? "preparing…"
          : "running…";
  return (
    <details
      data-tool-call={toolName}
      data-state={part.state}
      className="my-1 rounded-md border border-border bg-secondary/40 text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 font-mono">
        <span aria-hidden>{part.state === "output-error" ? "✗" : "⚙"}</span>
        <span className="font-medium">{toolName}</span>
        <span className="text-muted-foreground">{stateLabel}</span>
        {summarize(part.input) ? (
          <span className="ml-auto max-w-[40%] truncate text-muted-foreground">
            {summarize(part.input)}
          </span>
        ) : null}
        {durationMs !== null ? (
          <span className="ml-auto text-muted-foreground">{formatDuration(durationMs)}</span>
        ) : null}
      </summary>
      <div className="border-t border-border px-2 py-1">
        {part.input !== undefined ? (
          <>
            <p className="text-muted-foreground">args</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">
              {safeJson(part.input)}
            </pre>
          </>
        ) : null}
        {part.state === "output-error" ? (
          <>
            <p className="text-muted-foreground">error</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-destructive">
              {part.errorText ?? "unknown error"}
            </pre>
          </>
        ) : part.output !== undefined ? (
          <>
            <p className="text-muted-foreground">result</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">
              {safeJson(part.output)}
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

/** Size-guarded JSON for card bodies — tool outputs are already wire-capped bridge-side
 * (§6.3-6), but a restored session's stored part is still untrusted render input. */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 1) ?? "";
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return String(value);
  }
}

export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  // Forced open while streaming, uncontrolled (user-toggleable) afterwards.
  return (
    <details
      data-reasoning={streaming ? "streaming" : "done"}
      open={streaming || undefined}
      className="my-1 rounded-md border border-border bg-muted/40 text-xs"
    >
      <summary className="cursor-pointer px-2 py-1 text-muted-foreground">
        {streaming ? "Thinking…" : "Reasoning"}{" "}
        <span className="text-muted-foreground/70">({text.length.toLocaleString()} chars)</span>
      </summary>
      <p className="whitespace-pre-wrap px-2 py-1 font-mono text-muted-foreground">{text}</p>
    </details>
  );
}

/** Per-message token/model/provider chip (plan §5.3 usage chips; gap #7 — Autono had
 * zero token visibility). Rendered only when the engine attached metadata. */
export function UsageChip({ metadata }: { metadata: ChatMessageMetadata | undefined }) {
  if (metadata === undefined) return null;
  const { usage, model, provider, durationMs, costUsd } = metadata;
  const bits: string[] = [];
  if (usage !== undefined) {
    const tokens: string[] = [];
    if (usage.inputTokens !== undefined) tokens.push(`↓${usage.inputTokens.toLocaleString()}`);
    if (usage.outputTokens !== undefined) tokens.push(`↑${usage.outputTokens.toLocaleString()}`);
    if (tokens.length > 0) bits.push(`${tokens.join(" ")} tok`);
    else if (usage.totalTokens !== undefined)
      bits.push(`${usage.totalTokens.toLocaleString()} tok`);
  }
  if (durationMs !== undefined) bits.push(formatDuration(durationMs));
  if (costUsd !== undefined && costUsd > 0) bits.push(`$${costUsd.toFixed(4)}`);
  if (model !== undefined) bits.push(model);
  if (provider !== undefined) bits.push(provider);
  if (bits.length === 0) return null;
  return (
    <p data-usage-chip className="mt-1 text-[11px] text-muted-foreground/80">
      {bits.join(" · ")}
    </p>
  );
}

/** The zero-messages state — a hint plus one-tap example prompts. */
export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  const examples = [
    "Summarize this page",
    "Toggle Agent, then: read this page and list every link",
    "What can Junior do in this tab?",
  ];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        Ask anything, or toggle Agent and give Junior a goal in this tab.
      </p>
      <div className="flex flex-col gap-2">
        {examples.map((text) => (
          <Button
            key={text}
            variant="outline"
            size="sm"
            className="max-w-xs whitespace-normal text-xs"
            onClick={() => onPick(text)}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}
