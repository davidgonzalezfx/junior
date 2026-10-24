// Site-grant tests: pure coverage math + storage round-trips through fakeBrowser.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { addSiteGrant, clearSiteGrants, getSiteGrants, grantCovers } from "./site-grants";

beforeEach(() => fakeBrowser.reset());

describe("grantCovers (pure)", () => {
  it("matches by registrable domain — subdomains inherit the grant", () => {
    expect(grantCovers(["example.com"], "https://app.example.com/search?q=1")).toBe(true);
    expect(grantCovers(["example.com"], "https://example.com/")).toBe(true);
    expect(grantCovers(["example.com"], "https://example.org/")).toBe(false);
    expect(grantCovers(["example.com"], "https://evilexample.com/")).toBe(false);
    expect(grantCovers([], "https://example.com/")).toBe(false);
  });

  it("refuses garbage URLs", () => {
    expect(grantCovers(["example.com"], "not a url")).toBe(false);
    expect(grantCovers(["example.com"], "")).toBe(false);
  });
});

describe("storage round-trips", () => {
  it("add is idempotent and persists; clear empties", async () => {
    await addSiteGrant("example.com");
    await addSiteGrant("example.com");
    await addSiteGrant("z.ai");
    await expect(getSiteGrants()).resolves.toEqual(["example.com", "z.ai"]);
    await clearSiteGrants();
    await expect(getSiteGrants()).resolves.toEqual([]);
  });
});
