// M2-4 — Settings→Providers backend: mask/view purity, patch keep-existing semantics,
// and GET/PUT /api/config + POST /api/config/test over the real Hono app (plan §5.3).
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorConfigSchema, ProvidersViewSchema } from "@junior/protocol";
import { createApp } from "./index.js";
import { saveConfig, writeToken } from "./config.js";
import { applyProvidersPatch, maskKey, toProvidersView, withPersistedModels } from "./providers.js";

const TOKEN = "c".repeat(64);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function newDir(initial?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-providers-test-"));
  dirs.push(dir);
  saveConfig(JuniorConfigSchema.parse(initial ?? {}), dir);
  return dir;
}

function newApp(dir: string, test?: { fetchImpl?: typeof fetch; env?: typeof process.env }) {
  writeToken(TOKEN, dir);
  return createApp({ dir, log: () => {}, providers: { test } });
}

const auth = { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` };

describe("pure helpers", () => {
  it("maskKey shows only the last 4 characters (never the full key, plan §5.3)", () => {
    expect(maskKey("sk-ant-api1234567890abcd")).toBe("…abcd");
    expect(maskKey("short")).toBe("…");
    expect(maskKey("short")).not.toContain("short");
  });

  it("toProvidersView masks the anthropic key and strips entry keys", () => {
    const config = JuniorConfigSchema.parse({
      providers: {
        anthropicKey: "sk-ant-1234567890abcdef",
        openaiCompatible: [
          {
            id: "openrouter",
            label: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-or-1234567890",
          },
        ],
        fallbackChain: ["anthropic"],
      },
    });
    const view = toProvidersView(config);
    expect(view).toEqual({
      anthropicKeyMasked: "…cdef",
      openaiCompatible: [
        {
          id: "openrouter",
          label: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          hasApiKey: true,
        },
      ],
      fallbackChain: ["anthropic"],
    });
    expect(JSON.stringify(view)).not.toContain("sk-or-1234567890");
    expect(ProvidersViewSchema.parse(view)).toEqual(view);
  });

  it("applyProvidersPatch: absent keys keep existing, empty string clears, new entries start keyless", () => {
    const config = JuniorConfigSchema.parse({
      providers: {
        anthropicKey: "sk-keep-me",
        openaiCompatible: [
          { id: "openrouter", label: "Old", baseUrl: "https://old/v1", apiKey: "sk-existing" },
        ],
      },
    });
    const merged = applyProvidersPatch(config, {
      // anthropicKey absent → keep; openrouter relabeled without a key → key preserved;
      // new entry without a key → "" (unavailable until the user types one)
      openaiCompatible: [
        { id: "openrouter", label: "Renamed", baseUrl: "https://new/v1" },
        { id: "glm", label: "GLM", baseUrl: "https://glm/v1" },
      ],
      fallbackChain: ["openrouter", "glm"],
    });
    expect(merged.providers.anthropicKey).toBe("sk-keep-me");
    expect(merged.providers.openaiCompatible).toEqual([
      { id: "openrouter", label: "Renamed", baseUrl: "https://new/v1", apiKey: "sk-existing" },
      { id: "glm", label: "GLM", baseUrl: "https://glm/v1", apiKey: "" },
    ]);
    expect(merged.providers.fallbackChain).toEqual(["openrouter", "glm"]);
  });

  it("applyProvidersPatch: explicit empty string clears a key (config, not just view)", () => {
    const config = JuniorConfigSchema.parse({ providers: { anthropicKey: "sk-gone" } });
    const merged = applyProvidersPatch(config, {
      openaiCompatible: [],
      fallbackChain: [],
      anthropicKey: "",
    });
    expect(merged.providers.anthropicKey).toBeUndefined();
  });

  it("applyProvidersPatch: absent models keep the persisted catalog, explicit array replaces it (M5-6)", () => {
    const config = JuniorConfigSchema.parse({
      providers: {
        openaiCompatible: [
          {
            id: "openrouter",
            label: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-or",
            models: ["vendor/old-a", "vendor/old-b"],
          },
        ],
      },
    });
    // A stale UI draft (no catalog) must not wipe the persisted one…
    const kept = applyProvidersPatch(config, {
      openaiCompatible: [
        { id: "openrouter", label: "Relabeled", baseUrl: "https://openrouter.ai/api/v1" },
      ],
      fallbackChain: [],
    });
    expect(kept.providers.openaiCompatible[0]?.models).toEqual(["vendor/old-a", "vendor/old-b"]);
    // …but an explicit array (re-test / manual edit) replaces it, and [] clears.
    const replaced = applyProvidersPatch(config, {
      openaiCompatible: [
        { id: "openrouter", label: "OpenRouter", baseUrl: "https://x/v1", models: ["vendor/new"] },
      ],
      fallbackChain: [],
    });
    expect(replaced.providers.openaiCompatible[0]?.models).toEqual(["vendor/new"]);
    const cleared = applyProvidersPatch(config, {
      openaiCompatible: [
        { id: "openrouter", label: "OpenRouter", baseUrl: "https://x/v1", models: [] },
      ],
      fallbackChain: [],
    });
    expect(cleared.providers.openaiCompatible[0]?.models).toEqual([]);
  });

  it("withPersistedModels sets the catalog on the matching entry; unknown/anthropic ids are a no-op (M5-6)", () => {
    const config = JuniorConfigSchema.parse({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: "https://x/v1", apiKey: "k" },
        ],
      },
    });
    const merged = withPersistedModels(config, "openrouter", ["vendor/model-a"]);
    expect(merged).not.toBe(config);
    expect(merged.providers.openaiCompatible[0]?.models).toEqual(["vendor/model-a"]);
    expect(config.providers.openaiCompatible[0]?.models).toBeUndefined(); // input untouched
    expect(withPersistedModels(config, "ghost", ["m"])).toBe(config); // same object ⇒ no write
    expect(withPersistedModels(config, "anthropic", ["m"])).toBe(config);
  });
});

describe("GET/PUT /api/config + POST /api/config/test (bearer-gated)", () => {
  it("GET returns the masked view; PUT persists and preserves keys it was not sent", async () => {
    const dir = newDir({
      providers: {
        anthropicKey: "sk-ant-1234567890abcd",
        openaiCompatible: [
          {
            id: "openrouter",
            label: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-or-kept",
          },
        ],
      },
    });
    const app = newApp(dir);

    const got = await app.request("/api/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(got.status).toBe(200);
    const view = (await got.json()) as Record<string, unknown>;
    expect(view.anthropicKeyMasked).toBe("…abcd");
    expect(JSON.stringify(view)).not.toContain("sk-or-kept");

    const put = await app.request("/api/config", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        providers: {
          openaiCompatible: [
            { id: "openrouter", label: "Renamed", baseUrl: "https://openrouter.ai/api/v1" },
          ],
          fallbackChain: ["anthropic", "openrouter"],
        },
      }),
    });
    expect(put.status).toBe(200);

    // Read the FILE: the anthropic key was absent from the patch and must survive;
    // the openrouter entry kept its key while picking up the new label.
    const onDisk = JuniorConfigSchema.parse(
      JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    );
    expect(onDisk.providers.anthropicKey).toBe("sk-ant-1234567890abcd");
    expect(onDisk.providers.openaiCompatible[0]?.apiKey).toBe("sk-or-kept");
    expect(onDisk.providers.openaiCompatible[0]?.label).toBe("Renamed");
    expect(onDisk.providers.fallbackChain).toEqual(["anthropic", "openrouter"]);
  });

  it("PUT rejects an invalid patch with 400 and touches nothing", async () => {
    const dir = newDir({ providers: { fallbackChain: ["anthropic"] } });
    const app = newApp(dir);
    const res = await app.request("/api/config", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ providers: { fallbackChain: "not-an-array" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: unknown }).error).toMatch(/fallbackChain/);
  });

  it("POST /api/config/test lists models through the fetch seam (openai-compatible)", async () => {
    const dir = newDir({
      providers: {
        openaiCompatible: [
          {
            id: "openrouter",
            label: "OpenRouter",
            baseUrl: "https://openrouter.test/api/v1",
            apiKey: "sk-or",
          },
        ],
      },
    });
    const seen: Array<{ url: string; auth: string | null }> = [];
    const app = newApp(dir, {
      fetchImpl: (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(input), auth: headers.get("authorization") });
        return new Response(
          JSON.stringify({ data: [{ id: "vendor/model-a" }, { id: "vendor/model-b" }] }),
          {
            status: 200,
          },
        );
      }) as typeof fetch,
    });
    const res = await app.request("/api/config/test", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ providerId: "openrouter" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, models: ["vendor/model-a", "vendor/model-b"] });
    expect(seen[0]?.url).toBe("https://openrouter.test/api/v1/models");
    expect(seen[0]?.auth).toBe("Bearer sk-or");
  });

  it("POST /api/config/test reports failures as ok:false (401 wire, unconfigured, empty list)", async () => {
    const dir = newDir({
      providers: {
        openaiCompatible: [
          { id: "locked", label: "Locked", baseUrl: "https://x.test/v1", apiKey: "k" },
          { id: "empty", label: "Empty", baseUrl: "https://y.test/v1", apiKey: "k" },
        ],
      },
    });
    const app = newApp(dir, {
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.startsWith("https://x.test/")) return new Response("denied", { status: 401 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    const test = async (providerId: string) =>
      (
        await app.request("/api/config/test", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ providerId }),
        })
      ).json();
    expect(await test("locked")).toMatchObject({ ok: false, error: "401" });
    expect(await test("empty")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no models"),
    });
    expect(await test("ghost")).toMatchObject({ ok: false }); // not configured
    expect(await test("anthropic")).toMatchObject({ ok: false }); // no key
  });

  it("POST /api/config/test persists the fetched catalog to config (M5-6) and the view serves it", async () => {
    const dir = newDir({
      providers: {
        openaiCompatible: [
          {
            id: "openrouter",
            label: "OpenRouter",
            baseUrl: "https://openrouter.test/api/v1",
            apiKey: "sk-or",
          },
        ],
      },
    });
    const app = newApp(dir, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: "vendor/model-a" }] }), {
          status: 200,
        })) as typeof fetch,
    });
    const res = await app.request("/api/config/test", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ providerId: "openrouter" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, models: ["vendor/model-a"] });

    // The catalog is on disk (survives a bridge restart)…
    const onDisk = JuniorConfigSchema.parse(
      JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    );
    expect(onDisk.providers.openaiCompatible[0]?.models).toEqual(["vendor/model-a"]);
    // …and the masked view already carries it back to the Settings draft.
    const got = await app.request("/api/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(
      ((await got.json()) as { openaiCompatible: Array<{ models?: string[] }> }).openaiCompatible[0]
        ?.models,
    ).toEqual(["vendor/model-a"]);
  });

  it("POST /api/config/test does NOT write when the fetch fails or the id is anthropic/unknown (M5-6)", async () => {
    const dir = newDir({
      providers: {
        anthropicKey: "sk-ant-1234567890abcd",
        openaiCompatible: [
          { id: "dead", label: "Dead", baseUrl: "https://dead.test/v1", apiKey: "k" },
        ],
      },
    });
    const app = newApp(dir, {
      fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    for (const providerId of ["dead", "anthropic", "ghost"]) {
      const res = await app.request("/api/config/test", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ providerId }),
      });
      expect(await res.json()).toMatchObject({ ok: false });
    }
    const onDisk = JuniorConfigSchema.parse(
      JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    );
    expect(onDisk.providers.openaiCompatible[0]?.models).toBeUndefined();
  });

  it("sits behind the bearer gate like every other data route", async () => {
    const dir = newDir();
    const app = newApp(dir);
    expect((await app.request("/api/config")).status).toBe(401);
    expect(
      (
        await app.request("/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/config/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });
});
