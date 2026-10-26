// ChatPanel — M2-4: plain chat over /api/chat (engine `api`) with markdown streaming
// and the ⌘K provider/model palette (plan §5.3). M2-5: session persistence — the
// active session (id + restored messages) comes from App, finished message lists
// flow back through onRecord for the debounced history write. M4-3: an Agent toggle
// (agentMode:true → bridge registers its browser tools). M5-1: tool-call cards,
// reasoning collapse, usage chips, empty/error/loading states.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { BridgeUnreachableError, fetchStatus } from "@/lib/bridge-client";
import {
  createChatTransport,
  resolveChatTarget,
  type ChatTarget,
  type JuniorUIMessage,
} from "@/lib/chat";
import { finalizeInterruptedToolParts, type StoredSession } from "@/lib/history";
import {
  addRecentModel,
  getDefaultProvider,
  getRecentModels,
  getToken,
  loadSettings,
  saveRecentModels,
  setDefaultProvider,
} from "@/lib/settings";
import { pruneRecentModels } from "@/lib/picker";
import { ensureHostAccess } from "@/lib/host-permissions";
import type { RecentModel } from "@/lib/settings";
import type { BridgeStatus } from "@junior/protocol";
import { MarkdownContent } from "@/components/markdown";
import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import {
  ChatEmptyState,
  ReasoningBlock,
  ToolCallCard,
  UsageChip,
  isToolPart,
  isToolPartView,
} from "@/components/chat/message-parts";

interface Setup {
  bridgeUrl: string;
  token: string;
  target: ChatTarget;
  status: BridgeStatus;
  recent: RecentModel[];
}

export interface ChatPanelProps {
  /** The active session — restored messages seed useChat; the id keys the mount. */
  session: StoredSession;
  /** Called on every messages change; App owns the debounced history write. */
  onRecord: (messages: UIMessage[]) => void;
}

export function ChatPanel({ session, onRecord }: ChatPanelProps) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const settings = await loadSettings();
        const token = await getToken();
        if (token === null) throw new Error("not paired — reopen the panel to run onboarding");
        const status = await fetchStatus(settings.bridgeUrl, token);
        const target = resolveChatTarget(await getDefaultProvider(), status);
        if (target === null)
          throw new Error("no provider configured — add a key in Settings → Providers");
        if (stale) return;
        // M5-2: load the persisted recents (they used to only exist for the current
        // panel session) and prune entries the catalog no longer knows.
        const stored = await getRecentModels();
        const recent = pruneRecentModels(stored, status);
        if (recent.length !== stored.length) void saveRecentModels(recent);
        setSetup({ bridgeUrl: settings.bridgeUrl, token, target, status, recent });
        setLoadError(null);
      } catch (error) {
        if (stale) return;
        setLoadError(
          error instanceof BridgeUnreachableError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    })();
    return () => {
      stale = true;
    };
  }, [reloadKey]);

  if (loadError !== null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  if (setup === null) return <div className="flex-1" />;
  // Keyed remount per session id — a history switch re-seeds useChat with the
  // stored messages (useChat's `messages` option is initial-only, v7 docs).
  return <Chat key={session.id} setup={setup} session={session} onRecord={onRecord} />;
}

