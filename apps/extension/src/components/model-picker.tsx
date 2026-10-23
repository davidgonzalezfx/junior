// ⌘K model/provider palette (plan §5.3) — cmdk Command.Dialog over /api/status groups.
// Replaces Autono's hardcoded <select> + free-text input entirely. Global ⌘K/Ctrl+K
// toggles; the chat header badge button also opens it. Selection persists the default
// (junior_default_provider), records a recent entry, and retargets the next send.
import { useEffect } from "react";
import { Command } from "cmdk";
import { buildPickerGroups, encodePickerValue } from "@/lib/picker";
import type { PickerItem } from "@/lib/picker";
import type { BridgeStatus } from "@junior/protocol";
import type { RecentModel } from "@/lib/settings";

interface ModelPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: BridgeStatus;
  recent: RecentModel[];
  /** Currently active pair, highlighted in the list. */
  current: { providerId: string; model: string };
  onSelect: (item: PickerItem) => void;
}

export function ModelPicker({
  open,
  onOpenChange,
  status,
  recent,
  current,
  onSelect,
}: ModelPickerProps) {
  // ⌘K / Ctrl+K toggles (cmdk README pattern) — panel-global, scoped to open state.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  const groups = buildPickerGroups(status, recent);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Model picker"
      contentClassName="fixed left-1/2 top-16 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      overlayClassName="fixed inset-0 z-40 bg-black/40"
    >
      <Command.Input
        placeholder="Search provider or model…"
        className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-1">
        <Command.Empty className="px-3 py-4 text-center text-xs text-muted-foreground">
          No models available — add a key in Settings → Providers.
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            key={group.id}
            heading={group.heading}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
          >
            {group.items.map((item) => (
              <Command.Item
                key={`${item.providerId}:${item.model}`}
                value={encodePickerValue(item)}
                keywords={item.keywords}
                onSelect={() => {
                  onOpenChange(false);
                  onSelect(item);
                }}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <span className="truncate">{item.model}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {item.badges.map((badge) => (
                    <span
                      key={badge}
                      className="rounded bg-secondary px-1 py-0.5 text-[9px] uppercase tracking-wide text-secondary-foreground"
                    >
                      {badge}
                    </span>
                  ))}
                  {item.providerId === current.providerId && item.model === current.model ? (
                    <span aria-label="current" className="text-[10px] text-muted-foreground">
                      ✓
                    </span>
                  ) : null}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
