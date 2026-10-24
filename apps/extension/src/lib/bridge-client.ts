// HTTP client for the local bridge (plan §5.2/§5.3). Thin on purpose: every call goes
// through `bridgeFetch`, which classifies failures into unreachable vs HTTP-error so the
// UI (onboarding, status bar) can say "start the bridge" vs "re-pair" instead of a raw
// fetch stack trace. Backoff helpers are pure and unit-tested.
import {
  BridgeStatusSchema,
  PairingResultSchema,
  PairingStatusSchema,
  ProvidersPatchSchema,
  ProvidersViewSchema,
  ProviderTestResultSchema,
  QueueItemSchema,
  type ActionResult,
  type ApprovalDecision,
  type BridgeStatus,
  type PairingResult,
  type PairingStatus,
  type ProvidersPatch,
  type ProvidersView,
  type QueueItem,
} from "@junior/protocol";

/** The bridge is down (fetch threw) — no HTTP status exists. */
export class BridgeUnreachableError extends Error {
  constructor(cause: unknown) {
    super("bridge unreachable — is `junior-bridge serve` running?", { cause });
    this.name = "BridgeUnreachableError";
  }
}

/** The bridge answered with a non-2xx status (401/403 → re-pair, 500 → bug). */
export class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly wireError: string | null,
  ) {
    super(`bridge responded ${status}${wireError ? `: ${wireError}` : ""}`);
    this.name = "BridgeHttpError";
  }

  /** 401/403 mean the stored token is wrong or missing — the only recoverable case. */
  get authFailed(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  token?: string;
  body?: unknown;
}

async function bridgeFetch<T>(
  baseUrl: string,
  path: string,
  parse: (raw: unknown) => T,
  opts: RequestOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    throw new BridgeUnreachableError(cause);
  }
  if (!res.ok) {
    const wire = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new BridgeHttpError(res.status, typeof wire?.error === "string" ? wire.error : null);
  }
  return parse(await res.json());
}

/** GET /api/health — liveness only (§3 HTTP table). Returns the wire `ok` flag. */
export async function fetchHealth(baseUrl: string): Promise<boolean> {
  const body = await bridgeFetch(baseUrl, "/api/health", (raw) => raw as { ok: boolean });
  return body.ok === true;
}

/** GET /api/pairing — unauthenticated onboarding probe (§4.1). */
export async function fetchPairingStatus(baseUrl: string): Promise<PairingStatus> {
  return bridgeFetch(baseUrl, "/api/pairing", (raw) => PairingStatusSchema.parse(raw));
}

/** POST /api/pairing — register our token; 403 when the bridge holds a different one. */
export async function postPairing(baseUrl: string, token: string): Promise<PairingResult> {
  return bridgeFetch(baseUrl, "/api/pairing", (raw) => PairingResultSchema.parse(raw), {
    method: "POST",
    body: { token },
  });
}

/** GET /api/status — bridge facts + providers (drives onboarding step 3; M2-4 picker). */
export async function fetchStatus(baseUrl: string, token: string): Promise<BridgeStatus> {
  return bridgeFetch(baseUrl, "/api/status", (raw) => BridgeStatusSchema.parse(raw), { token });
}

// --- Settings → Providers (M2-4, plan §5.3) -----------------------------------

/** GET /api/config — masked providers view (keys never come back over the wire). */
export async function fetchProvidersView(baseUrl: string, token: string): Promise<ProvidersView> {
  return bridgeFetch(baseUrl, "/api/config", (raw) => ProvidersViewSchema.parse(raw), { token });
}

/** PUT /api/config — full providers-block patch; absent keys keep what the bridge has. */
export async function putProviders(
  baseUrl: string,
  token: string,
  providers: ProvidersPatch["providers"],
): Promise<void> {
  // The body is the patch we were given — parse it client-side so typos fail at the
  // caller with a real message instead of a 400 round-trip.
  const patch = ProvidersPatchSchema.parse({ providers });
  await bridgeFetch(baseUrl, "/api/config", (raw) => raw as { ok: boolean }, {
    method: "PUT",
    token,
    body: patch,
  });
}

/** POST /api/config/test — the Settings "test"/"fetch models" button. */
export async function testProvider(
  baseUrl: string,
  token: string,
  providerId: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  return bridgeFetch(baseUrl, "/api/config/test", (raw) => ProviderTestResultSchema.parse(raw), {
    method: "POST",
    token,
    body: { providerId },
  });
}

// --- Agent loop (M3-3, plan §5.2 item 2) ---------------------------------------

/** GET /api/agent/next-action — the SW long-poll. Idle answers come back as
 * `{item: null}`, which is NOT a QueueItem (zod discriminated unions reject it,
 * M1-2 learning) — distinguish the two shapes before parsing. */
export async function fetchNextAction(
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<QueueItem | null> {
  return bridgeFetch(
    baseUrl,
    `/api/agent/next-action?timeout=${Math.ceil(timeoutMs / 1000)}`,
    (raw) => {
      if (typeof raw === "object" && raw !== null && "item" in raw) {
        return raw.item === null ? null : QueueItemSchema.parse(raw.item);
      }
      return QueueItemSchema.parse(raw);
    },
    { token },
  );
}

/** POST /api/agent/action-result — resolves the bridge future the agent awaits. */
export async function postActionResult(
  baseUrl: string,
  token: string,
  result: ActionResult,
): Promise<void> {
  await bridgeFetch(baseUrl, "/api/agent/action-result", (raw) => raw as { delivered: boolean }, {
    method: "POST",
    token,
    body: result,
  });
}

/** POST /api/agent/approval-response — answers a card; false when already resolved
 * (e.g. the bridge timed the approval out first). */
export async function postApprovalDecision(
  baseUrl: string,
  token: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  const wire = await bridgeFetch(
    baseUrl,
    "/api/agent/approval-response",
    (raw) => raw as { delivered: boolean },
    { method: "POST", token, body: decision },
  );
  return wire.delivered === true;
}

/**
 * Exponential backoff for poll loops (plan §5.2: 1 s → 30 s, jitter). Attempt 0 = first
 * failure. Pure so tests can pin the sequence; jitter (≤ 250 ms) keeps extension
 * restart-storms from synchronizing on the bridge.
 */
export function nextDelayMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  return exp + Math.floor(Math.random() * 250);
}

/** Healthy-state poll cadence for the status bar (plan §5.3: every 5 s). */
export const HEALTHY_POLL_MS = 5000;
