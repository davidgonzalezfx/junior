import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearToken,
  ConfigError,
  consumePairingWindow,
  ensureToken,
  generateToken,
  loadConfig,
  openPairingWindow,
  PAIRING_WINDOW_MS,
  pairingWindowOpen,
  readToken,
  saveConfig,
  writeToken,
} from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "junior-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config load/save (plan §4.1, port of core/config.py)", () => {
  it("defaults when config.json is missing (ModelBridge's load() shape, validated)", () => {
    expect(loadConfig(dir)).toEqual({
      port: 8620,
      permissionMode: "ask",
      providers: { openaiCompatible: [], fallbackChain: [] },
      codeExecution: "off",
      maxSteps: 30,
      allowCliNativeTools: false,
    });
  });

  it("fails fast with path+message on malformed or schema-invalid files", () => {
    writeFileSync(join(dir, "config.json"), "{not json");
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/config\.json/);

    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxSteps: 1000 }));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/maxSteps/);
  });

  it("save → load round-trips atomically (no tmp leftovers)", () => {
    saveConfig({ ...loadConfig(dir), maxSteps: 50 }, dir);
    expect(loadConfig(dir).maxSteps).toBe(50);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain('"port": 8620');
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toMatch(/\.tmp/);
  });
});

describe("token (plan §4.1 — port of AutonoSecurity.generatePairingToken)", () => {
  it("generates 32 bytes hex and reads/writes/clears 0600", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    writeToken(token, dir);
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(readToken(dir)).toBe(token);
    clearToken(dir);
    expect(readToken(dir)).toBeNull();
    clearToken(dir); // idempotent
    expect(readToken(dir)).toBeNull();
  });

  it("ensureToken mints once and keeps the minted token on restart", () => {
    const first = ensureToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(dir)).toBe(first);
  });

  it("ensureToken stays hands-off while a pairing window is open", () => {
    openPairingWindow(dir);
    expect(ensureToken(dir)).toBeNull();
    expect(readToken(dir)).toBeNull();
  });
});

describe("pairing window (plan §4.1 — `junior-bridge pair`)", () => {
  it("is closed when no marker exists", () => {
    expect(pairingWindowOpen(dir)).toBe(false);
  });

  it("opens for 60 s, expires at the deadline, and is consumed by a successful pairing", () => {
    const t0 = 1_760_000_000_000;
    openPairingWindow(dir, t0);
    expect(pairingWindowOpen(dir, t0 + PAIRING_WINDOW_MS - 1)).toBe(true);
    expect(pairingWindowOpen(dir, t0 + PAIRING_WINDOW_MS)).toBe(false); // expired → swept

    openPairingWindow(dir, t0);
    consumePairingWindow(dir);
    expect(pairingWindowOpen(dir, t0 + 1)).toBe(false);
  });

  it("treats a malformed marker as closed", () => {
    writeFileSync(join(dir, "pairing-window.json"), "garbage");
    expect(pairingWindowOpen(dir)).toBe(false);
  });
});
