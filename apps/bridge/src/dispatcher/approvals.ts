// @junior/bridge/dispatcher/approvals — approval-item constants + denial messages
// (plan §4.3). Approval items ride the same queue as actions (kind "approval") and
// are resolved by POST /api/agent/approval-response. Nobody to ask, or the window
// lapses ⇒ deny (Autono requestExternalActionApproval default, background.js:4799,
// at 120 s instead of 60 s). Denials use the §4.4 structured prefixes (USER_DENIED /
// BLOCKED_BY_POLICY) so the agent knows not to retry.
export const APPROVAL_TIMEOUT_MS = 120_000;

export type ApprovalDenialReason = "user" | "timeout" | "no-panel";

export function approvalDenial(reason: ApprovalDenialReason): string {
  switch (reason) {
    case "user":
      return "USER_DENIED: the user denied this action in the approval card";
    case "timeout":
      return `BLOCKED_BY_POLICY: approval not answered within ${APPROVAL_TIMEOUT_MS / 1000} s (default deny)`;
    case "no-panel":
      return "BLOCKED_BY_POLICY: no panel connected to approve — default deny";
  }
}
