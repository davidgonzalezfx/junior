// @junior/bridge/chat/fallback — provider-level fallback chain (plan §4.5).
// On a provider 4xx/5xx BEFORE the first token, retry the next candidate; after the
// first token, surface the error (no mid-stream provider switch). Mechanics: each
// candidate's UI message stream is probed — chunks are buffered until the first
// content chunk (text/reasoning/tool) vs an `error` chunk — and the winner's buffered
// chunks are replayed ahead of the live stream, so the wire shape the client sees is
// byte-identical to a single-provider stream.
import type { UIMessageChunk } from "ai";

/** All providers failed before the first token — the route turns this into a 502. */
export class AllProvidersFailedError extends Error {
  constructor(readonly failures: string[]) {
    super(`all providers failed before the first token — ${failures.join(" | ")}`);
    this.name = "AllProvidersFailedError";
  }
}

/** Pure ordering: the requested provider first, then chain entries that aren't it. */
export function buildCandidateChain(primary: string, chain: readonly string[]): string[] {
  return [primary, ...chain.filter((id) => id !== primary)];
}

/** Chunks that are stream bookkeeping — neither content nor failure. Anything outside
 * this set counts as content (safer against v7 chunk-type renames than enumerating). */
const LIFECYCLE_TYPES = new Set([
  "start",
  "start-step",
  "finish-step",
  "finish",
  "message-metadata",
]);

interface Probe {
  stream: ReadableStream<UIMessageChunk>;
  verdict: Promise<"ok" | "error" | "empty">;
  /** Release a losing candidate's source stream. */
  discard(): void;
}

/** Buffer chunks from `source` until the verdict is clear. The verdict settles on the
 * first content chunk (`ok`), the first `error` chunk (`error`), or stream end
 * (`empty` = provider answered with nothing — also retryable). */
export function probeUiStream(source: ReadableStream<UIMessageChunk>): Probe {
  const reader = source.getReader();
  const buffered: UIMessageChunk[] = [];
  let settle!: (v: "ok" | "error" | "empty") => void;
  const verdict = new Promise<"ok" | "error" | "empty">((res) => {
    settle = res;
  });

  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        settle("empty");
        return;
      }
      buffered.push(value);
      if (value.type === "error") {
        settle("error");
        return;
      }
      if (!LIFECYCLE_TYPES.has(value.type)) {
        settle("ok");
        return;
      }
    }
  })();

  return {
    verdict,
    discard() {
      void reader.cancel();
    },
    // Replays the buffered chunks (in order) before continuing live reads, so the
    // winner's `start`/`start-step` and first tokens all reach the client.
    stream: new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        const next = buffered.shift();
        if (next !== undefined) {
          controller.enqueue(next);
          return;
        }
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        void reader.cancel();
      },
    }),
  };
}

export type StreamAttempt = () => ReadableStream<UIMessageChunk>;

/** Try attempts in order; return the first stream that proves it can produce content.
 * A thunk that THROWS (e.g. resolveModel's UnknownProviderError for a stale chain
 * entry) counts as a failed attempt, not a route error. All fail ⇒ throw
 * AllProvidersFailedError — safe to turn into an HTTP error, nothing was sent. */
export async function firstSuccessfulStream(
  attempts: StreamAttempt[],
): Promise<ReadableStream<UIMessageChunk>> {
  const failures: string[] = [];
  for (const attempt of attempts) {
    let probe: Probe;
    try {
      probe = probeUiStream(attempt());
    } catch (error) {
      failures.push(errorText(error));
      continue;
    }
    const verdict = await probe.verdict;
    if (verdict === "ok") return probe.stream;
    probe.discard();
    failures.push(
      verdict === "error" ? "provider error before first token" : "provider returned no content",
    );
  }
  throw new AllProvidersFailedError(failures);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
