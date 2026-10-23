// cli-detect unit tests — the auth_status.py / config.py:49–71 port. No real
// subprocess here: `run` is injected and PATH fixtures are tmpdirs. The live probe
// against the installed CLI happens in the M1-3 acceptance run (see progress.md).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliDetail,
  parseClaudeAuthStatus,
  probeClaude,
  resolveClaudePath,
  sanitizeEnv,
  type ClaudeCliStatus,
  type CliRun,
} from "./cli-detect.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "junior-cli-detect-"));
  dirs.push(d);
  return d;
}

function makeExecutable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

// Verbatim `claude auth status` output from Claude Code 2.1.309 (api-key login).
const AUTH_STATUS_2139 = `{
  "loggedIn": true,
  "authMethod": "api_key",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/home/node/.claude/projects",
  "configDirectory": "/home/node/.claude",
  "apiKeySource": "ANTHROPIC_API_KEY"
}`;

describe("parseClaudeAuthStatus", () => {
  it("parses the observed 2.1.309 api-key shape", () => {
    expect(parseClaudeAuthStatus(AUTH_STATUS_2139)).toEqual({
      loggedIn: true,
      account: null,
      authMethod: "api_key",
    });
  });

  it("prefers email over orgName (auth_status.py parity)", () => {
    const raw = JSON.stringify({ loggedIn: true, email: "a@b.c", orgName: "Acme" });
    expect(parseClaudeAuthStatus(raw)).toEqual({
      loggedIn: true,
      account: "a@b.c",
      authMethod: null,
    });
  });

  it("falls back to orgName when there is no email", () => {
    const raw = JSON.stringify({ loggedIn: true, orgName: "Acme" });
    expect(parseClaudeAuthStatus(raw).account).toBe("Acme");
  });

  it("parses through preamble noise — braces are scanned, not the whole stdout", () => {
    const raw = `claude: using config dir /home/x\nwarning: deprecated flag\n${AUTH_STATUS_2139}`;
    expect(parseClaudeAuthStatus(raw).loggedIn).toBe(true);
  });

  it("treats loggedIn:false, missing JSON, and garbage as logged out", () => {
    for (const raw of [
      JSON.stringify({ loggedIn: false }),
      "{}",
      "",
      "total nonsense",
      "not json { broken",
    ]) {
      expect(parseClaudeAuthStatus(raw)).toEqual({
        loggedIn: false,
        account: null,
        authMethod: null,
      });
    }
  });
});

describe("resolveClaudePath", () => {
  it("finds an executable `claude` on PATH (posix)", () => {
    const binDir = tmp();
    makeExecutable(join(binDir, "claude"));
    expect(
      resolveClaudePath({
        env: { PATH: `/nonexistent:${binDir}`, HOME: tmpdir() },
        platform: "linux",
        home: tmpdir(),
      }),
    ).toBe(join(binDir, "claude"));
  });

  it("skips PATH entries whose file is not executable", () => {
    const binDir = tmp();
    writeFileSync(join(binDir, "claude"), "not executable");
    expect(
      resolveClaudePath({ env: { PATH: binDir }, platform: "linux", home: tmpdir() }),
    ).toBeNull();
  });

  it("an explicit override wins and is fail-loud when missing", () => {
    const dir = tmp();
    const exe = join(dir, "my-claude");
    makeExecutable(exe);
    const base = { env: { PATH: "" }, platform: "linux" as const, home: dir };
    expect(resolveClaudePath({ ...base, override: exe })).toBe(exe);
    expect(resolveClaudePath({ ...base, override: join(dir, "nope") })).toBeNull();
  });

  it("win32: falls back to the WinGet package glob, then npm roaming", () => {
    const localAppData = tmp();
    const pkgDir = join(
      localAppData,
      "Microsoft",
      "WinGet",
      "Packages",
      "Anthropic.ClaudeCode_2.1.309_x64__1234",
    );
    makeExecutable(join(pkgDir, "claude.exe"));
    const win32 = {
      env: { PATH: "", LOCALAPPDATA: localAppData },
      platform: "win32" as const,
      home: tmpdir(),
    };
    expect(resolveClaudePath(win32)).toBe(join(pkgDir, "claude.exe"));
  });

  it("win32: finds the npm roaming shim without needing the exec bit", () => {
    const home = tmp();
    makeExecutable(join(home, "AppData", "Roaming", "npm", "claude.cmd"));
    expect(
      resolveClaudePath({ env: { PATH: "", LOCALAPPDATA: tmp() }, platform: "win32", home }),
    ).toBe(join(home, "AppData", "Roaming", "npm", "claude.cmd"));
  });

  it("returns null when nothing matches", () => {
    expect(resolveClaudePath({ env: { PATH: "" }, platform: "linux", home: tmpdir() })).toBeNull();
  });
});

