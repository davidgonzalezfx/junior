// Panel shell — M2-2: onboarding on first run + bridge status bar. M2-3: chat. ⌘K
// picker and settings (M2-4), history (M2-5) land later (plan §8).
import { useEffect, useState } from "react";
import { BridgeStatusBar } from "@/components/bridge-status-bar";
import { ChatPanel } from "@/components/chat-panel";
import { Onboarding } from "@/components/onboarding";
import { isOnboarded } from "@/lib/settings";

export default function App() {
  const [state, setState] = useState<"loading" | "onboarding" | "ready">("loading");

  useEffect(() => {
    void isOnboarded().then((onboarded) => setState(onboarded ? "ready" : "onboarding"));
  }, []);

  if (state === "loading") {
    return <div className="h-screen bg-background" />;
  }
  if (state === "onboarding") {
    return <Onboarding onDone={() => setState("ready")} />;
  }
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <BridgeStatusBar />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <ChatPanel />
      </div>
    </div>
  );
}
