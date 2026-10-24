// M3-5 fake-model harness — sensitive-site scenarios (plan §8 M3-5, the M3
// acceptance card flow): the jsdom tab lives ON the sensitive origin so in-page
// executors really run there; cross-origin navigations into it swap realms in
// FakeTab. Flow: navigate → bridge card (wire) → "once"; click → extension-side
// mirror card → "once"; navigate → card → "site" grants; next navigation raises
// zero cards; secret field refused throughout — all on a domain from the real
// SENSITIVE_SITES table (chase.com, banking / payments).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BLOCKED_SENSITIVE_TEXT } from "@junior/protocol";
import { startHarness, type FakePage } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNIN_URL = "https://www.chase.com/sign-in";
const ACCOUNTS_URL = "https://www.chase.com/accounts";
const OVERVIEW_URL = "https://www.chase.com/accounts/overview";

function bankPage(bannerAfterClick: string | null): FakePage {
  return {
    title: "First Meridian Bank",
    html: readFileSync(join(HERE, "../fixtures/bank.html"), "utf8"),
    onShow: (doc) => {
      if (bannerAfterClick === null) return;
      doc.getElementById("signin-btn")?.addEventListener("click", () => {
        doc.getElementById("banner")!.textContent = bannerAfterClick;
      });
    },
  };
}

describe("fake-model harness — sensitive site (M3-5)", () => {
  beforeEach(() => {
    fakeBrowser.reset(); // session site grants must not leak between scenarios
  });

  it(
    "cards the wire navigation, cards the mirror click, grants the site, then goes quiet",
    { timeout: 30_000 },
    async () => {
      const h = await startHarness({
        tabUrl: SIGNIN_URL,
        pages: {
          [SIGNIN_URL]: bankPage("Signed in attempt recorded"),
          [ACCOUNTS_URL]: bankPage("Signed in attempt recorded"),
          [OVERVIEW_URL]: bankPage(null),
        },
        mode: "auto",
      });
      try {
        await h.waitConnected();

        // 1. First action touching the sensitive domain → bridge guard card over
        //    the wire → scripted "once" → the navigate executes.
        h.answerNext("once");
        const first = await h.dispatch({ kind: "navigate", url: ACCOUNTS_URL });
        expect(first.status).toBe("ok");
        expect(h.wireCards).toHaveLength(1);
        expect(h.wireCards[0]!.reasonCodes).toContain("sensitive_site");
        expect(h.wireCards[0]!.siteDomain).toBe("chase.com");
        expect(h.tab.url).toBe(ACCOUNTS_URL);

        // 2. Click on the sensitive page → extension-side mirror card (the bridge
        //    passes clicks through; page facts only exist in the extension).
        h.answerNext("once");
        const click = await h.dispatch({ kind: "click", target: "#signin-btn" });
        expect(click.status).toBe("ok");
        expect(h.wireCards).toHaveLength(1); // click card never rides the wire
        expect(h.cards).toHaveLength(2);
        expect(h.cards[1]!.reasonCodes).toContain("sensitive_site");
        expect(h.tab.document.getElementById("banner")!.textContent).toBe(
          "Signed in attempt recorded",
        );

        // 3. A sensitive navigation re-cards even in auto; "site" grants the domain.
        h.answerNext("site");
        const grantNav = await h.dispatch({ kind: "navigate", url: OVERVIEW_URL });
        expect(grantNav.status).toBe("ok");
        expect(h.cards).toHaveLength(3);

        // 4. …and the NEXT navigation to the same registrable domain raises zero
        //    cards — grant suppression, bridge-side and mirror-side.
        const freeNav = await h.dispatch({ kind: "navigate", url: ACCOUNTS_URL });
        expect(freeNav.status).toBe("ok");
        expect(h.tab.url).toBe(ACCOUNTS_URL);
        expect(h.cards).toHaveLength(3);

        // 5. Even granted, typing into the page's password field is refused.
        const secret = await h.dispatch({ kind: "type", target: "#password", text: "hunter2" });
        expect(secret.status).toBe("denied");
        expect(secret.error).toBe(BLOCKED_SENSITIVE_TEXT);
        expect((h.tab.document.getElementById("password") as HTMLInputElement).value).toBe("");
        expect(h.cards).toHaveLength(3);
      } finally {
        await h.stop();
      }
    },
  );
});
