// Consent & User Agreement Exploration — generic across wording, UI framework, and element
// type. Rather than "find checkbox → click checkbox," this discovers consent-like controls
// (checkboxes, toggles, cookie banners), classifies WHAT each is asking the user to agree to
// from its nearby text, EMPIRICALLY determines whether it's actually required to proceed (by
// observing the primary action button's enabled state, not by guessing from wording), and
// explores both paths — consent withheld and consent given — reporting when the app's
// gating behavior doesn't match what that consent type should require.
import type { Locator, Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

type ConsentKind =
  | 'terms-and-conditions'
  | 'privacy-policy'
  | 'marketing'
  | 'cookie'
  | 'age-declaration'
  | 'data-sharing'
  | 'generic';

interface ConsentControl {
  locator: Locator;
  label: string;
  kind: ConsentKind;
}

const KIND_KEYWORDS: Array<{ kind: ConsentKind; keywords: RegExp }> = [
  { kind: 'terms-and-conditions', keywords: /\bterms\b|\bconditions\b|\btos\b/i },
  { kind: 'privacy-policy', keywords: /\bprivacy\b/i },
  { kind: 'cookie', keywords: /\bcookies?\b/i },
  { kind: 'age-declaration', keywords: /\bage\b|\b18\+?\b|\badult\b|\bminor\b|\bbirth ?date\b/i },
  { kind: 'marketing', keywords: /\bmarketing\b|\bpromotion(al)?\b|\bnewsletter\b|\boffers?\b|\bupdates\b/i },
  { kind: 'data-sharing', keywords: /\bshare\b.*\bdata\b|\bdata\b.*\bshar/i },
];

function classifyConsentText(text: string): ConsentKind {
  for (const { kind, keywords } of KIND_KEYWORDS) {
    if (keywords.test(text)) return kind;
  }
  return 'generic';
}

/** Text most likely associated with a checkbox: its wrapping <label>, a sibling label[for],
 * or nearby text within the same list item/container. */
async function labelForCheckbox(page: Page, checkbox: Locator): Promise<string> {
  const wrapping = await checkbox
    .locator('xpath=ancestor::label[1]')
    .textContent()
    .catch(() => null);
  if (wrapping?.trim()) return wrapping.trim().slice(0, 200);

  const id = await checkbox.getAttribute('id').catch(() => null);
  if (id) {
    const forLabel = await page.locator(`label[for="${id}"]`).textContent().catch(() => null);
    if (forLabel?.trim()) return forLabel.trim().slice(0, 200);
  }

  const ariaLabel = await checkbox.getAttribute('aria-label').catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // Fall back to the nearest containing block's text (covers custom-styled consent rows
  // where the checkbox and its text are siblings, not wrapped in a real <label>).
  const container = await checkbox
    .locator('xpath=ancestor::*[self::div or self::li or self::p][1]')
    .textContent()
    .catch(() => null);
  return (container ?? '').trim().slice(0, 200);
}

/** Heuristic for "the button this page wants you to press next" — reused across both the
 * requiredness probe and the cookie-banner check. */
function primaryActionButton(scope: Page | Locator): Locator {
  return scope
    .locator(
      'button[type="submit"], input[type="submit"], ' +
        'button:has-text("Continue"), button:has-text("Submit"), button:has-text("Agree"), ' +
        'button:has-text("Accept"), button:has-text("Next"), button:has-text("Sign up"), ' +
        'button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Register"), ' +
        'button:has-text("Confirm")',
    )
    .first();
}

async function discoverConsentCheckboxes(page: Page): Promise<ConsentControl[]> {
  const checkboxes = page.locator('input[type="checkbox"], [role="checkbox"]');
  const count = await checkboxes.count().catch(() => 0);
  const controls: ConsentControl[] = [];

  for (let i = 0; i < count; i++) {
    const cb = checkboxes.nth(i);
    if (!(await cb.isVisible().catch(() => false))) continue;
    const label = await labelForCheckbox(page, cb);
    if (!label) continue; // no discoverable text — can't classify or report meaningfully
    // Only treat it as a consent control if the label actually reads like an agreement
    // ("I agree", "I accept", "I confirm") or matches one of the known consent topics —
    // a plain unrelated checkbox (e.g. "remember me") isn't consent and shouldn't be
    // reported as one just because it happens to be a checkbox.
    const looksLikeAgreement = /\bi agree\b|\bi accept\b|\bi confirm\b|\bi consent\b/i.test(label);
    const kind = classifyConsentText(label);
    if (!looksLikeAgreement && kind === 'generic') continue;
    controls.push({ locator: cb, label, kind });
  }
  return controls;
}

async function isChecked(cb: Locator): Promise<boolean> {
  const role = await cb.getAttribute('role').catch(() => null);
  if (role === 'checkbox') {
    return (await cb.getAttribute('aria-checked').catch(() => 'false')) === 'true';
  }
  return await cb.isChecked().catch(() => false);
}

async function setChecked(cb: Locator, checked: boolean): Promise<void> {
  const role = await cb.getAttribute('role').catch(() => null);
  if (role === 'checkbox') {
    if ((await isChecked(cb)) !== checked) {
      await cb.click({ timeout: 2000, force: true }).catch(() => {});
    }
    return;
  }
  // force: true — many custom-styled checkboxes render a visual SVG/icon overlay directly
  // on top of the native (visually hidden or zero-size) <input>, which fails Playwright's
  // real actionability check ("subtree intercepts pointer events") even though the checkbox
  // is genuinely usable to a real user clicking through the browser's native hit-testing.
  // Without force, check()/uncheck() times out and gets silently swallowed by the caller's
  // .catch(), leaving the checkbox untouched in EITHER state and making every requiredness
  // test compare "unchanged" against "unchanged" — always concluding "optional" regardless
  // of the real answer.
  if (checked) await cb.check({ timeout: 2000, force: true }).catch(() => {});
  else await cb.uncheck({ timeout: 2000, force: true }).catch(() => {});
}

const KIND_LABEL: Record<ConsentKind, string> = {
  'terms-and-conditions': 'Terms & Conditions',
  'privacy-policy': 'Privacy Policy',
  marketing: 'Marketing consent',
  cookie: 'Cookie consent',
  'age-declaration': 'Age declaration',
  'data-sharing': 'Data sharing consent',
  generic: 'Agreement checkbox',
};

/** Legally/UX-sensitive consent types that should never gate a core flow — bundling
 * "you must opt into marketing" with "continue using the product" is a common dark pattern
 * and often non-compliant with consent regulations (GDPR-style opt-in requirements). */
const SHOULD_NOT_BE_MANDATORY: ConsentKind[] = ['marketing'];
/** Consent types that legitimately gate access in most jurisdictions/products — a missing
 * gate here is a compliance-relevant finding, not just a UX nitpick. */
const SHOULD_TYPICALLY_BE_MANDATORY: ConsentKind[] = ['terms-and-conditions', 'age-declaration'];

/**
 * Fills any other visible, empty, non-consent input with a plausible value. The primary
 * action button is frequently gated by MULTIPLE required fields at once (e.g. "mobile
 * number filled AND terms checked") — if we only manipulate the consent controls and leave
 * an unrelated required field empty, the button stays disabled no matter what we do to the
 * checkbox, and the requiredness test would wrongly conclude "optional" for every control.
 * This isolates the consent checkbox's own marginal effect by removing every OTHER blocker.
 */
async function fillPlausibleValueForOtherFields(page: Page): Promise<boolean> {
  const candidates = page.locator(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="password"]',
  );
  const count = await candidates.count().catch(() => 0);
  let filledAny = false;
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const existing = await el.inputValue().catch(() => '');
    if (existing) continue;
    const type = (await el.getAttribute('type').catch(() => 'text')) ?? 'text';
    const nameHint = [
      await el.getAttribute('name').catch(() => ''),
      await el.getAttribute('placeholder').catch(() => ''),
      await el.getAttribute('id').catch(() => ''),
    ]
      .join(' ')
      .toLowerCase();
    // Many "mobile number" / "phone" fields are marked type="text" rather than type="tel",
    // and reject non-numeric input via site-side validation — matching on type alone picks
    // a generic alphanumeric placeholder that silently fails that validation, leaving the
    // button just as disabled as before and making this remediation a no-op.
    const looksLikePhone = /mobile|phone|contact number/.test(nameHint) || type === 'tel';
    const looksLikeEmail = /email/.test(nameHint) || type === 'email';
    const value =
      looksLikeEmail ? 'qa-explorer-test@example.com' :
      looksLikePhone || type === 'number' ? '9999999999' :
      type === 'password' ? 'Test1234!' : 'Test1234';
    await el.fill(value).catch(() => {});
    filledAny = true;
  }
  return filledAny;
}

