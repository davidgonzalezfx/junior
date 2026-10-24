// Guard-mirror unit tests (plan §4.4 matrix over probed facts). Node env — facts
// are plain objects; no DOM involved until the executors.test.ts integration leg.
import { describe, expect, it } from "vitest";
import { BLOCKED_SENSITIVE_TEXT } from "@junior/protocol";
import { checkClickFacts, checkTypeFacts, type PreActCheck } from "./guard-mirror";

const PAGE = "https://example.com/account";

const benignLink = {
  tag: "a",
  type: "",
  text: "Documentation",
  ariaLabel: "",
  title: "",
  href: "https://example.com/docs",
  formAction: "",
  isSubmit: false,
};

const benignField = {
  tag: "input",
  type: "text",
  name: "query",
  id: "q",
  autocomplete: "off",
  placeholder: "Search",
  ariaLabel: "",
  labelText: "Search",
  formAction: "",
};

function verdictOf(check: PreActCheck): "allow" | "deny" | "ask" {
  return check.verdict;
}

describe("checkClickFacts", () => {
  it("allows a benign click in auto", () => {
    expect(checkClickFacts({ mode: "auto", pageUrl: PAGE, facts: benignLink })).toEqual({
      verdict: "allow",
    });
  });

  it("allows a benign click in none", () => {
    expect(verdictOf(checkClickFacts({ mode: "none", pageUrl: PAGE, facts: benignLink }))).toBe(
      "allow",
    );
  });

  it("asks in ask mode even for benign clicks (supervised)", () => {
    const check = checkClickFacts({ mode: "ask", pageUrl: PAGE, facts: benignLink });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") {
      expect(check.approval.element?.tag).toBe("a");
      expect(check.approval.pageUrl).toBe(PAGE);
      expect(check.approval.siteDomain).toBe("example.com");
    }
  });

  it("cards a sensitive label even in auto (§4.4 row 3)", () => {
    const check = checkClickFacts({
      mode: "auto",
      pageUrl: PAGE,
      facts: { ...benignLink, text: "Delete my account" },
    });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") expect(check.approval.reasonCodes).toContain("sensitive_label");
  });

  it("cards a form submit even in auto", () => {
    const check = checkClickFacts({
      mode: "auto",
      pageUrl: PAGE,
      facts: { ...benignLink, tag: "button", type: "submit", isSubmit: true },
    });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") expect(check.approval.reasonCodes).toContain("form_submit");
  });

  it("refuses a private-network destination in auto, no card", () => {
    const check = checkClickFacts({
      mode: "auto",
      pageUrl: PAGE,
      facts: { ...benignLink, href: "http://192.168.1.1/admin" },
    });
    expect(check.verdict).toBe("deny");
    if (check.verdict === "deny") expect(check.error).toContain("BLOCKED_BY_POLICY");
  });

  it("asks (not refuses) a private-network destination in ask mode", () => {
    const check = checkClickFacts({
      mode: "ask",
      pageUrl: PAGE,
      facts: { ...benignLink, href: "http://192.168.1.1/admin" },
    });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") {
      expect(check.approval.reasonCodes).toContain("private_network");
      expect(check.approval.destinationUrl).toContain("192.168.1.1");
    }
  });

  it("cards a link to stripe.com in auto", () => {
    const check = checkClickFacts({
      mode: "auto",
      pageUrl: PAGE,
      facts: { ...benignLink, href: "https://stripe.com/checkout" },
    });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") expect(check.approval.reasonCodes).toContain("sensitive_site");
  });

  it("cards when the CURRENT page is sensitive, even for a benign link", () => {
    const check = checkClickFacts({
      mode: "auto",
      pageUrl: "https://mail.google.com/u/0",
      facts: benignLink,
    });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") expect(check.approval.reasonCodes).toContain("sensitive_site");
  });
});

describe("checkTypeFacts", () => {
  it("refuses a password field in EVERY mode (§6.3-4)", () => {
    const facts = { ...benignField, type: "password", name: "pw" };
    for (const mode of ["ask", "auto", "none"]) {
      const check = checkTypeFacts({ mode, pageUrl: PAGE, facts, text: "hunter2" });
      expect(check.verdict).toBe("deny");
      if (check.verdict === "deny") expect(check.error).toBe(BLOCKED_SENSITIVE_TEXT);
    }
  });

  it("refuses a card-number field by name even when type=text", () => {
    const check = checkTypeFacts({
      mode: "none",
      pageUrl: PAGE,
      facts: { ...benignField, name: "card_number" },
      text: "4111",
    });
    expect(check.verdict).toBe("deny");
  });

  it("refuses by autocomplete token (cc-number)", () => {
    const check = checkTypeFacts({
      mode: "auto",
      pageUrl: PAGE,
      facts: { ...benignField, autocomplete: "cc-number" },
      text: "4111",
    });
    expect(check.verdict).toBe("deny");
  });

  it("allows benign typing without submit in auto/none", () => {
    expect(
      checkTypeFacts({ mode: "auto", pageUrl: PAGE, facts: benignField, text: "hello" }),
    ).toEqual({
      verdict: "allow",
    });
    expect(
      checkTypeFacts({ mode: "none", pageUrl: PAGE, facts: benignField, text: "hello" }),
    ).toEqual({
      verdict: "allow",
    });
  });

  it("asks in ask mode for benign typing (supervised) with a typed preview", () => {
    const check = checkTypeFacts({ mode: "ask", pageUrl: PAGE, facts: benignField, text: "hello" });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") {
      expect(check.approval.typed).toBe("hello");
      expect(check.approval.element?.tag).toBe("input");
    }
  });

  it("cards typing-with-Enter (form submit) even in auto; allows in none", () => {
    const facts = { ...benignField, formAction: "https://example.com/search" };
    const auto = checkTypeFacts({ mode: "auto", pageUrl: PAGE, facts, text: "query\n" });
    expect(auto.verdict).toBe("ask");
    if (auto.verdict === "ask") expect(auto.approval.reasonCodes).toContain("form_submit");

    expect(checkTypeFacts({ mode: "none", pageUrl: PAGE, facts, text: "query\n" }).verdict).toBe(
      "allow",
    );
  });
});

describe("site grants (M3-3 `granted` input)", () => {
  it("suppresses a supervised ask on a granted site (click)", () => {
    expect(
      checkClickFacts({ mode: "ask", pageUrl: PAGE, facts: benignLink, granted: true }),
    ).toEqual({ verdict: "allow" });
  });

  it("suppresses a supervised ask on a granted site (type)", () => {
    expect(
      checkTypeFacts({ mode: "ask", pageUrl: PAGE, facts: benignField, text: "hi", granted: true }),
    ).toEqual({ verdict: "allow" });
  });

  it("never waives a deny: secret fields stay refused with a grant", () => {
    const secret = { ...benignField, autocomplete: "current-password" };
    expect(
      checkTypeFacts({ mode: "ask", pageUrl: PAGE, facts: secret, text: "x", granted: true })
        .verdict,
    ).toBe("deny");
  });

  it("never waives a private_network ask with a grant", () => {
    const toPrivate = { ...benignLink, href: "http://127.0.0.1:8080/admin" };
    const check = checkClickFacts({
      mode: "ask",
      pageUrl: PAGE,
      facts: toPrivate,
      granted: true,
    });
    expect(check.verdict).toBe("ask");
    if (check.verdict === "ask") expect(check.approval.reasonCodes).toContain("private_network");
  });
});
