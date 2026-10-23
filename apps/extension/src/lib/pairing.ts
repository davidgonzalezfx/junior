// Extension-side pairing (plan §5.2 item 1 + §4.1): generate a 32-byte token if missing,
// then POST /api/pairing. The bridge accepts a POST while no token is set (first run) or
// while the `junior-bridge pair` window is open (re-pair); a mismatching stored token is a
// 403 the user resolves by running `junior-bridge pair` — never by us overwriting it.
import { PairingRequestSchema } from "@junior/protocol";
import { postPairing } from "@/lib/bridge-client";
import { BridgeHttpError, BridgeUnreachableError } from "@/lib/bridge-client";
import { getToken, loadSettings, setToken } from "@/lib/settings";

export function generateToken(): string {
  const bytes = new Uint8Array(32); // 64 hex chars — matches PairingRequestSchema
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Read the stored token, generating + persisting one on first run. */
export async function ensureToken(): Promise<string> {
  const existing = await getToken();
  if (existing !== null) return existing;
  const token = generateToken();
  await setToken(token);
  return token;
}

export type PairingOutcome =
  | { status: "paired"; alreadyPaired: boolean }
  | { status: "mismatch"; message: string } // bridge holds a different token → `junior-bridge pair`
  | { status: "unreachable" }; // bridge down → start it first

/**
 * Full pairing attempt against the configured bridge. Idempotent: an already-paired
 * extension gets `alreadyPaired: true` from the bridge (§4.1).
 */
export async function pairWithBridge(): Promise<PairingOutcome> {
  const { bridgeUrl } = await loadSettings();
  const token = await ensureToken();
  const parsed = PairingRequestSchema.safeParse({ token });
  if (!parsed.success) {
    // Can't happen with generateToken() — a tripwire, not a code path.
    return { status: "mismatch", message: "generated token failed the wire schema" };
  }
  try {
    const result = await postPairing(bridgeUrl, token);
    return { status: "paired", alreadyPaired: result.alreadyPaired };
  } catch (err) {
    if (err instanceof BridgeUnreachableError) return { status: "unreachable" };
    if (err instanceof BridgeHttpError && err.authFailed) {
      return { status: "mismatch", message: err.wireError ?? "token mismatch" };
    }
    throw err;
  }
}