async function exploreFormConsentCheckboxes(
  page: Page,
  ctx: ExecutorContext,
  pageUrl: string,
): Promise<{ tested: number; findings: number }> {
  const controls = await discoverConsentCheckboxes(page);
  if (controls.length === 0) return { tested: 0, findings: 0 };

  const actionBtn = primaryActionButton(page);
  const hasAction = (await actionBtn.count().catch(() => 0)) > 0;
  if (!hasAction) {
    ctx.onLog('[Consent] Found consent checkbox(es) but no primary action button to test gating against');
    return { tested: 0, findings: 0 };
  }

  // Baseline: tick everything so we have a known "fully consented" state, then test each
  // control's individual contribution by unticking just that one and observing the button.
  for (const c of controls) await setChecked(c.locator, true);
  await page.waitForTimeout(300);
  let fullyConsentedEnabled = await actionBtn.isEnabled().catch(() => false);

  if (!fullyConsentedEnabled) {
    const filledOther = await fillPlausibleValueForOtherFields(page);
    if (filledOther) {
      await page.waitForTimeout(300);
      fullyConsentedEnabled = await actionBtn.isEnabled().catch(() => false);
    }
  }

  if (!fullyConsentedEnabled) {
    ctx.onLog(
      '[Consent] Primary action stays disabled even with all consent controls granted and other fields filled — cannot isolate consent gating on this page',
    );
    return { tested: controls.length, findings: 0 };
  }

  let findingsCount = 0;
  const summaryLines: string[] = [];

  for (const control of controls) {
    await setChecked(control.locator, false);
    await page.waitForTimeout(300);
    const enabledWithoutThis = await actionBtn.isEnabled().catch(() => false);
    // Restore before evaluating the next control, so each test is isolated to just one
    // control's marginal effect rather than compounding across the loop.
    await setChecked(control.locator, true);
    await page.waitForTimeout(200);

    const isRequired = fullyConsentedEnabled && !enabledWithoutThis;
    const kindLabel = KIND_LABEL[control.kind];
    summaryLines.push(`${kindLabel} ("${control.label.slice(0, 40)}") — ${isRequired ? 'required' : 'optional'}`);

    if (isRequired && SHOULD_NOT_BE_MANDATORY.includes(control.kind)) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Consent',
        title: `${kindLabel} is mandatory to proceed — this consent type should typically be optional`,
        steps: [
          `Open ${pageUrl}`,
          `Leave "${control.label.slice(0, 60)}" unchecked`,
          'Observe the primary action button remains disabled',
        ],
        expected: `${kindLabel} should not gate access to the core flow (opt-in, not required)`,
        actual: `The primary action stays disabled until "${control.label.slice(0, 80)}" is checked`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
      findingsCount++;
    } else if (!isRequired && SHOULD_TYPICALLY_BE_MANDATORY.includes(control.kind)) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Consent',
        title: `${kindLabel} is NOT required to proceed — expected this to gate access`,
        steps: [
          `Open ${pageUrl}`,
          `Leave "${control.label.slice(0, 60)}" unchecked`,
          'Attempt to proceed anyway',
        ],
        expected: `${kindLabel} typically must be affirmatively accepted before continuing`,
        actual: `The primary action remains enabled even with "${control.label.slice(0, 80)}" unchecked`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
      findingsCount++;
    }
  }

  ctx.onFinding({
    severity: 'info',
    area: 'UI-Consent',
    title: `Consent exploration: ${controls.length} agreement control(s) found and tested on this page`,
    steps: [`Open ${pageUrl}`, 'For each consent control, toggle it and observe the primary action button'],
    expected: 'Coverage summary — not itself a bug',
    actual: summaryLines.join('; '),
    evidence: [],
    reproRate: 'N/A',
    automationCandidate: false,
  });

  ctx.onLog(`[Consent] Tested ${controls.length} consent control(s): ${summaryLines.join('; ')}`);
  return { tested: controls.length, findings: findingsCount };
}

