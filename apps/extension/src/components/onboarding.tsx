// Onboarding (plan §5.3, first run): 1) install the bridge, 2) pair (automatic),
// 3) pick a provider from /api/status. Skippable at every step — the status bar keeps
// nudging afterwards. Provider selection seeds `junior_default_provider`.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeStatus } from "@junior/protocol";
import { Button } from "@/components/ui/button";
import { CopyCommand } from "@/components/copy-command";
import { BridgeUnreachableError, fetchHealth, fetchStatus } from "@/lib/bridge-client";
import { ensureToken, pairWithBridge, type PairingOutcome } from "@/lib/pairing";
import { loadSettings, setDefaultProvider, setOnboarded } from "@/lib/settings";

const SERVE_COMMAND = "junior-bridge serve";
const PAIR_COMMAND = "junior-bridge pair";

const STEPS = ["bridge", "pair", "provider"] as const;
type Step = (typeof STEPS)[number];

/** Progress dots — where in the 3-step flow the user is. */
function StepDots({ current }: { current: Step }) {
  return (
    <ol
      aria-label={`Step ${STEPS.indexOf(current) + 1} of ${STEPS.length}`}
      className="flex items-center gap-1.5"
    >
      {STEPS.map((step) => (
        <li
          key={step}
          aria-current={step === current ? "step" : undefined}
          className={`h-1.5 w-6 rounded-full ${step === current ? "bg-primary" : "bg-muted"}`}
        />
      ))}
    </ol>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("bridge");

  const finish = useCallback(() => {
    void setOnboarded(true).then(onDone);
  }, [onDone]);

  return (
    <div className="flex h-screen flex-col gap-4 bg-background p-4 text-foreground">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Welcome to Junior</h1>
        <Button variant="ghost" size="sm" onClick={finish}>
          Skip for now
        </Button>
      </div>
      <StepDots current={step} />
      {step === "bridge" && (
        <BridgeStep onReady={() => setStep("pair")} onSkip={() => setStep("pair")} />
      )}
      {step === "pair" && <PairStep onPaired={() => setStep("provider")} onSkip={finish} />}
      {step === "provider" && <ProviderStep onDone={finish} onSkip={finish} />}
    </div>
  );
}

// --- step 1: bridge reachable ---------------------------------------------------

function BridgeStep({ onReady, onSkip }: { onReady: () => void; onSkip: () => void }) {
  const [checking, setChecking] = useState(false);
  const [down, setDown] = useState(false);
  // Auto-check on mount: if the bridge is already up, step 1 is silent.
  const autoChecked = useRef(false);

  const check = useCallback(async () => {
    setChecking(true);
    setDown(false);
    try {
      const { bridgeUrl } = await loadSettings();
      if (await fetchHealth(bridgeUrl)) onReady();
      else setDown(true);
    } catch {
      setDown(true);
    } finally {
      setChecking(false);
    }
  }, [onReady]);

  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    void check();
  }, [check]);

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Junior talks to a small local bridge. Install and start it in a terminal:
      </p>
      <CopyCommand command={SERVE_COMMAND} />
      {down && (
        <p className="text-sm text-destructive">
          Bridge not reachable on <code>127.0.0.1:8620</code>. Start it, then check again.
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : down ? "Check again" : "I started it — check"}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Later
        </Button>
      </div>
    </section>
  );
}

// --- step 2: pairing (automatic, mismatch is user-recoverable) -----------------

function PairStep({ onPaired, onSkip }: { onPaired: () => void; onSkip: () => void }) {
  const [outcome, setOutcome] = useState<PairingOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const pair = useCallback(async () => {
    setBusy(true);
    try {
      const result = await pairWithBridge();
      setOutcome(result);
      if (result.status === "paired") onPaired();
    } finally {
      setBusy(false);
    }
  }, [onPaired]);

  useEffect(() => {
    void pair();
  }, [pair]);

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {busy ? "Pairing with the bridge…" : outcome?.status === "paired" ? "Paired." : "Pairing…"}
      </p>
      {outcome?.status === "mismatch" && (
        <>
          <p className="text-sm text-destructive">
            The bridge already has a different token. Run this, then retry (60 s window):
          </p>
          <CopyCommand command={PAIR_COMMAND} />
          <Button className="w-fit" onClick={() => void pair()} disabled={busy}>
            Retry pairing
          </Button>
        </>
      )}
      {outcome?.status === "unreachable" && (
        <p className="text-sm text-destructive">
          Bridge not reachable — start it first, then retry pairing.
        </p>
      )}
      <Button variant="ghost" className="w-fit" onClick={onSkip}>
        {outcome?.status === "unreachable" ? "Pair later" : "Skip"}
      </Button>
    </section>
  );
}

// --- step 3: provider pick (read-only seed for the ⌘K picker) ----------------

function ProviderStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { bridgeUrl } = await loadSettings();
        const fetched = await fetchStatus(bridgeUrl, await ensureToken());
        if (!cancelled) setStatus(fetched);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof BridgeUnreachableError
              ? "Bridge went away — you can pick a provider later in Settings."
              : "Could not load providers — you can pick one later in Settings.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = (providerId: string) => {
    setChosen(providerId);
    void setDefaultProvider({ providerId, model: null });
    onDone();
  };

  const available = status?.providers.filter((p) => p.available) ?? [];

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Pick a default provider (changeable anytime):</p>
      {available.map((p) => (
        <Button
          key={p.id}
          variant={chosen === p.id ? "default" : "outline"}
          className="justify-start"
          onClick={() => choose(p.id)}
        >
          {p.label}
          {p.detail ? <span className="ml-2 text-xs opacity-70">{p.detail}</span> : null}
        </Button>
      ))}
      {status !== null && available.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No provider available yet — add an API key in Settings later.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button variant="ghost" className="w-fit" onClick={onSkip}>
        Skip
      </Button>
    </section>
  );
}
