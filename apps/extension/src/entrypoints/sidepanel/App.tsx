// Panel shell — onboarding on first run + bridge status bar; chat + ⌘K picker +
// Settings → Providers; session history — App owns the active session and the
// debounced history store (plan §5.3: junior_sessions, 500 ms
// debounced writes + write-on-hide, 200-session cap with export prompt).
import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { ApprovalCardStack } from "@/components/approvals/approval-card";
import { BridgeStatusBar } from "@/components/bridge-status-bar";
import { ChatPanel } from "@/components/chat-panel";
import { HistoryPanel } from "@/components/history/history-panel";
import { Onboarding } from "@/components/onboarding";
import { ProvidersSettings } from "@/components/settings/providers-settings";
import { SecuritySettings } from "@/components/settings/security-settings";
import { useApprovalCards } from "@/hooks/use-approval-cards";
import { WorkOverlayStatus } from "@/components/work-overlay-status";
import {
  emptySession,
  getActiveSessionId,
  loadSessions,
  setActiveSessionId,
  type StoredSession,
} from "@/lib/history";
import { SessionStore, attachWriteOnHide, snapshotFor } from "@/lib/session-store";
import { isOnboarded } from "@/lib/settings";
import { runStorageMigrations } from "@/lib/storage-migrations";

type View = "loading" | "onboarding" | "chat" | "history" | "providers";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [trimmed, setTrimmed] = useState<StoredSession[]>([]);
  const storeRef = useRef<SessionStore | null>(null);
  // Latest active session (incl. renames + recorded messages). `session` state
  // only changes on switch/rename, so leaving the chat view re-syncs it from here —
  // otherwise the remounted ChatPanel would re-seed (and re-record) a stale transcript.
  const sessionRef = useRef<StoredSession | null>(null);

  if (storeRef.current === null) {
    storeRef.current = new SessionStore({
      onTrimmed: (dropped) => setTrimmed((prev) => [...prev, ...dropped]),
    });
  }
  const store = storeRef.current;
  // Port channel: pending approval cards + agent status (plan §5.2 item 5).
  const agentChannel = useApprovalCards();

  // Write-on-hide: panel close lands any pending snapshot immediately (§5.3).
  useEffect(() => attachWriteOnHide(store), [store]);

  // First run → onboarding; otherwise the restored session below flips the view.
  useEffect(() => {
    void isOnboarded().then((onboarded) => {
      if (!onboarded) setView("onboarding");
    });
  }, []);

  // Restore the last active session on open; fall back to the newest, else fresh.
  // Storage migrations run first — the restore must read migrated data.
  useEffect(() => {
    void (async () => {
      try {
        await runStorageMigrations();
      } catch (error) {
        console.error("junior: storage migrations failed", error); // loader filters what it can't parse
      }
      const [sessions, activeId] = await Promise.all([loadSessions(), getActiveSessionId()]);
      const restored = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? emptySession();
      sessionRef.current = restored;
      setSession(restored);
      void setActiveSessionId(restored.id);
      setView((v) => (v === "loading" ? "chat" : v));
    })();
  }, []);

  const pointAt = useCallback((next: StoredSession) => {
    sessionRef.current = next;
    setSession(next);
    void setActiveSessionId(next.id);
  }, []);

  const listSessions = useCallback(() => store.list(), [store]);

  const leaveChat = useCallback((next: View) => {
    if (sessionRef.current !== null) setSession(sessionRef.current);
    setView(next);
  }, []);

  // ChatPanel calls this on every messages change; the store debounces the write.
  const handleRecord = useCallback(
    (messages: UIMessage[]) => {
      const base = sessionRef.current;
      const next = base === null ? null : snapshotFor(base, messages);
      if (next === null) return;
      sessionRef.current = next;
      store.record(next);
    },
    [store],
  );

  const handleRename = useCallback(
    (id: string, title: string) => {
      const base = sessionRef.current;
      if (base?.id === id) {
        const next = { ...base, title: title.trim() || base.title, renamed: true };
        sessionRef.current = next;
        setSession(next);
      }
      return store.rename(id, title);
    },
    [store],
  );

  // Deleting the active chat detaches it first, so nothing records into it again.
  const handleDelete = useCallback(
    (id: string) => {
      if (sessionRef.current?.id === id) pointAt(emptySession());
      return store.delete(id);
    },
    [store, pointAt],
  );

  if (view === "loading") {
    return <div className="h-screen bg-background" />;
  }
  if (view === "onboarding") {
    return <Onboarding onDone={() => setView("chat")} />;
  }
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <BridgeStatusBar />
      {view === "providers" ? (
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
          <ProvidersSettings onBack={() => setView("chat")} />
          <SecuritySettings />
        </div>
      ) : view === "history" && session !== null ? (
        <HistoryPanel
          activeId={session.id}
          trimmed={trimmed}
          onDismissTrimmed={() => setTrimmed([])}
          listSessions={listSessions}
          onOpen={(id) => {
            void listSessions().then((sessions) => {
              const picked = sessions.find((s) => s.id === id);
              if (picked !== undefined) pointAt(picked);
              setView("chat");
            });
          }}
          onRename={handleRename}
          onDelete={handleDelete}
          onNew={() => {
            pointAt(emptySession());
            setView("chat");
          }}
          onBack={() => setView("chat")}
        />
      ) : session !== null ? (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <WorkOverlayStatus status={agentChannel.status} />
            <div className="flex gap-2">
              <button
                type="button"
                aria-label="Open History"
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => leaveChat("history")}
              >
                History
              </button>
              <button
                type="button"
                aria-label="Open Settings"
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => leaveChat("providers")}
              >
                Settings
              </button>
            </div>
          </div>
          <ChatPanel session={session} onRecord={handleRecord} />
        </div>
      ) : null}
      {/* Approval cards ride at the bottom over any view (§5.3 bottom-sheet). */}
      <ApprovalCardStack cards={agentChannel.cards} respond={agentChannel.respond} />
    </div>
  );
}