async function exploreCookieBanner(
  page: Page,
  ctx: ExecutorContext,
  pageUrl: string,
): Promise<{ tested: number; findings: number }> {
  // Cookie banners are structurally different from form checkboxes — the banner's own
  // Accept/Reject buttons ARE the consent action, there's no separate "primary button" to
  // gate. Detect by a visible element mentioning cookies alongside an accept/reject control.
  const bannerCandidates = page.locator('[class*="cookie" i], [id*="cookie" i], [aria-label*="cookie" i]');
  const count = await bannerCandidates.count().catch(() => 0);
  let banner: Locator | null = null;
  for (let i = 0; i < count; i++) {
    const el = bannerCandidates.nth(i);
    if (await el.isVisible().catch(() => false)) {
      banner = el;
      break;
    }
  }
  if (!banner) return { tested: 0, findings: 0 };

  const rejectBtn = banner
    .locator('button:has-text("Reject"), button:has-text("Decline"), button:has-text("Manage"), button:has-text("Necessary only")')
    .first();
  const acceptBtn = banner.locator('button:has-text("Accept"), button:has-text("Allow"), button:has-text("Agree")').first();

  const hasReject = (await rejectBtn.count().catch(() => 0)) > 0;
  if (!hasReject) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Consent',
      title: 'Cookie banner offers no reject/decline option',
      steps: [`Open ${pageUrl}`, 'Inspect the cookie consent banner'],
      expected: 'Users should be able to reject non-essential cookies as easily as accepting them',
      actual: 'Only an accept-style action was found on the cookie banner',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
    ctx.onLog('[Consent] Cookie banner found, no reject option — flagged');
    return { tested: 1, findings: 1 };
  }

  // Explore the reject path: does the site still work afterward?
  const bodyBefore = await page.evaluate(() => (document.body?.innerText ?? '').length).catch(() => 0);
  await rejectBtn.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const bannerGone = !(await banner.isVisible().catch(() => false));
  const bodyAfter = await page.evaluate(() => (document.body?.innerText ?? '').length).catch(() => 0);

  ctx.onLog(
    `[Consent] Cookie banner: reject clicked, banner dismissed=${bannerGone}, content length ${bodyBefore}→${bodyAfter}`,
  );

  if (!bannerGone) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Consent',
      title: 'Cookie banner does not dismiss after rejecting',
      steps: [`Open ${pageUrl}`, 'Click Reject/Decline on the cookie banner'],
      expected: 'Banner disappears once a choice is made',
      actual: 'Cookie banner is still visible after clicking reject',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return { tested: 1, findings: 1 };
  }

  const hadAccept = (await acceptBtn.count().catch(() => 0)) > 0;
  ctx.onLog(
    `[Consent] Cookie banner exploration complete — accept option present: ${hadAccept}, reject path dismissed banner cleanly`,
  );
  return { tested: 1, findings: 0 };
}

export async function runConsentExploration(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const pageUrl = page.url();
  ctx.onLog('[Consent] Discovering and exploring consent/agreement controls on the page');

  const cookie = await exploreCookieBanner(page, ctx, pageUrl);
  const form = await exploreFormConsentCheckboxes(page, ctx, pageUrl);

  if (cookie.tested + form.tested === 0) {
    ctx.onLog('[Consent] No consent/agreement controls found on this page');
  }
}
