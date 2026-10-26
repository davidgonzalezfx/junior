// Settings → Providers (plan §5.3): Anthropic key, OpenAI-compatible CRUD with
// "fetch models", default fallback chain. Keys live in ~/.junior/config.json via the
// bridge (decisions.md 2026-10-23) — this UI holds a local draft and only PUTs a key
// the user actually typed (absent = keep what the bridge has; the GET never returns one).
import { useEffect, useState } from "react";
import {
  fetchProvidersView,
  testProvider,
  putProviders,
  BridgeHttpError,
  BridgeUnreachableError,
} from "@/lib/bridge-client";
import { validateBaseUrl } from "@/lib/picker";
import { getToken, loadSettings } from "@/lib/settings";
import { Button } from "@/components/ui/button";

interface EntryDraft {
  id: string;
  label: string;
  baseUrl: string;
  /** "" = leave the stored key alone; the input starts empty for every entry. */
  apiKey: string;
  hasKey: boolean;
  models: string[];
}

interface Draft {
  anthropicKey: string; // "" = unchanged
  hasAnthropicKey: boolean;
  entries: EntryDraft[];
  fallbackChain: string[];
}

function draftFromView(view: Awaited<ReturnType<typeof fetchProvidersView>>): Draft {
  return {
    anthropicKey: "",
    hasAnthropicKey: view.anthropicKeyMasked !== null,
    entries: view.openaiCompatible.map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      apiKey: "",
      hasKey: p.hasApiKey,
      models: p.models ?? [],
    })),
    fallbackChain: [...view.fallbackChain],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof BridgeUnreachableError || error instanceof BridgeHttpError)
    return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function ProvidersSettings({ onBack }: { onBack: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{
    kind: "idle" | "saving" | "saved" | "error";
    message?: string;
  }>({
    kind: "idle",
  });

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const settings = await loadSettings();
        const token = await getToken();
        if (token === null) throw new Error("not paired — reopen the panel to run onboarding");
        const view = await fetchProvidersView(settings.bridgeUrl, token);
        if (!stale) setDraft(draftFromView(view));
      } catch (error) {
        if (!stale) setLoadError(errorMessage(error));
      }
    })();
    return () => {
      stale = true;
    };
  }, []);

  const save = async () => {
    if (draft === null) return;
    setSaveState({ kind: "saving" });
    try {
      const settings = await loadSettings();
      const token = await getToken();
      if (token === null) throw new Error("not paired");
      await putProviders(settings.bridgeUrl, token, {
        ...(draft.anthropicKey !== "" ? { anthropicKey: draft.anthropicKey } : {}),
        openaiCompatible: draft.entries.map((e) => {
          const valid = validateBaseUrl(e.baseUrl);
          if (!valid.ok) throw new Error(`${e.label || e.id}: ${valid.error}`);
          return {
            id: e.id,
            label: e.label,
            baseUrl: valid.url.toString().replace(/\/$/, "") || e.baseUrl,
            ...(e.apiKey !== "" ? { apiKey: e.apiKey } : {}),
          };
        }),
        fallbackChain: draft.fallbackChain.filter((id) =>
          id === "anthropic" ? draft.hasAnthropicKey : draft.entries.some((e) => e.id === id),
        ),
      });
      // Re-pull the masked view so hasKey flags reflect what the bridge now holds.
      const view = await fetchProvidersView(settings.bridgeUrl, token);
      setDraft(draftFromView(view));
      setSaveState({ kind: "saved" });
    } catch (error) {
      setSaveState({ kind: "error", message: errorMessage(error) });
    }
  };

  if (loadError !== null) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-4">
        <Header onBack={onBack} />
        <p className="text-sm text-muted-foreground">{loadError}</p>
      </div>
    );
  }
  if (draft === null) return <div className="flex-1" />;

  const configuredIds = [
    ...(draft.hasAnthropicKey || draft.anthropicKey !== "" ? ["anthropic"] : []),
    ...draft.entries.map((e) => e.id),
  ];

  return (
    <div
      className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
      data-testid="providers-settings"
    >
      <Header onBack={onBack} />

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Anthropic</h3>
        <AnthropicSection draft={draft} setDraft={setDraft} />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">OpenAI-compatible</h3>
        {draft.entries.map((entry, index) => (
          <EntryEditor
            key={entry.id}
            entry={entry}
            onChange={(next) =>
              setDraft({ ...draft, entries: draft.entries.map((e, i) => (i === index ? next : e)) })
            }
            onRemove={() =>
              setDraft({ ...draft, entries: draft.entries.filter((_, i) => i !== index) })
            }
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            const id = `provider-${Date.now().toString(36)}`;
            setDraft({
              ...draft,
              entries: [
                ...draft.entries,
                { id, label: "", baseUrl: "", apiKey: "", hasKey: false, models: [] },
              ],
            });
          }}
        >
          + Add provider
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Fallback chain</h3>
        <p className="text-xs text-muted-foreground">
          When a provider fails before its first token, the next one is tried. Ordered; the selected
          model id is sent to every entry.
        </p>
        <FallbackChainEditor
          chain={draft.fallbackChain}
          configuredIds={configuredIds}
          onChange={(fallbackChain) => setDraft({ ...draft, fallbackChain })}
        />
      </section>

      <div className="sticky bottom-0 flex items-center gap-2 bg-background py-2">
        <Button size="sm" onClick={() => void save()} disabled={saveState.kind === "saving"}>
          {saveState.kind === "saving" ? "Saving…" : "Save"}
        </Button>
        {saveState.kind === "saved" ? (
          <span className="text-xs text-muted-foreground">Saved ✓</span>
        ) : null}
        {saveState.kind === "error" ? (
          <span role="alert" className="text-xs text-destructive">
            {saveState.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to chat">
        ← Back
      </Button>
      <h2 className="text-sm font-semibold">Settings — Providers</h2>
    </div>
  );
}

function AnthropicSection({ draft, setDraft }: { draft: Draft; setDraft: (next: Draft) => void }) {
  const [test, setTest] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground" htmlFor="anthropic-key">
        API key {draft.hasAnthropicKey ? "(stored — type to replace)" : "(not set)"}
      </label>
      <div className="flex items-center gap-2">
        <input
          id="anthropic-key"
          type="password"
          autoComplete="off"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          placeholder={draft.hasAnthropicKey ? "••••••••" : "sk-ant-…"}
          value={draft.anthropicKey}
          onChange={(e) => setDraft({ ...draft, anthropicKey: e.target.value })}
        />
        <TestButton
          providerId="anthropic"
          disabled={draft.anthropicKey === "" && !draft.hasAnthropicKey}
          onResult={setTest}
        />
        {draft.hasAnthropicKey ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                anthropicKey: "",
                hasAnthropicKey: false,
                fallbackChain: draft.fallbackChain.filter((id) => id !== "anthropic"),
              })
            }
          >
            Remove
          </Button>
        ) : null}
      </div>
      {test !== null ? <p className="text-xs text-muted-foreground">{test}</p> : null}
    </div>
  );
}

