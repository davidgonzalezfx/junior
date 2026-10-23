// lib/executors/screenshot.ts — captureVisibleTab post-processing (plan §5.2 item 3:
// "downscale to max 1280px → JPEG q0.6 data URL"). The SW has no DOM Image, so the
// pipeline is createImageBitmap + OffscreenCanvas; `scaledDims` is the pure part
// tests can assert, the rest needs a real bitmap decoder (covered live in M3-5).
export const SCREENSHOT_MAX_EDGE = 1280;
export const SCREENSHOT_JPEG_QUALITY = 0.6;

export function scaledDims(
  width: number,
  height: number,
  maxEdge: number = SCREENSHOT_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Re-encode a capture data URL as a JPEG data URL whose longest edge ≤ maxEdge. */
export async function downscaleDataUrl(
  dataUrl: string,
  maxEdge: number = SCREENSHOT_MAX_EDGE,
): Promise<string> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is unavailable in this context");
  }
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const { width, height } = scaledDims(bmp.width, bmp.height, maxEdge);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bmp, 0, 0, width, height);
    const out = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: SCREENSHOT_JPEG_QUALITY,
    });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Screenshot re-encode failed"));
      reader.readAsDataURL(out);
    });
  } finally {
    bmp.close();
  }
}
