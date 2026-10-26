// History view (plan §5.3): sessions list over `junior_sessions`, text search,
// inline rename, delete, markdown export + the trim notice ("beyond 200 sessions
// with export prompt"). Reads and mutations go through App's SessionStore (the
// single writer); each resolves with the fresh list this view renders.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  downloadMarkdown,
  exportFilename,
  searchSessions,
  sessionToMarkdown,
  type StoredSession,
} from "@/lib/history";

interface HistoryPanelProps {
  activeId: string;
  /** Sessions dropped by the 200 cap, awaiting the export prompt (or dismissal). */
  trimmed: StoredSession[];
  onDismissTrimmed: () => void;
  listSessions: () => Promise<StoredSession[]>;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => Promise<StoredSession[]>;
  onDelete: (id: string) => Promise<StoredSession[]>;
  onNew: () => void;
  onBack: () => void;
}

function exportAll(sessions: StoredSession[]): void {
  const joined = sessions.map((s) => sessionToMarkdown(s)).join("\n\n---\n\n");
  const names = exportFilename({
    ...sessions[0]!,
    title: sessions.length === 1 ? sessions[0]!.title : "trimmed-sessions",
  });
  downloadMarkdown(names, joined);
}

export function HistoryPanel({
  activeId,
  trimmed,
  onDismissTrimmed,
  listSessions,
  onOpen,
  onRename,
  onDelete,
  onNew,
  onBack,
}: HistoryPanelProps) {
  const [sessions, setSessions] = useState<StoredSession[] | null>(null);
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    void listSessions().then(setSessions);
  }, [listSessions]);

  const commitRename = (id: string) => {
    setRenamingId(null);
    void onRename(id, renameDraft).then(setSessions);
  };

  const filtered = searchSessions(sessions ?? [], query);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <h2 className="text-sm font-medium">History</h2>
        <Button className="ml-auto" size="sm" onClick={onNew}>
          New chat
        </Button>
      </div>

      <input
        aria-label="Search history"
        className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        placeholder="Search conversations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {trimmed.length > 0 ? (
        <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            {trimmed.length} old conversation{trimmed.length === 1 ? "" : "s"} trimmed (200 cap).
          </span>
          <button
            type="button"
            className="font-medium underline hover:text-foreground"
            onClick={() => exportAll(trimmed)}
          >
            Export
          </button>
          <button
            type="button"
            aria-label="Dismiss trim notice"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={onDismissTrimmed}
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {sessions === null ? null : filtered.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">
            {query.trim().length > 0 ? "No conversations match." : "No conversations yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((s) => (
              <li
                key={s.id}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm ${
                  s.id === activeId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                }`}
              >
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    aria-label={`Rename conversation (${s.title})`}
                    className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(s.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={s.title}
                    className="min-w-0 flex-1 truncate text-left"
                    title={s.title}
                    onClick={() => onOpen(s.id)}
                  >
                    {s.title}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {new Date(s.updatedAt).toLocaleString()}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Export ${s.title}`}
                  title="Export as markdown"
                  className="rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onClick={() => downloadMarkdown(exportFilename(s), sessionToMarkdown(s))}
                >
                  ⤓
                </button>
                <button
                  type="button"
                  aria-label={`Rename ${s.title}`}
                  title="Rename"
                  className="rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setRenamingId(s.id);
                    setRenameDraft(s.title);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${s.title}`}
                  title="Delete"
                  className="rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-destructive"
                  onClick={() => void onDelete(s.id).then(setSessions)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
