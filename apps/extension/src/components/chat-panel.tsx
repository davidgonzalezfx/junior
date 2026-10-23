// ChatPanel — M2-4: plain chat over /api/chat (engine `api`) with markdown streaming
// and the ⌘K provider/model palette (plan §5.3). M2-5: session persistence — the
// active session (id + restored messages) comes from App, finished message lists
// flow back through onRecord for the debounced history write. Tool cards land in M3.
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { BridgeUnreachableError, fetchStatus } from "@/lib/bridge-client";
import { createChatTransport, resolveChatTarget, type ChatTarget } from "@/lib/chat";
import type { StoredSession } from "@/lib/history";
import {
  addRecentModel,
  getDefaultProvider,
  getToken,
  loadSettings,
  setDefaultProvider,
} from "@/lib/settings";
import type { RecentModel } from "@/lib/settings";
import type { BridgeStatus } from "@junior/protocol";
import { MarkdownContent } from "@/components/markdown";
import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";

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
        setSetup({ bridgeUrl: settings.bridgeUrl, token, target, status, recent: [] });
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
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => createChatTransport(setup.bridgeUrl, setup.token, target),
    [setup, target],
  );
  const { messages, sendMessage, status, error, stop } = useChat({
    id: session.id,
    messages: session.messages,
    transport,
  });

  const busy = status === "submitted" || status === "streaming";

  // Persist every messages change (debounced on App's side — 500 ms + write-on-hide).
  useEffect(() => {
    onRecord(messages);
  }, [messages, onRecord]);

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

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setDraft("");
    void sendMessage({ text });
  };

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex items-center">
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
          <p className="p-4 text-sm text-muted-foreground">
            Say hello — replies stream in as markdown. (Agent mode and tool cards arrive in M3/M4.)
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "my-2 ml-8 rounded-lg bg-secondary px-3 py-2 text-sm"
                  : "my-2 mr-2 px-1 text-sm"
              }
            >
              {message.parts.map((part, i) =>
                part.type === "text" ? <MarkdownContent key={i} text={part.text} /> : null,
              )}
            </div>
          ))
        )}
        {status === "submitted" ? <p className="px-1 text-sm text-muted-foreground">…</p> : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
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
              submit();
            }
          }}
        />
        {busy ? (
          <Button variant="outline" size="sm" onClick={() => stop()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={draft.trim().length === 0} onClick={submit}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
