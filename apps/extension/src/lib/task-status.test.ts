// Task-status tracker tests (M5-9): the SW's last known task_status for panels
// that connect mid-task — updates flow through, snapshots are independent copies.
import { describe, expect, it } from "vitest";
import { TaskStatusTracker } from "./task-status";

describe("TaskStatusTracker", () => {
  it("starts idle, records updates, and returns the message to broadcast", () => {
    const t = new TaskStatusTracker();
    expect(t.snapshot()).toEqual({ type: "task_status", state: "idle" });

    expect(t.update("working", "navigate https://example.com/")).toEqual({
      type: "task_status",
      state: "working",
      detail: "navigate https://example.com/",
    });
    expect(t.update("awaiting_approval")).toEqual({
      type: "task_status",
      state: "awaiting_approval",
    });
    expect(t.snapshot()).toEqual({ type: "task_status", state: "awaiting_approval" });
    // paused is a state too (the overlay Pause path), not a separate channel
    expect(t.update("paused").state).toBe("paused");
  });

  it("snapshot returns an independent copy — later updates don't mutate handed-out messages", () => {
    const t = new TaskStatusTracker();
    t.update("working");
    const snap = t.snapshot();
    t.update("idle");
    expect(snap).toEqual({ type: "task_status", state: "working" });
  });
});
