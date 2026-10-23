// ChatPanel — M2-3: plain chat over /api/chat (engine `api`) with markdown streaming
// (plan §5.3 Chat). The provider/model row is deliberately minimal — M2-4's ⌘K picker
// replaces it; history/virtualization/tool cards land with M2-5/M3.
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { BridgeUnreachableError, fetchStatus } from "@/lib/bridge-client";
import { createChatTransport, modelsFor, resolveChatTarget, type ChatTarget } from "@/lib/chat";
import { getDefaultProvider, getToken, loadSettings } from "@/lib/settings";
import { MarkdownContent } from "@/components/markdown";
import { Button } from "@/components/ui/button";

interface Setup {
  bridgeUrl: string;
  token: string;
  target: ChatTarget;
  modelOptions: string[];
}

export function ChatPanel() {
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
          throw new Error("no provider configured — add a key in Settings → Providers (M2-4)");
        const provider = status.providers.find((p) => p.id === target.providerId);
        if (stale) return;
        setSetup({
          bridgeUrl: settings.bridgeUrl,
          token,
          target,
          modelOptions: provider !== undefined ? modelsFor(provider) : [],
        });
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
  return <Chat setup={setup} />;
}

function Chat({ setup }: { setup: Setup }) {
  const [model, setModel] = useState(setup.target.model);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => createChatTransport(setup.bridgeUrl, setup.token, { ...setup.target, model }),
    [setup, model],
  );
  const { messages, sendMessage, status, error, stop } = useChat({ transport });

  const busy = status === "submitted" || status === "streaming";

  // Keep the newest message in view while streaming (history virtualization is M2-5).
  // Property assignment, not scrollTo() — jsdom elements have no scrollTo.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setDraft("");
    void sendMessage({ text });
  };

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{setup.target.providerId}</span>
        {setup.modelOptions.length > 0 ? (
          <select
            aria-label="model"
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {setup.modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="model"
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
            placeholder="model id (e.g. vendor/model-name)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
      </div>

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
