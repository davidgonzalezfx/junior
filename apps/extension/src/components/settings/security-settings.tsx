// Settings → Agent & Security (plan §5.3): the permission
// mode radio plus the matrix rendered as a table. The table's cells are computed
// by CALLING the pure permissionDecision from @junior/protocol per (mode, code) —
// the display can never drift from the enforcement tables (§5.2 item 4).
import { useEffect, useState } from "react";
import {
  PERMISSION_MODES,
  permissionDecision,
  type GuardReasonCode,
  type PermissionMode,
} from "@junior/protocol";
import { loadSettings, saveSettings } from "@/lib/settings";

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "Show a card before every non-routine action (default).",
  auto: "Allow routine actions; still ask for sensitive sites/labels/forms, deny private networks.",
  none: "Allow everything except secret fields — never type passwords (§6.3-4).",
};

/** Rows of the matrix, in the order the guard encounters them. */
const MATRIX_ROWS: { code: GuardReasonCode; label: string }[] = [
  { code: "routine_supervised", label: "Routine action" },
  { code: "new_site", label: "First visit to a site" },
  { code: "sensitive_site", label: "Sensitive site (bank, webmail, …)" },
  { code: "sensitive_label", label: "Sensitive-looking button/link" },
  { code: "form_submit", label: "Form submission" },
  { code: "private_network", label: "Local/internal network address" },
  { code: "secret_field", label: "Password / secret field" },
];

const DECISION_STYLES: Record<string, string> = {
  allow: "text-green-600 dark:text-green-400",
  ask: "text-amber-600 dark:text-amber-400",
  deny: "text-red-600 dark:text-red-400",
};

export function SecuritySettings() {
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadSettings().then((s) => setMode(s.permissionMode));
  }, []);

  const pick = (next: PermissionMode) => {
    setMode(next);
    void saveSettings({ permissionMode: next }).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  };

  if (mode === null) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <section aria-label="Agent and Security" className="flex flex-col gap-3 text-sm">
      <h2 className="font-medium">Agent &amp; Security</h2>
      <div role="radiogroup" aria-label="Permission mode" className="flex flex-col gap-2">
        {PERMISSION_MODES.map((m) => (
          <label key={m} className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="permissionMode"
              value={m}
              checked={mode === m}
              onChange={() => pick(m)}
              className="mt-1"
            />
            <span>
              <span className="font-mono text-xs">{m}</span> — {MODE_DESCRIPTIONS[m]}
            </span>
          </label>
        ))}
      </div>
      {saved && <span className="text-xs text-green-600">Saved</span>}
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">What the guard does per reason, per permission mode</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2 font-normal">When the action involves</th>
            {PERMISSION_MODES.map((m) => (
              <th key={m} className="py-1 pr-2 font-mono font-normal">
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX_ROWS.map(({ code, label }) => (
            <tr key={code} className="border-t">
              <td className="py-1 pr-2">{label}</td>
              {PERMISSION_MODES.map((m) => {
                const decision = permissionDecision(m, [code]);
                return (
                  <td key={m} className={`py-1 pr-2 ${DECISION_STYLES[decision]}`}>
                    {decision}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Cards show the real probed facts of an action; answering "allow for this session" only
        covers the current browser session. Secret fields are refused in every mode.
      </p>
    </section>
  );
}
