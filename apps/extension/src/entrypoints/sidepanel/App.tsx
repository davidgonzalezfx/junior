// Panel shell — chat (M2-3), ⌘K picker (M2-4), settings and history land later (plan §8).
// This placeholder proves the React + Tailwind + shadcn pipeline renders in the side panel.
import { Button } from "@/components/ui/button";

export default function App() {
  return (
    <div className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground">
      <h1 className="text-lg font-semibold">Junior</h1>
      <p className="text-sm text-muted-foreground">
        Scaffold — pairing, chat and settings arrive with M2-2…M2-4.
      </p>
      <Button variant="outline" className="w-fit">
        shadcn pipeline check
      </Button>
    </div>
  );
}
