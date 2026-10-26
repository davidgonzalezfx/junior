// lib/executors/restricted.ts — pages (and frames) the agent never automates.

// Port of Autono isRestrictedUrl (background.js:1751–1773): internal pages are
// never automation targets.
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase().trim();
  if (lower === "") return true;
  return (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("about:") ||
    lower.startsWith("view-source:") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("chrome-untrusted://") ||
    lower.startsWith("chrome-search://") ||
    lower.startsWith("file:") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("filesystem:") ||
    lower.startsWith("ftp:") ||
    lower.includes("chrome.google.com/webstore") ||
    lower.includes("chromewebstore.google.com")
  );
}

export const RESTRICTED_TEXT = "Action omitted: not permitted on internal Chrome pages";
