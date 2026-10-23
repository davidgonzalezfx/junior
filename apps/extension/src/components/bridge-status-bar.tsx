// Bridge status bar (plan §5.3): green/red dot from the /api/health poll + "Start bridge"
// hint with a copy button when down — no silent failures.
import { useBridgeStatus } from "@/hooks/use-bridge-status";
import { CopyCommand } from "@/components/copy-command";

const SERVE_COMMAND = "junior-bridge serve";

export function BridgeStatusBar() {
  const { online } = useBridgeStatus();

  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
      <span
        aria-hidden
        className={
          online === null
            ? "size-2 rounded-full bg-muted-foreground/50"
            : online
              ? "size-2 rounded-full bg-green-500"
              : "size-2 rounded-full bg-red-500"
        }
      />
      {online === null ? (
        <span className="text-muted-foreground">Checking bridge…</span>
      ) : online ? (
        <span className="text-muted-foreground">Bridge connected</span>
      ) : (
        <span className="flex flex-1 items-center gap-2 text-muted-foreground">
          Bridge down — start it:
          <CopyCommand command={SERVE_COMMAND} />
        </span>
      )}
    </div>
  );
}