describe("sanitizeEnv", () => {
  it("strips the parent session's Claude wiring, keeps the rest (M0-3)", () => {
    const clean = sanitizeEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PID: "42",
    });
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.CLAUDECODE).toBeUndefined();
    expect(clean.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(clean.CLAUDE_PID).toBeUndefined();
  });
});

function cannedRun(
  version: string | null,
  auth: string | null,
): { run: CliRun; calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  const run: CliRun = async (_exe, args) => {
    calls.push([_exe, args]);
    if (args[0] === "--version") return version;
    if (args[0] === "auth") return auth;
    return null;
  };
  return { run, calls };
}

const FULLY_LOGGED_IN: ClaudeCliStatus = {
  found: true,
  path: "/usr/local/bin/claude",
  version: "2.1.309",
  loggedIn: true,
  account: null,
  authMethod: "api_key",
};

describe("probeClaude", () => {
  it("runs --version and auth status and assembles the full status", async () => {
    const { run, calls } = cannedRun("2.1.309 (Claude Code)", AUTH_STATUS_2139);
    const binDir = tmp();
    makeExecutable(join(binDir, "claude"));
    const status = await probeClaude({
      env: { PATH: binDir },
      platform: "linux",
      home: tmpdir(),
      run,
    });
    expect(status).toEqual({
      found: true,
      path: join(binDir, "claude"),
      version: "2.1.309",
      loggedIn: true,
      account: null,
      authMethod: "api_key",
    });
    expect(calls.map(([, args]) => args[0])).toEqual(["--version", "auth"]);
  });

  it("passes the config cliPath override through to resolution", async () => {
    const { run } = cannedRun("2.1.309", AUTH_STATUS_2139);
    const dir = tmp();
    const exe = join(dir, "custom-claude");
    makeExecutable(exe);
    const status = await probeClaude({
      overridePath: exe,
      env: { PATH: "" },
      platform: "linux",
      home: dir,
      run,
    });
    expect(status.path).toBe(exe);
    expect(status.found).toBe(true);
  });

  it("a missing binary short-circuits without spawning anything", async () => {
    const { run, calls } = cannedRun("2.1.309", AUTH_STATUS_2139);
    const status = await probeClaude({ env: { PATH: "" }, platform: "linux", home: tmpdir(), run });
    expect(status).toEqual({
      found: false,
      path: null,
      version: null,
      loggedIn: false,
      account: null,
      authMethod: null,
    });
    expect(calls).toEqual([]);
  });

  it("failed probes degrade independently: version lost, auth kept (and vice versa)", async () => {
    const noVersion = await probeClaude({
      env: { PATH: "" },
      platform: "linux",
      home: tmpdir(),
      overridePath: "/bin/sh",
      run: cannedRun(null, AUTH_STATUS_2139).run,
    });
    expect(noVersion.version).toBeNull();
    expect(noVersion.loggedIn).toBe(true);

    const noAuth = await probeClaude({
      env: { PATH: "" },
      platform: "linux",
      home: tmpdir(),
      overridePath: "/bin/sh",
      run: cannedRun("2.1.309 (Claude Code)", "spawn failed").run,
    });
    expect(noAuth.version).toBe("2.1.309");
    expect(noAuth.loggedIn).toBe(false);
  });
});

describe("cliDetail", () => {
  it("formats logged-in / logged-out / degraded / missing per plan §3", () => {
    expect(cliDetail(FULLY_LOGGED_IN)).toBe("claude 2.1.309 — logged in (api_key)");
    expect(cliDetail({ ...FULLY_LOGGED_IN, account: "user@example.com", authMethod: null })).toBe(
      "claude 2.1.309 — logged in (user@example.com)",
    );
    expect(cliDetail({ ...FULLY_LOGGED_IN, loggedIn: false })).toBe(
      "claude 2.1.309 — not logged in",
    );
    expect(cliDetail({ ...FULLY_LOGGED_IN, version: null })).toBe("claude — logged in (api_key)");
    expect(cliDetail({ ...FULLY_LOGGED_IN, version: null, loggedIn: false })).toBe(
      "claude — installed, auth status unreadable",
    );
    expect(cliDetail({ ...FULLY_LOGGED_IN, found: false })).toBeUndefined();
  });

  it("never exceeds the schema's 200-char detail cap", () => {
    const long = cliDetail({ ...FULLY_LOGGED_IN, account: "x".repeat(500) });
    expect(long!.length).toBeLessThanOrEqual(200);
  });
});
