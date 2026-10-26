// Bridge status bar (plan §5.3): green/red dot from the /api/health poll + "Start bridge"
// hint with a copy button when down — no silent failures. The offline state is a
// proper banner (destructive tint, explicit "can't send" copy, manual re-check) instead
// of a thin bar that reads as decorative.
import { useBridgeStatus } from "@/hooks/use-bridge-status";
import { CopyCommand } from "@/components/copy-command";
import { Button } from "@/components/ui/button";

const SERVE_COMMAND = "junior-bridge serve";

export function BridgeStatusBar() {
  const { online, recheck } = useBridgeStatus();

  if (online === false) {
    return (
      <div
        role="status"
        data-bridge-offline
        className="flex flex-col gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-xs"
      >
        <p className="font-medium text-destructive">Bridge offline — messages can't send.</p>
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>Start it:</span>
          <CopyCommand command={SERVE_COMMAND} />
          <Button variant="outline" size="sm" onClick={recheck}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
      <span
        aria-hidden
        className={
          online === null
            ? "size-2 rounded-full bg-muted-foreground/50"
            : "size-2 rounded-full bg-green-500"
        }
      />
      {online === null ? (
        <span className="text-muted-foreground">Checking bridge…</span>
      ) : (
        <span className="text-muted-foreground">Bridge connected</span>
      )}
    </div>
  );
}
