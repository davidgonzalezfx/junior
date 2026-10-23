// @junior/bridge/cli-detect — claude CLI availability for GET /api/status
// (plan §4.5 "CLI availability", §6.3 port table). Port of modelbridge-clone
// core/auth_status.py (check_claude + parse_claude_status + _run_capture) and
// core/config.py:49–71 find_claude_binary (PATH scan + WinGet/npm candidates).
// Detection only reads local state and never sends or logs tokens: `claude auth
// status` prints auth *metadata* (loggedIn, authMethod, email/org) — no credentials —
// and this module surfaces only that (verified against Claude Code 2.1.309, M1-3).
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** What /api/status reports for the claude-cli provider. */
export interface ClaudeCliStatus {
  found: boolean;
  path: string | null;
  version: string | null; // "2.1.309" from `claude --version`
  loggedIn: boolean;
  /** Email (OAuth) or org name from `claude auth status` — display only. */
  account: string | null;
  /** "api_key" | "claude_ai" | … — display only. */
  authMethod: string | null;
}

/** Claude Code session vars (M0-3 learning) — a spawn nested in this process must not
 * inherit the parent session's wiring, or the child behaves as a Claude Code subagent. */
const SPAWN_ENV_STRIP = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_SESSION_ATTENDED",
] as const;

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of SPAWN_ENV_STRIP) delete clean[key];
  return clean;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 12_000; // auth_status.py _run_capture timeout
const STDOUT_CAP = 64 * 1024; // both probes print a few hundred bytes; cap anyway

/** The two probes' shape — injected in tests so units never spawn a real `claude`. */
export type CliRun = (exe: string, args: string[]) => Promise<string | null>;

function spawnChild(
  exe: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; timeoutMs: number },
): ReturnType<typeof spawn> {
  const common = {
    env: sanitizeEnv(opts.env),
    windowsHide: true, // auth_status.py NO_WINDOW (CREATE_NO_WINDOW) equivalent
    timeout: opts.timeoutMs, // Node kills the child at the deadline → close, code null
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], // StdioOptions wants a mutable tuple
  };
  if (opts.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    // Node ≥ 18.20 refuses .cmd/.bat without a shell (EINVAL, CVE-2024-27980 fix).
    // args are constant literals; only the resolved exe path is interpolated, quoted.
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${exe}" ${args.join(" ")}`], {
      ...common,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(exe, args, common);
}

function defaultRun(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CliRun {
  return (exe, args) =>
    new Promise((resolve) => {
      const child = spawnChild(exe, args, {
        env,
        platform,
        timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      });
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (out.length < STDOUT_CAP) out += chunk.toString("utf8");
      });
      child.on("error", () => resolve(null)); // ENOENT, EACCES, spawn EINVAL…
      child.on("close", (code) => resolve(code === 0 ? out : null));
    });
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  account: string | null; // email (OAuth) or org name
  authMethod: string | null;
}

/** Port of auth_status.py parse_claude_status + the authMethod key (present in 2.1.x).
 * The CLI may print warnings before the JSON — scan to the outermost braces like the
 * Python original. Missing/false `loggedIn` and unparseable output all mean logged out. */
export function parseClaudeAuthStatus(raw: string): ClaudeAuthStatus {
  const loggedOut: ClaudeAuthStatus = { loggedIn: false, account: null, authMethod: null };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return loggedOut;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return loggedOut;
  }
  if (typeof data !== "object" || data === null) return loggedOut;
  const d = data as Record<string, unknown>;
  if (d.loggedIn !== true) return loggedOut;
  const account =
    [d.email, d.orgName].find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
  const authMethod = typeof d.authMethod === "string" ? d.authMethod : null;
  return { loggedIn: true, account, authMethod };
}

export interface ResolveClaudePathOptions {
  /** JuniorConfig.cliPath — explicit override, fail-loud (no PATH fallback). */
  override?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}

