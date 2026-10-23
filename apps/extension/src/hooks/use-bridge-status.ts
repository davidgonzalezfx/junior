// useBridgeStatus — /api/health poll for the status bar (plan §5.3): green/red dot +
// "Start bridge" hint, fixing Autono's silent-failure UX. Healthy → every 5 s; failing →
// exponential backoff (1 s → 30 s, §5.2 cadence) so a downed bridge isn't hammered.
import { useEffect, useState } from "react";
import { HEALTHY_POLL_MS, fetchHealth, nextDelayMs } from "@/lib/bridge-client";
import { loadSettings } from "@/lib/settings";

export interface BridgeStatusState {
  /** null until the first poll lands — the bar renders "checking…" instead of lying red. */
  online: boolean | null;
  /** Force an immediate poll (e.g. after pairing or following the "check again" button). */
  recheck: () => void;
}

export function useBridgeStatus(): BridgeStatusState {
  const [online, setOnline] = useState<boolean | null>(null);
  const [pollNonce, setPollNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const poll = async () => {
      const { bridgeUrl } = await loadSettings();
      try {
        const ok = await fetchHealth(bridgeUrl);
        if (cancelled) return;
        setOnline(ok);
        failures = 0;
        timer = setTimeout(poll, HEALTHY_POLL_MS);
      } catch {
        if (cancelled) return;
        setOnline(false);
        timer = setTimeout(poll, nextDelayMs(failures++));
      }
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollNonce]);

  return { online, recheck: () => setPollNonce((n) => n + 1) };
}
