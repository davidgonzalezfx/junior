// @junior/protocol/pairing.ts — GET/POST /api/pairing bodies (plan §3 HTTP table + §4.1).
// GET is the unauthenticated onboarding probe; POST is the extension registering its token.
import { z } from "zod";

export const PairingStatusSchema = z.object({
  tokenRequired: z.boolean(), // always true in v1 (§4.2: everything but health/pairing needs a token)
  tokenSet: z.boolean(), // bridge already has a stored token (extension skips pairing if so)
});

export type PairingStatus = z.infer<typeof PairingStatusSchema>;

export const PairingRequestSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/), // 32 random bytes hex, the token to store (§4.1)
});

export type PairingRequest = z.infer<typeof PairingRequestSchema>;

export const PairingResultSchema = z.object({
  ok: z.literal(true),
  alreadyPaired: z.boolean(), // true when the presented token matched the stored one (idempotent retry)
});

export type PairingResult = z.infer<typeof PairingResultSchema>;
