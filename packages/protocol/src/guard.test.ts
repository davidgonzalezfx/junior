// M1-4 acceptance — the Autono guard test battery, ported (plan §8 M1: "feed it the
// Autono test cases"). Sources: autono-clone/tests/security-sprint2.test.js (URL
// validation, sensitive tables) and Autono/tests/autono-security.test.cjs (permission
// matrix). Expectations follow plan §4.4/§6.3 where Junior deliberately hardens on
// Autono — each delta is marked inline.
import { describe, expect, it } from "vitest";
import {
  AGENT_URL_MAX_LEN,
  BLOCKED_BY_POLICY_TEXT,
  USER_DENIED_TEXT,
  denialTextFor,
  fieldIsSensitive,
  labelIsSensitive,
  normalizePermissionMode,
  permissionDecision,
  registrableDomain,
  sensitiveSiteReason,
  validateAgentUrl,
  type PermissionMode,
} from "./guard.js";

const blocked = (u: unknown, o?: Parameters<typeof validateAgentUrl>[1]) =>
  !validateAgentUrl(u, o).ok;
const confirm = (u: string, o?: Parameters<typeof validateAgentUrl>[1]) => {
  const r = validateAgentUrl(u, o);
  return r.ok && r.needsConfirm !== null;
};
const plain = (u: string, o?: Parameters<typeof validateAgentUrl>[1]) => {
  const r = validateAgentUrl(u, o);
  return r.ok && r.needsConfirm === null;
};

describe("validateAgentUrl — hard rejects (no approval can fix)", () => {
  for (const u of [
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "file:///C:/Windows/win.ini",
    "blob:https://example.com/1234",
    "ftp://example.com/x",
    "filesystem:https://example.com/temporary/a",
    "chrome://settings",
    "chrome-extension://abc/page.html",
    "about:blank",
    "https://user:pw@host.example/",
    "https://user@host.example/",
    `http://${"a".repeat(2100)}.com`,
    "",
    "   ",
    "https://exa\nmple.com",
    42,
    null,
  ]) {
    it(`reject ${String(u).slice(0, 40) || "''"}`, () => {
      expect(validateAgentUrl(u).ok).toBe(false);
    });
  }
});

describe("validateAgentUrl — needs confirmation (local / private)", () => {
  for (const u of [
    "http://127.0.0.1:8765/docs",
    "http://localhost:8765/",
    "http://foo.localhost/",
    "http://192.168.1.1/admin",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://169.254.169.254/latest/meta-data/",
    "http://printer.local/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:c0a8:101]/",
    // WHATWG URL normalizes these numeric hosts to 127.0.0.1 before we ever look.
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://017700000001/",
    "http://0/",
    "http://router/",
    "http://localhost./",
    "http://LOCALHOST:3000/",
    "http://100.64.0.1/",
    "http://127.0.0.2/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
  ]) {
    it(`confirm ${u}`, () => {
      const r = validateAgentUrl(u);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.needsConfirm?.kind).toBe("private_network");
    });
  }
});

describe("validateAgentUrl — normal destinations stay allowed", () => {
  for (const u of [
    "https://example.com/",
    "http://example.org/a?b=c",
    "https://evil.example/?d=x",
    "https://www.google.com/search?q=hello world",
    "https://sub.domain.co.uk/path",
    "https://[2606:4700:4700::1111]/",
    "http://8.8.8.8/",
  ]) {
    it(`allow ${u}`, () => {
      expect(plain(u), JSON.stringify(validateAgentUrl(u))).toBe(true);
    });
  }

  it("normalises the URL", () => {
    const r = validateAgentUrl("https://Example.COM");
    expect(r.ok && r.url).toBe("https://example.com/");
  });

  it("assumeHttps adds the scheme (and keeps rejecting javascript:)", () => {
    const r = validateAgentUrl("example.com/x", { assumeHttps: true });
    expect(r.ok && r.url).toBe("https://example.com/x");
    expect(blocked("javascript:alert(1)", { assumeHttps: true })).toBe(true);
    expect(confirm("localhost:8765/docs", { assumeHttps: true })).toBe(true);
    const proto = validateAgentUrl("//example.com/a", { assumeHttps: true });
    expect(proto.ok && proto.origin).toBe("https://example.com");
  });

  it("without assumeHttps a bare host is invalid", () => {
    expect(blocked("example.com")).toBe(true);
  });

  it(`length cap is ${AGENT_URL_MAX_LEN}`, () => {
    expect(plain(`https://example.com/${"a".repeat(1900)}`)).toBe(true);
    expect(blocked(`https://example.com/${"a".repeat(2000)}`)).toBe(true);
  });
});

