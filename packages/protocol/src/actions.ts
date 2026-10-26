// @junior/protocol/actions.ts — browser action surface (plan §3).
// The extension is the only executor; the bridge is the only producer.
import { z } from "zod";

export const ReadMode = z.enum(["outline", "interactive", "text", "section"]);

/** An iframe as read_page names it: `f<frameId>` (T5a). */
export const FrameRef = z.string().regex(/^f\d{1,10}$/);

/** T5b media tool: read or control <video>/<audio> via the HTMLMediaElement API. */
export const MediaOp = z.enum(["state", "play", "pause", "seek", "mute", "unmute"]);

export const BrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().max(2048) }),
  z.object({ kind: z.literal("click"), target: z.string().max(512) }), // index / text / CSS / xpath
  z.object({
    kind: z.literal("type"),
    target: z.string().max(512),
    text: z.string().max(10000),
  }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().optional(),
    // T5a: scroll inside an iframe — the frame part of a read_page index ("f7").
    frame: FrameRef.optional(),
  }),
  z.object({
    kind: z.literal("read_page"),
    mode: ReadMode.default("outline"),
    selector: z.string().max(512).optional(), // for mode "section"
    maxChars: z.number().int().min(200).max(30000).default(8000),
  }),
  z.object({
    kind: z.literal("media"),
    op: MediaOp.default("state"),
    // "m0", "f7:m0", a CSS selector (optionally "f7:"-scoped), or omitted = the main video.
    target: z.string().max(512).optional(),
    time: z.number().min(0).max(604800).optional(), // seek: seconds from the start
  }),
  z.object({ kind: z.literal("screenshot") }),
  z.object({ kind: z.literal("get_active_tab") }),
]);

export type BrowserAction = z.infer<typeof BrowserActionSchema>;