function EntryEditor({
  entry,
  onChange,
  onRemove,
}: {
  entry: EntryDraft;
  onChange: (next: EntryDraft) => void;
  onRemove: () => void;
}) {
  const [test, setTest] = useState<string | null>(null);
  const urlCheck = validateBaseUrl(entry.baseUrl);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="flex items-center gap-2">
        <input
          aria-label={`Label for ${entry.id}`}
          className="w-28 rounded-md border border-input bg-background px-2 py-1 text-xs"
          placeholder="Label"
          value={entry.label}
          onChange={(e) => onChange({ ...entry, label: e.target.value })}
        />
        <input
          aria-label={`Base URL for ${entry.id}`}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          placeholder="https://openrouter.ai/api/v1"
          value={entry.baseUrl}
          onChange={(e) => onChange({ ...entry, baseUrl: e.target.value })}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove ${entry.label || entry.id}`}
        >
          ✕
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          aria-label={`API key for ${entry.id}`}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          placeholder={entry.hasKey ? "•••••••• (stored)" : "API key"}
          value={entry.apiKey}
          onChange={(e) => onChange({ ...entry, apiKey: e.target.value })}
        />
        <TestButton providerId={entry.id} onResult={setTest} />
      </div>
      <div className="flex items-center gap-2 text-[10px]">
        {entry.baseUrl !== "" && !urlCheck.ok ? (
          <span className="text-destructive">{urlCheck.error}</span>
        ) : null}
        {entry.models.length > 0 ? (
          <span className="text-muted-foreground">{entry.models.length} models cached</span>
        ) : null}
        {test !== null ? <span className="text-muted-foreground">{test}</span> : null}
      </div>
    </div>
  );
}

function FallbackChainEditor({
  chain,
  configuredIds,
  onChange,
}: {
  chain: string[];
  configuredIds: string[];
  onChange: (next: string[]) => void;
}) {
  const addable = configuredIds.filter((id) => !chain.includes(id));
  const move = (index: number, delta: -1 | 1) => {
    const next = [...chain];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      {chain.map((id, i) => (
        <div key={`${id}:${i}`} className="flex items-center gap-1 text-xs">
          <span className="flex-1">
            {i + 1}. {id}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${id} up`}
            onClick={() => move(i, -1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${id} down`}
            onClick={() => move(i, 1)}
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${id} from chain`}
            onClick={() => onChange(chain.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
      {addable.length > 0 ? (
        <select
          aria-label="Add provider to fallback chain"
          className="self-start rounded-md border border-input bg-background px-2 py-1 text-xs"
          value=""
          onChange={(e) => {
            if (e.target.value !== "") onChange([...chain, e.target.value]);
          }}
        >
          <option value="">+ Add to chain…</option>
          {addable.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

/** "test" button (plan §5.3): asks the bridge to list models for one provider. */
function TestButton({
  providerId,
  disabled = false,
  onResult,
}: {
  providerId: string;
  disabled?: boolean;
  onResult: (line: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    onResult(null);
    try {
      const settings = await loadSettings();
      const token = await getToken();
      if (token === null) throw new Error("not paired");
      const result = await testProvider(settings.bridgeUrl, token, providerId);
      onResult(result.ok ? `${result.models.length} models ✓` : `failed: ${result.error}`);
    } catch (error) {
      onResult(`failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => void run()}>
      {busy ? "…" : "Test"}
    </Button>
  );
}
