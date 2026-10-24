// Work-overlay status chip (§5.3): renders the SW's task_status states.
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkOverlayStatus } from "./work-overlay-status";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("WorkOverlayStatus", () => {
  it.each([
    [null, "Idle"],
    ["idle", "Idle"],
    ["working", "Junior is working"],
    ["awaiting_approval", "Waiting for you"],
    ["paused", "Paused"],
  ] as const)("status %s renders %s", (status, label) => {
    render(<WorkOverlayStatus status={status} />);
    expect(screen.getByTestId("work-overlay-status").textContent).toBe(label);
  });
});
