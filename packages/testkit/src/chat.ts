// Fake UIMessage factories (workplan C2) — the text-part shapes the panel,
// history and bridge tests pass around. Defaults match the `u-${text}` /
// `a-${text}` id convention the oldest copies used; pass an explicit id where a
// test asserts a specific one.
import type { UIMessage } from "ai";

export function userMessage(text: string, id = `u-${text}`): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export function assistantMessage(text: string, id = `a-${text}`): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}
