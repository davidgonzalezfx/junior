// @junior/bridge/config — ~/.junior/config.json + token + pairing window (plan §4.1).
// Port of modelbridge-clone/core/config.py (config dir + load/save) with Junior's fixes:
// schema-validated fail-fast (decisions.md 2026-10-23 — no silent except), JUNIOR_HOME
// override so tests never touch the real dir, atomic save, 0600 token file, and a
// pairing-window marker gating token-setting (ModelBridge never verified tokens at all).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JuniorConfigSchema, type JuniorConfig } from "@junior/protocol";

export const PAIRING_WINDOW_MS = 60_000; // plan §4.1: `junior-bridge pair` opens the window this long

/** `~/.junior`, overridable with JUNIOR_HOME (tests set it to a tmpdir; never the real dir). */
export function juniorDir(): string {
  return process.env.JUNIOR_HOME ?? join(homedir(), ".junior");
}

export class ConfigError extends Error {}

export function loadConfig(dir: string = juniorDir()): JuniorConfig {
  const path = join(dir, "config.json");
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new ConfigError(`${path}: malformed JSON (${String(cause)})`);
    }
  }
  const parsed = JuniorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`${path}: ${detail}`);
  }
  return parsed.data;
}

/** Atomic write (tmp + rename): a crash never leaves a truncated config (config.py wrote in place). */
export function saveConfig(config: JuniorConfig, dir: string = juniorDir()): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

// 32 random bytes hex — port of AutonoSecurity.generatePairingToken
// (autono-clone/Autono/lib/autono-security.js:38, verified M1-1).
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function tokenPath(dir: string): string {
  return join(dir, "token");
}

export function readToken(dir: string): string | null {
  try {
    return readFileSync(tokenPath(dir), "utf8").trim() || null;
  } catch {
    return null; // missing file = unset; mismatches are logged by the auth layer
  }
}

export function writeToken(token: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath(dir), `${token}\n`, { mode: 0o600 }); // §4.1: 0600
}

export function clearToken(dir: string): void {
  rmSync(tokenPath(dir), { force: true });
}

/**
 * Startup minting: keep an existing token, else generate one — unless a pairing window is
 * open, in which case the token stays unset and the extension's POST /api/pairing decides it.
 */
export function ensureToken(dir: string): string | null {
  const existing = readToken(dir);
  if (existing) return existing;
  if (pairingWindowOpen(dir)) return null;
  const token = generateToken();
  writeToken(token, dir);
  return token;
}

// The pairing window lives in a marker file so `junior-bridge pair` — a separate process —
// can open it for the already-running server without inventing an admin endpoint.
function windowPath(dir: string): string {
  return join(dir, "pairing-window.json");
}

export function openPairingWindow(dir: string, now: number = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(windowPath(dir), `${JSON.stringify({ expiresAt: now + PAIRING_WINDOW_MS })}\n`);
}

export function pairingWindowOpen(dir: string, now: number = Date.now()): boolean {
  try {
    const marker = JSON.parse(readFileSync(windowPath(dir), "utf8")) as { expiresAt?: unknown };
    if (typeof marker.expiresAt === "number" && marker.expiresAt > now) return true;
  } catch {
    // missing/malformed marker = closed
  }
  rmSync(windowPath(dir), { force: true }); // sweep expired/unreadable markers
  return false;
}

export function consumePairingWindow(dir: string): void {
  rmSync(windowPath(dir), { force: true });
}