function Chat({
  setup,
  session,
  onRecord,
}: {
  setup: Setup;
  session: StoredSession;
  onRecord: (messages: UIMessage[]) => void;
}) {
  const [target, setTarget] = useState<ChatTarget>(setup.target);
  const [recent, setRecent] = useState<RecentModel[]>(setup.recent);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  // M5-7: set when the agent-mode permission gate is denied — the task still runs
  // (navigation needs no origin access) but every page action will fail.
  const [hostDenied, setHostDenied] = useState(false);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => createChatTransport(setup.bridgeUrl, setup.token, target, agentMode),
    [setup, target, agentMode],
  );
  const { messages, sendMessage, regenerate, setMessages, status, error, stop } = useChat<JuniorUIMessage>({
    id: session.id,
    // Storage is typed loose (UIMessage, metadata unknown) — the one honest narrowing;
    // the wire round-trip is validated by the tests that stream message-metadata.
    messages: session.messages as JuniorUIMessage[],
    transport,
  });

  const busy = status === "submitted" || status === "streaming";
  // Tool-call card durations (plan §5.3): client-measured input→output gap, keyed by
  // toolCallId. Best-effort — restored sessions have no timing and show no duration.
  const durations = useToolDurations(messages);

  // Persist every messages change (debounced on App's side — 500 ms + write-on-hide).
  useEffect(() => {
    onRecord(messages);
  }, [messages, onRecord]);

  // M5-10 finalize-on-death: a stream that stopped mid-tool (error, Stop, provider
  // failure) leaves the card at "running…" forever. Once not busy, any non-terminal
  // tool part is dead — mark it (and the changed messages re-record below). Also
  // heals a restored session persisted broken by an older build.
  useEffect(() => {
    if (busy) return;
    const next = finalizeInterruptedToolParts(messages);
    if (next !== messages) setMessages(next);
  }, [busy, messages, setMessages]);

  // Keep the newest message in view while streaming (history virtualization is M2-5).
  // Property assignment, not scrollTo() — jsdom elements have no scrollTo.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const pickModel = (picked: { providerId: string; model: string }) => {
    setTarget({ providerId: picked.providerId, model: picked.model });
    // Persist as the panel default + record a recent entry (plan §5.3 picker contract).
    void setDefaultProvider({ providerId: picked.providerId, model: picked.model });
    void addRecentModel({ providerId: picked.providerId, model: picked.model }).then(setRecent);
  };

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setDraft("");
    // M5-7 (decisions.md 2026-10-25): agent page actions (read_page/click/type +
    // overlay injection) need origin access to the tab's site — navigation works
    // without it, real sites don't. The composer send is a user gesture, the one
    // place Chrome allows the all-sites dialog; plain chat skips the gate entirely.
    // A denial still runs the task — the notice below says page actions will fail.
    if (agentMode) {
      setHostDenied((await ensureHostAccess()) === "denied");
    }
    void sendMessage({ text });
  };

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex items-center gap-2">
        {/* The model badge IS the palette trigger (plan §5.3) — ⌘K works anywhere too. */}
        <button
          type="button"
          aria-label="Change model (⌘K)"
          title="Change model (⌘K)"
          onClick={() => setPickerOpen(true)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
        >
          <span className="text-muted-foreground">{target.providerId}</span>
          {" / "}
          <span className="font-medium">{target.model}</span>
        </button>
        {/* M4-3: agent mode sends agentMode:true — the bridge registers its browser
         * tools and the model works toward the goal in the active tab. */}
        <button
          type="button"
          aria-pressed={agentMode}
          aria-label="Agent mode"
          title="Agent mode — Junior may act in this tab (guarded by approval cards)"
          onClick={() => {
            setAgentMode((v) => !v);
            setHostDenied(false); // M5-7: the notice only describes agent-mode sends
          }}
          className={
            agentMode
              ? "rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
              : "rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          }
        >
          Agent
        </button>
      </div>

      <ModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        status={setup.status}
        recent={recent}
        current={target}
        onSelect={pickModel}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <ChatEmptyState onPick={setDraft} />
        ) : (
          // M5-4 perf: rows are memoized on message identity — a streaming delta
          // replaces only the last message object, so the other 999 rows of a
          // 1k-message session skip their markdown re-parse (see chat-panel.perf).
          messages.map((message) => (
            <MessageRow key={message.id} message={message} durations={durations} />
          ))
        )}
        {status === "submitted" ? (
          <p aria-live="polite" className="px-1 text-sm text-muted-foreground">
            Junior is thinking…
          </p>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{error instanceof Error ? error.message : String(error)}</span>
          <Button variant="outline" size="sm" onClick={() => regenerate()}>
            Retry
          </Button>
        </div>
      ) : null}

      {agentMode && hostDenied ? (
        <div
          role="alert"
          data-host-permission-denied
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Site access was denied — page actions (read, click, type) will fail this task. Re-enable
          site access for Junior in Chrome's extension settings and send again.
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          aria-label="message"
          className="max-h-40 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          rows={2}
          value={draft}
          placeholder={
            busy ? "Junior is replying…" : "Message (Enter to send, Shift+Enter for newline)"
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {busy ? (
          <Button variant="outline" size="sm" onClick={() => stop()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={draft.trim().length === 0} onClick={() => void submit()}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

/** One transcript row (M5-4 extraction): memoized on message identity — useChat
 * replaces only the last message object per delta, so untouched rows never
 * re-render (their markdown would otherwise re-parse every streamed chunk). */
const MessageRow = memo(function MessageRow({
  message,
  durations,
}: {
  message: JuniorUIMessage;
  durations: (toolCallId: string) => number | null;
}) {
  return (
    <div
      className={
        message.role === "user"
          ? "my-2 ml-8 rounded-lg bg-secondary px-3 py-2 text-sm"
          : "my-2 mr-2 px-1 text-sm"
      }
    >
      {message.parts.map((part, i) => {
        // Server-side tools arrive as tool parts (v7): streamText's static
        // tools render as `tool-<name>` part types (dynamic:false on the
        // wire), client-unknown ones as `dynamic-tool` with a toolName
        // field. Both render as collapsible cards (M5-1).
        if (isToolPart(part) && isToolPartView(part)) {
          const name =
            part.type === "dynamic-tool"
              ? (((part as { toolName?: unknown }).toolName as string | undefined) ?? "tool")
              : part.type.slice("tool-".length);
          return (
            <ToolCallCard
              key={i}
              toolName={name}
              part={part}
              durationMs={durations(part.toolCallId)}
            />
          );
        }
        if (part.type === "reasoning") {
          return <ReasoningBlock key={i} text={part.text} streaming={part.state === "streaming"} />;
        }
        return part.type === "text" ? <MarkdownContent key={i} text={part.text} /> : null;
      })}
      {message.role === "assistant" ? <UsageChip metadata={message.metadata} /> : null}
    </div>
  );
});

/** Client-measured tool durations (plan §5.3 card fields): first observation of a
 * toolCallId starts the clock; its output-available/output-error render stops it.
 * Purely in-memory — restored sessions show no duration rather than a wrong one.
 * The returned callback is stable (refs only) so memoized rows keep working. */
function useToolDurations(messages: JuniorUIMessage[]): (toolCallId: string) => number | null {
  const starts = useRef(new Map<string, number>());
  const durations = useRef(new Map<string, number>());

  useEffect(() => {
    const now = performance.now();
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolPart(part) || !isToolPartView(part)) continue;
        const done = part.state === "output-available" || part.state === "output-error";
        const existing = starts.current.get(part.toolCallId);
        if (existing === undefined) {
          starts.current.set(part.toolCallId, now);
        } else if (done && !durations.current.has(part.toolCallId)) {
          durations.current.set(part.toolCallId, Math.max(0, Math.round(now - existing)));
        }
      }
    }
  }, [messages]);

  return useCallback((toolCallId) => durations.current.get(toolCallId) ?? null, []);
}
