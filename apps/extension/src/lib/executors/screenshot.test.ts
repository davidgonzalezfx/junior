// T7: the extension CSP (connect-src 'self' http://127.0.0.1:8620) blocks fetch() of the
// capture's data: URL in the real SW — Chrome surfaces it as TypeError "Failed to fetch".
// jsdom enforces no CSP, so fetch is stubbed to fail the same way; the decoder and canvas
// are stubbed because jsdom has neither (the real pixels are covered live).
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downscaleDataUrl, SCREENSHOT_JPEG_QUALITY } from "./screenshot";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const JPEG_OUT = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function bytesOf(blob: Blob): Promise<number[]> {
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
  return [...new Uint8Array(buf)];
}

let decoded: Blob[];
let canvases: { width: number; height: number; drawn: unknown[]; opts?: unknown }[];

beforeEach(() => {
  decoded = [];
  canvases = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn((blob: Blob) => {
      decoded.push(blob);
      return Promise.resolve({ width: 2560, height: 1440, close: vi.fn() });
    }),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      rec: (typeof canvases)[number];
      constructor(width: number, height: number) {
        this.rec = { width, height, drawn: [] };
        canvases.push(this.rec);
      }
      getContext() {
        return { drawImage: (...a: unknown[]) => this.rec.drawn.push(a) };
      }
      convertToBlob(opts: unknown) {
        this.rec.opts = opts;
        return Promise.resolve(new Blob([JPEG_OUT], { type: "image/jpeg" }));
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downscaleDataUrl (T7: CSP-safe decode)", () => {
  it("never calls fetch and decodes the base64 payload into a typed blob", async () => {
    const out = await downscaleDataUrl(`data:image/png;base64,${toBase64(PNG_BYTES)}`);

    expect(fetch).not.toHaveBeenCalled();
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.type).toBe("image/png");
    expect(await bytesOf(decoded[0]!)).toEqual([...PNG_BYTES]);
    expect(out).toBe(`data:image/jpeg;base64,${toBase64(JPEG_OUT)}`);
  });

  it("keeps the downscale + JPEG re-encode behavior", async () => {
    await downscaleDataUrl(`data:image/jpeg;base64,${toBase64(PNG_BYTES)}`);

    expect(decoded[0]!.type).toBe("image/jpeg");
    expect(canvases).toEqual([
      {
        width: 1280,
        height: 720,
        drawn: [[expect.anything(), 0, 0, 1280, 720]],
        opts: { type: "image/jpeg", quality: SCREENSHOT_JPEG_QUALITY },
      },
    ]);
  });

  it("rejects a non-base64 data URL with a clear error", async () => {
    await expect(downscaleDataUrl("data:image/png,raw")).rejects.toThrow(/base64/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
