import type { Page } from "playwright";
import type { BrowserChallenge } from "../../shared/computer-control";
import type { Control } from "./control";

type Signal = {
  cfMitigated?: string | null;
  text: string;
  visibleChallengeControl: boolean;
};
type Classification = Omit<BrowserChallenge, "requestId">;
/** Generic access denial and score-only blocks offer no actionable human challenge. */
export function classifyChallenge(signal: Signal): Classification | undefined {
  if (signal.cfMitigated?.trim().toLowerCase() === "challenge")
    return {
      kind: "cloudflare",
      reason: "A Cloudflare security challenge is showing on this page.",
    };
  if (
    signal.visibleChallengeControl &&
    /verify (?:that )?you (?:are|'re) (?:a )?human|confirm (?:that )?you (?:are|'re) (?:a )?human|i(?:'|’)m not a robot|complete (?:the|this) (?:captcha|security check)|select all (?:images|squares)|prove (?:that )?you (?:are|'re) (?:a )?human/i.test(
      signal.text,
    )
  ) {
    return {
      kind: "visible-challenge",
      reason: "A visible human-verification challenge is showing on this page.",
    };
  }
}

async function readSignal(
  page: Page,
  cfMitigated?: string | null,
): Promise<Signal> {
  if (cfMitigated?.trim().toLowerCase() === "challenge")
    return { text: "", visibleChallengeControl: false, cfMitigated };
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > 0 &&
        bounds.right > 0 &&
        bounds.top < innerHeight &&
        bounds.left < innerWidth
      );
    };
    const frames = Array.from(document.querySelectorAll("iframe[src]"));
    const challengeFrames = frames.filter((frame) => {
      const src = frame.getAttribute("src") ?? "";
      return (
        /(?:google\.com\/recaptcha|recaptcha\.net\/recaptcha|hcaptcha\.com\/|challenges\.cloudflare\.com\/)/i.test(
          src,
        ) && visible(frame)
      );
    });
    const controls = Array.from(
      document.querySelectorAll(
        'input[type="checkbox"], [role="checkbox"], button',
      ),
    );
    const visibleChallengeControl =
      challengeFrames.length > 0 ||
      controls.some(
        (control) =>
          visible(control) &&
          /human|not a robot|verify|captcha/i.test(
            control.getAttribute("aria-label") ??
              control.closest("label")?.textContent ??
              control.textContent ??
              "",
          ),
      );
    return {
      text: (document.body?.innerText ?? "").slice(0, 100_000),
      visibleChallengeControl,
    };
  });
}

/**
 * Try to clear the challenge with the browser itself: click the visible challenge control
 * (the checkbox or button), reaching inside a challenge iframe when it is same-origin.
 *
 * Returns true when a control was clicked. Cross-origin iframes cannot be reached from here;
 * the Bot's own snapshot/click tools can still drive them afterwards.
 */
async function selfSolveClick(page: Page): Promise<boolean> {
  try {
    const clicked = await page.evaluate(() => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.bottom > 0 &&
          bounds.right > 0 &&
          bounds.top < innerHeight &&
          bounds.left < innerWidth
        );
      };
      const labelOf = (element: Element): string =>
        element.getAttribute("aria-label") ??
        element.closest("label")?.textContent ??
        element.textContent ??
        "";
      const inFrames: Element[] = [];
      for (const frame of Array.from(document.querySelectorAll("iframe"))) {
        const src = frame.getAttribute("src") ?? "";
        if (
          !/(?:recaptcha|hcaptcha|challenges\.cloudflare\.com)/i.test(src) ||
          !visible(frame)
        )
          continue;
        try {
          const doc = (frame as HTMLIFrameElement).contentDocument;
          if (!doc) continue;
          inFrames.push(
            ...Array.from(
              doc.querySelectorAll(
                'input[type="checkbox"], [role="checkbox"], button',
              ),
            ).filter(visible),
          );
        } catch {
          // Cross-origin iframe: cannot reach inside from here.
        }
      }
      const topLevel = Array.from(
        document.querySelectorAll(
          'input[type="checkbox"], [role="checkbox"], button',
        ),
      ).filter(
        (control) =>
          visible(control) &&
          /human|not a robot|verify|captcha/i.test(labelOf(control)),
      );
      const target = inFrames[0] ?? topLevel[0];
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      // Let the widget verify and the page move past the challenge before looking again.
      await page.waitForTimeout(4000);
    }
    return clicked;
  } catch {
    return false;
  }
}

/**
 * Called only on navigate/read/snapshot.
 *
 * MONSTER REBUILD (owner order): a challenge is NEVER handed to the person. The Bot's own browser
 * loop owns it: the computer first tries to clear it itself by clicking the challenge control, and
 * whatever is still showing is reported back as the Bot's own work for its browser tools to drive.
 * No help request is created.
 */
export async function detectChallenge(
  page: Page,
  _control: Control,
  options: { cfMitigated?: string | null; toolCallId?: string } = {},
): Promise<BrowserChallenge | undefined> {
  let result = classifyChallenge(await readSignal(page, options.cfMitigated));
  if (!result) return undefined;
  await selfSolveClick(page);
  result = classifyChallenge(await readSignal(page, options.cfMitigated));
  if (!result) return undefined;
  return {
    kind: result.kind,
    reason: `${result.reason} The automatic solve attempt did not clear it; it stays with the Bot's own browser.`,
    // Synthetic: no person help request exists. Downstream handoff waits keyed on a person's
    // request must not treat this as one.
    requestId: `bot:${options.toolCallId ?? "challenge"}`,
  };
}
