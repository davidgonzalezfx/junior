// Approval-card tests (jsdom): fact rows from REAL wire data, three-button
// responses, countdown expiry auto-denies (fake timers), several cards coexist.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@junior/protocol";
import { ApprovalCard, ApprovalCardStack } from "./approval-card";
import type { PendingCard } from "@/hooks/use-approval-cards";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NAVIGATE: ApprovalRequest = {
  reasonCodes: ["sensitive_site", "new_site"],
  reasons: ["Sensitive site: online banking", "First visit to this site"],
  pageUrl: "https://mail.example.com/inbox",
  destinationUrl: "https://bank.example.com/login",
  siteDomain: "bank.example.com",
};

const TYPED: ApprovalRequest = {
  reasonCodes: ["form_submit"],
  reasons: ["Typing ends with Enter, which submits the form"],
  pageUrl: "https://example.com/search",
  element: { tag: "input", type: "text", text: "Search…", formAction: "/search" },
  typed: "junior release notes",
  siteDomain: "example.com",
};

function card(partial: Partial<PendingCard>): PendingCard {
  return {
    id: "card-1",
    approval: NAVIGATE,
    deadline: Date.now() + 120_000,
    totalMs: 120_000,
    ...partial,
  };
}

describe("ApprovalCard", () => {
  it("renders the real probed facts and reasons", () => {
    render(<ApprovalCard card={card({})} respond={() => {}} />);
    expect(screen.getByText("Sensitive site: online banking")).toBeTruthy();
    expect(screen.getByText("First visit to this site")).toBeTruthy();
    expect(screen.getByText("https://mail.example.com/inbox")).toBeTruthy();
    expect(screen.getByText("https://bank.example.com/login")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Junior asks for approval" })).toBeTruthy();
  });

  it("shows typed preview and form destination when present", () => {
    render(<ApprovalCard card={card({ approval: TYPED })} respond={() => {}} />);
    expect(screen.getByText("junior release notes")).toBeTruthy();
    expect(screen.getByText("/search")).toBeTruthy();
    expect(screen.getByText('<input type="text">')).toBeTruthy();
  });

  it("masks secret fields (typed never arrives for them)", () => {
    const secret: ApprovalRequest = {
      ...TYPED,
      element: { tag: "input", type: "password" },
      typed: null,
    };
    render(<ApprovalCard card={card({ approval: secret })} respond={() => {}} />);
    expect(screen.getByText("secret field (hidden)")).toBeTruthy();
  });

  it("buttons answer once / site / deny with the card id", () => {
    const respond = vi.fn();
    render(<ApprovalCard card={card({})} respond={respond} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(respond).toHaveBeenCalledWith("card-1", "once");
    fireEvent.click(
      screen.getByRole("button", { name: "Allow bank.example.com for this session" }),
    );
    expect(respond).toHaveBeenCalledWith("card-1", "site");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(respond).toHaveBeenCalledWith("card-1", "deny");
  });

  it("counts down and auto-denies at the deadline", async () => {
    const respond = vi.fn();
    render(
      <ApprovalCard
        card={card({ deadline: Date.now() + 3_000, totalMs: 120_000 })}
        respond={respond}
      />,
    );
    expect(screen.getByLabelText(/Auto-deny in 3 seconds/)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(3_250);
    expect(respond).toHaveBeenCalledWith("card-1", "deny");
  });

  it("hides the site button when no siteDomain (never grants a private net)", () => {
    const noSite: ApprovalRequest = { ...NAVIGATE, siteDomain: undefined };
    render(<ApprovalCard card={card({ approval: noSite })} respond={() => {}} />);
    expect(screen.queryByRole("button", { name: /for this session/ })).toBeNull();
  });
});

describe("ApprovalCardStack", () => {
  it("renders nothing when idle and coexisting cards answer independently", async () => {
    const respond = vi.fn();
    const { container, rerender } = render(<ApprovalCardStack cards={[]} respond={respond} />);
    expect(container.children).toHaveLength(0);

    rerender(
      <ApprovalCardStack
        cards={[card({ id: "a", approval: NAVIGATE }), card({ id: "b", approval: TYPED })]}
        respond={respond}
      />,
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(2); // rerender is synchronous
    fireEvent.click(screen.getAllByRole("button", { name: "Deny" })[0]!);
    expect(respond).toHaveBeenCalledWith("a", "deny");
    expect(screen.getAllByRole("dialog")).toHaveLength(2); // b still pending
  });
});
