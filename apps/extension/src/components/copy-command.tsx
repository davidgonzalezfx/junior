// CopyCommand — one-click copy for shell commands (onboarding step 1, re-pair hint,
// status bar). `navigator.clipboard` is available in extension pages.
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button variant="outline" size="sm" className="gap-2 font-mono" onClick={() => void copy()}>
      {label ?? command}
      <span aria-hidden>{copied ? "✓" : "⧉"}</span>
    </Button>
  );
}
