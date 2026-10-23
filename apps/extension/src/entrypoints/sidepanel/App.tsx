// Panel shell — M2-2: onboarding on first run + bridge status bar. M2-4: chat + ⌘K
// picker + Settings → Providers (plan §8). History (M2-5) lands later.
import { useEffect, useState } from "react";
import { BridgeStatusBar } from "@/components/bridge-status-bar";
import { ChatPanel } from "@/components/chat-panel";
import { Onboarding } from "@/components/onboarding";
import { ProvidersSettings } from "@/components/settings/providers-settings";
import { isOnboarded } from "@/lib/settings";

type View = "loading" | "onboarding" | "chat" | "providers";

export default function App() {
  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    void isOnboarded().then((onboarded) => setView(onboarded ? "chat" : "onboarding"));
  }, []);

  if (view === "loading") {
    return <div className="h-screen bg-background" />;
  }
  if (view === "onboarding") {
    return <Onboarding onDone={() => setView("chat")} />;
  }
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <BridgeStatusBar />
      {view === "providers" ? (
        <ProvidersSettings onBack={() => setView("chat")} />
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex justify-end">
            <button
              type="button"
              aria-label="Open Settings"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => setView("providers")}
            >
              Settings
            </button>
          </div>
          <ChatPanel />
        </div>
      )}
    </div>
  );
}
