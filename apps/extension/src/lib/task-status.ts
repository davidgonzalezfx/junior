// lib/task-status.ts — M5-9: the SW's last known task_status. The broadcasts are
// fire-and-forget, so a panel that opens (or reopens) mid-task missed every one
// of them and had to guess "idle" — the onConnect handler sends snapshot()
// right after init_state so the chip shows the task's true state.
import type { TaskStatusMessage } from "./port-router";

export class TaskStatusTracker {
  private last: TaskStatusMessage = { type: "task_status", state: "idle" };

  /** Record the new state and return a copy to broadcast. */
  update(state: TaskStatusMessage["state"], detail?: string): TaskStatusMessage {
    this.last = { type: "task_status", state, ...(detail === undefined ? {} : { detail }) };
    return { ...this.last };
  }

  /** The current state, for a freshly (re)connected panel. */
  snapshot(): TaskStatusMessage {
    return { ...this.last };
  }
}
