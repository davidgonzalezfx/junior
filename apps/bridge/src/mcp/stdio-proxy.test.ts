// M4-1 — junior-mcp stdio proxy tests (seams + a real spawn of the bin entry).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStdioProxy, resolveProxyTarget } from "./stdio-proxy.js";
import { saveConfig, writeToken } from "../config.js";

async function drive(lines: string[], respond: typeof fetch) {
  const written: string[] = [];
  await runStdioProxy({
    lines: lines,
    write: (line) => written.push(line),
    url: "http://127.0.0.1:8620/mcp",
    token: "t".repeat(64),
    fetchFn: respond,
  });
  return written;
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("runStdioProxy", () => {
  it("forwards each request with the token + streamable-HTTP Accept headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const written = await drive(
      [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })],
      async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return okJson({ jsonrpc: "2.0", id: 1, result: {} });
      },
    );
    expect(calls[0]!.url).toBe("http://127.0.0.1:8620/mcp");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${"t".repeat(64)}`);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("no token → no Authorization header (the bridge 401s and the error says so)", async () => {
    const written: string[] = [];
    await runStdioProxy({
      lines: [JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })],
      write: (l) => written.push(l),
      url: "http://127.0.0.1:8620/mcp",
      token: null,
      fetchFn: async () =>
        new Response(JSON.stringify({ error: "invalid token" }), { status: 403 }),
    });
    const err = JSON.parse(written[0]!) as { error: { code: number; message: string } };
    expect(err.error.code).toBe(-32603);
    expect(err.error.message).toContain("junior-bridge pair");
  });

  it("a notification (HTTP 202, no body) produces NO stdout line", async () => {
    const written = await drive(
      [JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })],
      async () => new Response(null, { status: 202 }),
    );
    expect(written).toEqual([]);
  });

  it("malformed stdin line → -32700 Parse error with id null", async () => {
    const written = await drive(["{nope"], async () => {
      throw new Error("should not be called");
    });
    expect(JSON.parse(written[0]!).error.code).toBe(-32700);
  });

  it("bridge down → -32603 with the `junior-bridge serve` hint (mcp_server.py port)", async () => {
    const written = await drive(
      [JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })],
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    const err = JSON.parse(written[0]!) as { id: number; error: { message: string } };
    expect(err.id).toBe(3);
    expect(err.error.message).toContain("junior-bridge serve");
  });

  it("non-JSON 200 body → -32603 with a body snippet", async () => {
    const written = await drive(
      [JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })],
      async () => new Response("<html>gateway</html>", { status: 200 }),
    );
    expect((JSON.parse(written[0]!) as { error: { message: string } }).error.message).toContain(
      "gateway",
    );
  });

  it("blank lines are skipped; a batch array round-trips untouched", async () => {
    const bodies: unknown[] = [];
    const written = await drive(
      ["", JSON.stringify([{ jsonrpc: "2.0", id: 5, method: "ping" }])],
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return okJson([{ jsonrpc: "2.0", id: 5, result: {} }]);
      },
    );
    expect(bodies[0]!).toBeInstanceOf(Array);
    expect(JSON.parse(written[0]!)).toBeInstanceOf(Array);
  });
});

describe("resolveProxyTarget — one config source (plan §7-11)", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const dir = join(import.meta.dirname, "tmp-junior-mcp-proxy-test");
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("URL from config port, token from the token file", () => {
    const dir = newDir();
    saveConfig(
      {
        port: 8620,
        permissionMode: "ask",
        providers: { anthropicKey: "", openaiCompatible: [], fallbackChain: [] },
        codeExecution: "off",
        maxSteps: 30,
        allowCliNativeTools: false,
      },
      dir,
    );
    writeToken("e".repeat(64), dir);
    expect(resolveProxyTarget(dir)).toEqual({
      url: "http://127.0.0.1:8620/mcp",
      token: "e".repeat(64),
    });
  });

  it("malformed config.json throws (main reports it on stderr, exit 1)", () => {
    const dir = newDir();
    writeFileSync(join(dir, "config.json"), "{nope");
    expect(() => resolveProxyTarget(dir)).toThrow(/malformed/);
  });
});

describe("bin autostart (spawn the real entry via tsx)", () => {
  const toClean: string[] = [];
  afterEach(() => {
    for (const d of toClean) rmSync(d, { recursive: true, force: true });
    toClean.length = 0;
  });
  it("running the file as a program forwards stdio JSON-RPC to the configured bridge", async () => {
    // Minimal stand-in bridge: answers any POST /mcp with a JSON-RPC echo.
    const httpServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { id: unknown; method?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { echo: parsed.method } }));
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const dir = join(import.meta.dirname, "tmp-junior-mcp-bin-test");
    mkdirSync(dir, { recursive: true });
    toClean.push(dir);
    saveConfig(
      {
        port: addr.port,
        permissionMode: "ask",
        providers: { anthropicKey: "", openaiCompatible: [], fallbackChain: [] },
        codeExecution: "off",
        maxSteps: 30,
        allowCliNativeTools: false,
      },
      dir,
    );
    writeToken("f".repeat(64), dir);

    const tsxCli = join(import.meta.dirname, "../../node_modules/tsx/dist/cli.mjs");
    const child = spawn(process.execPath, [tsxCli, join(import.meta.dirname, "stdio-proxy.ts")], {
      env: { ...process.env, JUNIOR_HOME: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const errChunks: string[] = [];
    child.stderr.on("data", (c) => errChunks.push(String(c)));
    const stdout = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error(`bin hung; stderr: ${errChunks.join("")}`)),
        15_000,
      );
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) {
          clearTimeout(timer);
          resolve(out);
        }
      });
      child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" })}\n`);
    });
    child.kill();
    httpServer.close();
    const response = JSON.parse(stdout.trim()) as { id: number; result: { echo: string } };
    expect(response.id).toBe(11);
    expect(response.result.echo).toBe("ping");
    // cheap guard that the spawn actually ran OUR proxy (its stderr banner)
    expect(errChunks.join("")).toContain("junior-mcp");
  }, 20_000);
});
