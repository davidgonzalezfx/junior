// @junior/bridge/chat/cli-mapper — the pure stream-json → UI-message chunk mapper
// for the CLI engine (plan §4.5 "Stream mapping"). Split out of engine-cli.ts so the
// spawn/pump side and this state machine stay under the ~400-line rule; it has no
// I/O, so every behavior is unit-testable without a process.
// Emits start/end pairs around every text/reasoning part (the UI stream protocol
// rejects deltas without a start — AI_UIMessageStreamError). Tool parts are single
// events: tool-input-available from the assistant event's complete tool_use blocks
// (the stream_event input_json_delta partials are redundant with them), tool-output-
// available from the user event's tool_result blocks. The wrapper's lifecycle
// (start/start-step/finish-step/finish) belongs to the caller.
import type { UIMessageChunk } from "ai";

export interface CliResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CliResult {
  subtype: string;
  isError: boolean;
  text: string | null;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  usage: CliResultUsage | null;
}

interface BlockState {
  kind: "text" | "thinking" | "tool_use";
}

export class CliStreamMapper {
  result: CliResult | null = null;
  initSessionId: string | null = null;
  /** stream-json lines that didn't parse into a known event — the caller warns. */
  unknownLines = 0;
  /** init-event mcp_servers with status "failed" — surfaced as a warning (M0-3:
   * an unreachable MCP server is non-fatal but shows here). */
  readonly failedMcpServers: string[] = [];

  private readonly blocks = new Map<number, BlockState>();
  private readonly openParts = new Map<number, string>(); // block index → UI part id
  /** Accumulated delta text per block index — the assistant event arrives after the
   * deltas with the SAME indexes, so this is how a block proves it already streamed. */
  private readonly deltaBuf = new Map<number, string>();
  private partSeq = 0;

  private partId(): string {
    this.partSeq += 1;
    return `cli-${this.partSeq}`;
  }

  handle(raw: unknown): UIMessageChunk[] {
    if (raw === null || typeof raw !== "object") {
      this.unknownLines += 1;
      return [];
    }
    const ev = raw as Record<string, unknown>;
    switch (ev.type) {
      case "system": {
        const event = ev as {
          subtype?: unknown;
          session_id?: unknown;
          mcp_servers?: unknown;
        };
        if (event.subtype === "init") {
          if (typeof event.session_id === "string") this.initSessionId = event.session_id;
          if (Array.isArray(event.mcp_servers)) {
            for (const server of event.mcp_servers) {
              if (
                server !== null &&
                typeof server === "object" &&
                (server as { status?: unknown }).status === "failed" &&
                typeof (server as { name?: unknown }).name === "string"
              ) {
                this.failedMcpServers.push((server as { name: string }).name);
              }
            }
          }
        }
        return [];
      }
      case "stream_event":
        return this.handleStreamEvent((ev as { event?: unknown }).event);
      case "assistant":
        return this.handleAssistant((ev as { message?: unknown }).message);
      case "user":
        return this.handleUser((ev as { message?: unknown }).message);
      case "result":
        return this.handleResult(ev);
      default:
        this.unknownLines += 1;
        return [];
    }
  }

  private handleStreamEvent(inner: unknown): UIMessageChunk[] {
    if (inner === null || typeof inner !== "object") {
      this.unknownLines += 1;
      return [];
    }
    const e = inner as Record<string, unknown>;
    const index = typeof e.index === "number" ? e.index : -1;
    switch (e.type) {
      case "content_block_start": {
        const block = e.content_block as { type?: unknown } | undefined;
        const kind = block?.type;
        if (kind !== "text" && kind !== "thinking") return []; // tool_use handled via assistant
        const id = this.partId();
        this.blocks.set(index, { kind });
        this.openParts.set(index, id);
        return kind === "text" ? [{ type: "text-start", id }] : [{ type: "reasoning-start", id }];
      }
      case "content_block_delta": {
        const delta = e.delta as { type?: unknown; text?: unknown; thinking?: unknown } | undefined;
        const id = this.openParts.get(index);
        if (delta?.type === "text_delta" && typeof delta.text === "string" && id !== undefined) {
          this.deltaBuf.set(index, (this.deltaBuf.get(index) ?? "") + delta.text);
          return [{ type: "text-delta", id, delta: delta.text }];
        }
        if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          id !== undefined
        ) {
          this.deltaBuf.set(index, (this.deltaBuf.get(index) ?? "") + delta.thinking);
          return [{ type: "reasoning-delta", id, delta: delta.thinking }];
        }
        return []; // signature_delta / input_json_delta (assistant event owns tool input)
      }
      case "content_block_stop": {
        const id = this.openParts.get(index);
        const block = this.blocks.get(index);
        if (id === undefined || block === undefined || block.kind === "tool_use") return [];
        this.openParts.delete(index);
        return block.kind === "text" ? [{ type: "text-end", id }] : [{ type: "reasoning-end", id }];
      }
      case "message_start":
        // New message: the full-block `assistant` event lands DURING its own event
        // sequence (verified 2.1.310: deltas → assistant → content_block_stop), so
        // the delta accumulation the dedupe compares against must be per-message.
        this.deltaBuf.clear();
        this.blocks.clear();
        this.openParts.clear();
        return [];
      case "message_delta":
      case "message_stop":
        return [];
      default:
        this.unknownLines += 1;
        return [];
    }
  }

  /** Full blocks incl. tool_use. Text/thinking blocks whose deltas never arrived
   * (parse gaps, or a CLI run without --include-partial-messages) are emitted here
   * as one-shot trios so their content is never silently dropped. */
  private handleAssistant(message: unknown): UIMessageChunk[] {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return [];
    const chunks: UIMessageChunk[] = [];
    content.forEach((raw, index) => {
      if (raw === null || typeof raw !== "object") return;
      const block = raw as Record<string, unknown>;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        chunks.push({
          type: "tool-input-available",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input ?? {},
        });
        return;
      }
      if (block.type !== "text" && block.type !== "thinking") return;
      const text =
        typeof block.text === "string" && block.text ? block.text : (block.thinking ?? "");
      if (typeof text !== "string" || !text) return;
      if (this.deltaBuf.get(index) === text) return; // already streamed via deltas
      const id = this.partId();
      if (block.type === "text") {
        chunks.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: text },
          { type: "text-end", id },
        );
      } else {
        chunks.push(
          { type: "reasoning-start", id },
          { type: "reasoning-delta", id, delta: text },
          { type: "reasoning-end", id },
        );
      }
    });
    return chunks;
  }

  private handleUser(message: unknown): UIMessageChunk[] {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return [];
    const chunks: UIMessageChunk[] = [];
    for (const raw of content) {
      if (raw === null || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      chunks.push({
        type: "tool-output-available",
        toolCallId: block.tool_use_id,
        output: toolResultText(block.content),
      });
    }
    return chunks;
  }

  private handleResult(ev: Record<string, unknown>): UIMessageChunk[] {
    const usageRaw = ev.usage;
    this.result = {
      subtype: typeof ev.subtype === "string" ? ev.subtype : "unknown",
      isError: ev.is_error === true,
      text: typeof ev.result === "string" ? ev.result : null,
      numTurns: typeof ev.num_turns === "number" ? ev.num_turns : null,
      durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : null,
      totalCostUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null,
      usage:
        usageRaw !== null && typeof usageRaw === "object" ? (usageRaw as CliResultUsage) : null,
    };
    if (this.result.isError) {
      return [
        {
          type: "error",
          errorText: this.result.text ?? `Claude CLI result error (${this.result.subtype})`,
        },
      ];
    }
    return [];
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content ?? null);
}
