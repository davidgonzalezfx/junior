// Chat wiring for the side panel (plan §5.3): useChat → DefaultChatTransport →
// bridge POST /api/chat with the Bearer token and the api-engine body fields.
// M2-3 ships a minimal provider/model choice (stored default + fallbacks); M2-4's
// ⌘K picker replaces the target-resolution UI, not these pure helpers.
import { DefaultChatTransport, type UIMessage } from "ai";
import type { BridgeStatus, ChatMessageMetadata, ProviderStatus } from "@junior/protocol";
import type { DefaultProvider } from "./settings";

/** Assistant messages carry the engines' usage metadata (M5-1 usage chips, plan §5.3). */
export type JuniorUIMessage = UIMessage<ChatMessageMetadata>;

export interface ChatTarget {
  providerId: string;
  model: string;
}

/** Well-known stand-in until /api/status serves model catalogs (M2-4 fetches them). */
export const ANTHROPIC_FALLBACK_MODELS = [
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5-5",
];

/** Which models the UI can offer for a provider (status catalog, else the fallbacks). */
export function modelsFor(provider: ProviderStatus): string[] {
  if (provider.models.length > 0) return provider.models.map((m) => m.id);
  return provider.kind === "anthropic" ? ANTHROPIC_FALLBACK_MODELS : [];
}

/** Resolve what a plain chat sends to. Engine `api` only for M2-3, so claude-cli is
 * excluded (it would need the cli engine — 501 until M4-4). Null ⇒ the UI shows the
 * "no provider configured" state instead of a composer that can only fail. */
export function resolveChatTarget(
  defaultProvider: DefaultProvider | null,
  status: BridgeStatus,
): ChatTarget | null {
  const available = status.providers.filter((p) => p.available && p.kind !== "claude-cli");
  const preferred =
    defaultProvider === null
      ? undefined
      : available.find((p) => p.id === defaultProvider.providerId);
  const provider = preferred ?? available[0];
  if (provider === undefined) return null;

  const storedModel =
    defaultProvider !== null && defaultProvider.providerId === provider.id
      ? defaultProvider.model
      : null;
  const model = storedModel ?? modelsFor(provider)[0] ?? "";
  return { providerId: provider.id, model };
}

/** Transport per (bridgeUrl, token, target, agentMode) — useChat re-creates its
 * connection when the memo key changes, so switching model or agent mode
 * mid-conversation just retargets the next send (M4-3). */
export function createChatTransport(
  bridgeUrl: string,
  token: string,
  target: ChatTarget,
  agentMode = false,
): DefaultChatTransport<JuniorUIMessage> {
  return new DefaultChatTransport({
    api: `${bridgeUrl}/api/chat`,
    headers: { Authorization: `Bearer ${token}` },
    // Merged into DefaultChatTransport's body alongside `messages` (verified M0-4).
    // agentMode omitted when false — the protocol default covers it.
    body: {
      engine: "api",
      provider: target.providerId,
      model: target.model,
      ...(agentMode ? { agentMode: true } : {}),
    },
  });
}