function scanPath(
  names: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      if (platform === "win32") return p; // X_OK is meaningless on Windows
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // on PATH but not executable — keep scanning
      }
    }
  }
  return null;
}

/** config.py:58–65 — %LOCALAPPDATA%/Microsoft/WinGet/Packages/…ClaudeCode…/claude.exe,
 * then the npm-roaming shims (config.py:66–67). */
function win32Candidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  try {
    const wingetDir = join(localAppData, "Microsoft", "WinGet", "Packages");
    for (const pkg of readdirSync(wingetDir)) {
      if (pkg.toUpperCase().includes("CLAUDECODE")) {
        candidates.push(join(wingetDir, pkg, "claude.exe"));
      }
    }
  } catch {
    // no WinGet packages dir
  }
  candidates.push(join(home, "AppData", "Roaming", "npm", "claude.cmd"));
  candidates.push(join(home, "AppData", "Roaming", "npm", "claude.exe"));
  return candidates;
}

export function resolveClaudePath(opts: ResolveClaudePathOptions): string | null {
  if (opts.override) {
    // Explicit config wins and is fail-loud: a bad cliPath reports not-found (the
    // route's detail names the path) instead of silently probing some other binary.
    if (!existsSync(opts.override)) return null;
    if (opts.platform !== "win32") {
      try {
        accessSync(opts.override, constants.X_OK);
      } catch {
        return null;
      }
    }
    return opts.override;
  }
  if (opts.platform === "win32") {
    // shutil.which("claude") || which("claude.cmd") || which("claude.exe"), then
    // WinGet/npm candidates (config.py find_claude_binary:49–71).
    const onPath = scanPath(["claude.cmd", "claude.exe", "claude"], opts.env, opts.platform);
    if (onPath) return onPath;
    return win32Candidates(opts.env, opts.home).find((p) => existsSync(p)) ?? null;
  }
  // POSIX installs (npm -g, native installer) land on PATH; ModelBridge's macos.find_bin
  // hunts .app bundles, which the claude CLI is not — no extra candidates needed.
  return scanPath(["claude"], opts.env, opts.platform);
}

export interface ProbeClaudeOptions {
  overridePath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  run?: CliRun;
}

/** auth_status.py check_claude + the version probe (plan §3 example detail:
 * "claude version 2.x — logged in"). Both probes run concurrently; a failed/unparseable
 * `auth status` means not-logged-in, a failed `--version` just hides the version. */
export async function probeClaude(opts: ProbeClaudeOptions = {}): Promise<ClaudeCliStatus> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultRun(env, platform);
  const path = resolveClaudePath({ override: opts.overridePath, env, platform, home });
  if (!path) {
    return {
      found: false,
      path: null,
      version: null,
      loggedIn: false,
      account: null,
      authMethod: null,
    };
  }
  const [versionRaw, authRaw] = await Promise.all([
    run(path, ["--version"]),
    run(path, ["auth", "status"]),
  ]);
  const version = versionRaw?.trim().split(/\s+/)[0] ?? null;
  const auth = parseClaudeAuthStatus(authRaw ?? "");
  return {
    found: true,
    path,
    version,
    loggedIn: auth.loggedIn,
    account: auth.account,
    authMethod: auth.authMethod,
  };
}

/** ProviderStatus.detail (plan §3: e.g. "claude version 2.x — logged in"). */
export function cliDetail(cli: ClaudeCliStatus): string | undefined {
  if (!cli.found) return undefined;
  const base = cli.version ? `claude ${cli.version}` : "claude";
  let detail: string;
  if (cli.loggedIn) {
    const who = cli.account ?? cli.authMethod;
    detail = who ? `${base} — logged in (${who})` : `${base} — logged in`;
  } else if (cli.version) {
    detail = `${base} — not logged in`;
  } else {
    detail = "claude — installed, auth status unreadable";
  }
  return detail.slice(0, 200); // ProviderStatusSchema.detail max
}