describe("validateAgentUrl — blockedOrigins are a HARD reject (§6.3-5)", () => {
  // Autono's sprint2 test expected needsConfirm here; Junior refuses outright —
  // "the agent can never target … the bridge origin" (plan §6.3-5).
  const internal = ["https://bridge.example.net:9000", "http://192.168.0.9:8765"];
  it("rejects a blocked origin even in none-mode semantics", () => {
    expect(blocked("https://bridge.example.net:9000/v1/models", { blockedOrigins: internal })).toBe(
      true,
    );
    expect(
      validateAgentUrl("https://bridge.example.net:9000/v1/models", { blockedOrigins: internal }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("bridge.example.net:9000"),
    });
  });
  it("another port of the same host is fine", () => {
    expect(plain("https://bridge.example.net:9001/", { blockedOrigins: internal })).toBe(true);
  });
});

describe("registrableDomain", () => {
  it("collapses to the registrable domain", () => {
    expect(registrableDomain("www.mail.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("labelIsSensitive (en + es, Autono lists verbatim)", () => {
  for (const l of [
    "Pay now",
    "Buy",
    "Place order",
    "Complete purchase",
    "Send",
    "Delete account",
    "Remove",
    "Transfer funds",
    "Authorize",
    "Allow",
    "Grant access",
    "Publish",
    "Confirm",
    "Submit",
    "Checkout",
    "Pagar",
    "Comprar ahora",
    "Enviar mensaje",
    "Eliminar",
    "Borrar",
    "Transferir",
    "Autorizar",
    "Permitir",
    "Publicar",
    "Confirmar",
  ]) {
    it(`sensitive: ${l}`, () => expect(labelIsSensitive(l)).toBe(true));
  }
  for (const l of [
    "Search",
    "Next",
    "Read more",
    "Open menu",
    "Buscar",
    "Siguiente",
    "",
    "Sender info card",
  ]) {
    it(`benign: ${l || "''"}`, () => expect(labelIsSensitive(l)).toBe(false));
  }
});

describe("fieldIsSensitive", () => {
  it("matches secrets", () => {
    expect(fieldIsSensitive({ type: "password" })).toBe(true);
    expect(fieldIsSensitive({ type: "text", autocomplete: "new-password" })).toBe(true);
    expect(fieldIsSensitive({ type: "text", autocomplete: "cc-number" })).toBe(true);
    expect(fieldIsSensitive({ type: "text", autocomplete: "one-time-code" })).toBe(true);
    expect(fieldIsSensitive({ type: "text", name: "otp_code" })).toBe(true);
    expect(fieldIsSensitive({ type: "text", labelText: "IBAN" })).toBe(true);
  });
  it("leaves ordinary fields alone", () => {
    expect(fieldIsSensitive({ type: "search", name: "q", placeholder: "Search" })).toBe(false);
    expect(fieldIsSensitive({ type: "text", name: "shipping_address" })).toBe(false);
    expect(fieldIsSensitive(null)).toBe(false);
  });
});

describe("sensitiveSiteReason (always-ask list)", () => {
  for (const [u, why] of [
    ["https://mail.google.com/mail/u/0/", "webmail"],
    ["https://outlook.live.com/mail", "webmail"],
    ["https://www.paypal.com/", "banking"],
    ["https://github.com/settings", "code"],
    ["https://console.aws.amazon.com/", "cloud"],
    ["https://accounts.google.com/signin", "account"],
    ["https://example.com/oauth2/authorize?x=1", "sign-in"],
    ["https://vault.bitwarden.com/", "password"],
    ["https://app.1password.com/", "password"],
  ] as const) {
    it(`sensitive: ${u} (${why})`, () => expect(sensitiveSiteReason(u)).not.toBe(""));
  }
  for (const u of [
    "https://en.wikipedia.org/wiki/Bank",
    "https://example.com/",
    "https://news.ycombinator.com/",
  ]) {
    it(`normal: ${u}`, () => expect(sensitiveSiteReason(u)).toBe(""));
  }
});

describe("normalizePermissionMode", () => {
  it("ask is the default for anything unknown", () => {
    for (const v of [undefined, null, "", "yolo", 5, {}, "nope"]) {
      expect(normalizePermissionMode(v)).toBe("ask");
    }
  });
  it("trims and case-folds valid modes (Autono behavior)", () => {
    expect(normalizePermissionMode(" Auto ")).toBe("auto");
    expect(normalizePermissionMode("AUTO ")).toBe("auto");
    expect(normalizePermissionMode("NONE")).toBe("none");
  });
});

describe("permissionDecision — plan §4.4 matrix", () => {
  const decide = (m: PermissionMode, codes: Parameters<typeof permissionDecision>[1]) =>
    permissionDecision(m, codes);

  it("ask shows the card (but a secret field is refused even there, §6.3-4)", () => {
    for (const codes of [
      [],
      ["new_site"],
      ["private_network"],
      ["sensitive_site"],
      ["routine_supervised"],
    ] as const) {
      expect(decide("ask", codes)).toBe("ask");
      expect(decide("garbage" as never, codes)).toBe("ask");
    }
    // Delta from Autono (which carded secret fields in ask mode): refuse everywhere.
    expect(decide("ask", ["secret_field"])).toBe("deny");
  });

  it("auto allows routine traffic without asking", () => {
    for (const codes of [
      undefined,
      [],
      ["new_site"],
      ["routine_supervised"],
      ["incognito"],
    ] as const) {
      expect(decide("auto", codes)).toBe("allow");
    }
  });

  it("auto still cards sensitive sites / labels / form submits (§4.4 row 3)", () => {
    // Delta from Autono (which allowed these in auto): the plan cards them "even auto".
    for (const codes of [
      ["sensitive_site"],
      ["sensitive_label"],
      ["form_submit"],
      ["new_site", "sensitive_site"],
    ] as const) {
      expect(decide("auto", codes), JSON.stringify(codes)).toBe("ask");
    }
  });

  it("auto refuses local/internal addresses with no card", () => {
    expect(decide("auto", ["private_network"])).toBe("deny");
    expect(decide("auto", ["new_site", "private_network"])).toBe("deny");
  });

  it("none allows everything except secret fields", () => {
    for (const codes of [
      [],
      ["new_site"],
      ["sensitive_site"],
      ["private_network"],
      ["form_submit", "sensitive_label"],
    ] as const) {
      expect(decide("none", codes)).toBe("allow");
    }
    expect(decide("none", ["secret_field"])).toBe("deny");
    expect(decide("none", ["new_site", "secret_field", "form_submit"])).toBe("deny");
  });
});

describe("denial strings (§4.4 structured prefixes)", () => {
  it("ask refusals are the user's answer; auto/none refusals are policy", () => {
    expect(denialTextFor("ask")).toBe(USER_DENIED_TEXT);
    expect(denialTextFor("auto")).toBe(BLOCKED_BY_POLICY_TEXT);
    expect(denialTextFor("none")).toBe(BLOCKED_BY_POLICY_TEXT);
  });
  it("prefixes tell the agent not to retry", () => {
    expect(USER_DENIED_TEXT.startsWith("USER_DENIED:")).toBe(true);
    expect(BLOCKED_BY_POLICY_TEXT.startsWith("BLOCKED_BY_POLICY:")).toBe(true);
  });
});
