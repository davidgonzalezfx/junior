// @junior/bridge/chat/messages-sanitize — M5-10: heal broken replayed history.
// A panel closed mid-tool (the M5-9 scenario) can persist an assistant message whose
// tool part never received its result. Every later send in that session replays the
// broken history, and providers reject it outright ("Tool result is missing for tool
// call …"). This is the single choke point applied before convertToModelMessages in
// routes.ts — old broken sessions heal on their next send, and the extension's
// finalize-on-death (history.ts) keeps NEW sessions from being written broken.
import type { UIMessage } from "ai";

const isToolType = (type: string): boolean =>
  type === "dynamic-tool" || type.startsWith("tool-");

/** A tool part is resolved when it reached a terminal state (v7 ToolUIPart:
 * output-available carries `output`, output-error carries `errorText`). The loose
 * wire/storage shape is checked defensively — result evidence beats the state stamp,
 * so a part with an `output` but a stale state still counts as paired. */
function hasResultEvidence(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false;
  const p = part as Record<string, unknown>;
  if (p.output !== undefined) return true;
  if (typeof p.errorText === "string" && p.errorText.length > 0) return true;
  return p.state === "output-available" || p.state === "output-error";
}

/** Drop tool-call parts that carry no matching tool result (any role — the call and
 * its result live on the same part in v7, so an unresolved part is a dangling call
 * wherever it sits). An assistant message left with zero parts is dropped entirely:
 * an empty assistant turn is its own provider error. Unchanged messages keep object
 * identity; messages whose `parts` is not an array pass through untouched so the SDK
 * validator (not this function) turns them into the usual 400. */
export function dropDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((message) => {
      if (!Array.isArray(message.parts)) return message;
      const parts = message.parts.filter(
        (part) => !isToolType(part.type) || hasResultEvidence(part),
      );
      return parts.length === message.parts.length ? message : { ...message, parts };
    })
    .filter((m) => m.role !== "assistant" || m.parts.length > 0);
}
