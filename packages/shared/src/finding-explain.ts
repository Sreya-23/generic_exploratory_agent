import type { Finding } from './types.js';

// Plain-English layer on top of a finding. Every check writes its finding in the language of the
// check itself ("not debounced — 3 requests", "CSP frame-ancestors", "UI-InputRetention"). That
// is exactly right for a developer reproducing it, and it stays in the report as the technical
// details — but someone triaging, a product owner, or a class reading the report should be able
// to understand each problem without knowing the jargon. This turns a finding into:
//   areaLabel     — a human name for where the problem is ("Shopping cart", not "UI-Cart")
//   headline      — one short sentence saying what is wrong
//   summary       — what happened, in everyday words
//   whyItMatters  — who is affected and how
// Deterministic (no AI call): rules per kind of finding, with a generic fallback built from the
// finding's own expected/actual text, so every finding gets an explanation.

export interface PlainExplanation {
  areaLabel: string;
  headline: string;
  summary: string;
  whyItMatters: string;
}

type F = Pick<Finding, 'area' | 'title' | 'expected' | 'actual' | 'severity'> &
  Partial<Pick<Finding, 'confidence' | 'pageUrl' | 'steps'>>;

const AREA_LABELS: Record<string, string> = {
  'ui-cart': 'Shopping cart',
  'ui-sort': 'Sorting',
  'ui-linktarget': 'Product / item links',
  'ui-inputretention': 'Form fields',
  'ui-images': 'Images',
  'ui-brokenimages': 'Images',
  'ui-dialog': 'Error pop-ups',
  'ui-jserror': 'JavaScript errors',
  'ui-rapidclick': 'Repeated clicks',
  'ui-dropdowns': 'Dropdown menus',
  'ui-touchtarget': 'Mobile tap targets',
  'ui-deadlinks': 'Links',
  'ui-actioninventory': 'Buttons and controls',
  'ui-elementintegrity': 'Buttons and controls',
  'ui-visual': 'Visual appearance',
  'ui-journey': 'User journeys',
  'ui-session': 'Login session',
  'security-session': 'Login session security',
  'ui-forms': 'Forms',
  'ui-fieldvalidation': 'Form validation',
  'ui-errorui': 'Error messages',
  'ui-accessibility': 'Accessibility',
  'ui-viewport': 'Screen sizes',
  'ui-navigation': 'Navigation',
  'ui-error': 'Agent run problem',
  'ui-environment': 'Agent setup',
  'regression-visual': 'Visual changes since last run',
  'regression-golden': 'Reference screenshots',
  'security-headers': 'Browser security settings',
  'security-xss': 'Script injection (XSS)',
  'security-privilege': 'Access control',
  'security-massassignment': 'Access control',
  'chaos-network': 'Unreliable network',
  'chaos-timeout': 'Slow server responses',
  'performance-spikeload': 'Heavy traffic',
  'performance-webvitals': 'Page speed',
  'devicematrix': 'Phones and tablets',
  'crossbrowser': 'Other browsers',
};

function areaLabel(area: string): string {
  const a = area.toLowerCase();
  if (AREA_LABELS[a]) return AREA_LABELS[a];
  if (a.startsWith('a11y-')) return 'Accessibility';
  if (a.startsWith('api-')) return `Server API — ${splitWords(area.slice(4))}`;
  if (a.startsWith('perf')) return 'Speed and performance';
  if (a.startsWith('chaos-')) return 'Unreliable network';
  const stripped = area.replace(/^(UI|Security|Regression|AI)-/i, '');
  return splitWords(stripped) || area;
}

function splitWords(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').trim();
}

const quoted = (s: string): string | null => s.match(/"([^"]{1,90})"/)?.[1] ?? null;
const firstLine = (s: string): string => s.split('\n')[0].trim();
const lc = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const stripEnd = (s: string): string => s.replace(/[.\s]+$/, '');

interface Rule {
  test: (f: F, area: string) => boolean;
  explain: (f: F) => Omit<PlainExplanation, 'areaLabel'>;
}

const RULES: Rule[] = [
  // ── Shopping cart ────────────────────────────────────────────────────────
  {
    test: (f, a) => a === 'ui-cart' && /^adding .* does not update the cart count/i.test(f.title),
    explain: (f) => {
      const item = quoted(f.title) ?? 'this item';
      return {
        headline: `"${item}" can't be added to the cart`,
        summary: `Clicking "Add to cart" for "${item}" did nothing: the cart count stayed the same and no message told the user anything went wrong.`,
        whyItMatters: 'Customers cannot buy this product, and many will not notice it never reached their cart. This directly loses sales.',
      };
    },
  },
  {
    test: (f, a) => a === 'ui-cart' && /^removing .* does not update/i.test(f.title),
    explain: (f) => {
      const item = quoted(f.title) ?? 'this item';
      return {
        headline: `"${item}" can't be removed from the cart`,
        summary: `Clicking "Remove" for "${item}" did not take it out of the cart.`,
        whyItMatters: 'Customers who change their mind are stuck with the item — they either abandon the purchase or buy something they did not want.',
      };
    },
  },
  {
    test: (f, a) => a === 'ui-cart' && /cart page does not match/i.test(f.title),
    explain: (f) => ({
      headline: 'The cart page shows different items from what was added',
      summary: `After adding items, the cart page does not list the same things. ${stripEnd(f.actual)}.`,
      whyItMatters: 'Customers may pay for the wrong items or miss items they wanted.',
    }),
  },
  {
    test: (f, a) => a === 'ui-cart' && /totals do not add up/i.test(f.title),
    explain: (f) => ({
      headline: 'The order total is calculated wrongly',
      summary: `On the order summary the numbers do not add up: ${stripEnd(f.actual)}.`,
      whyItMatters: 'Customers could be overcharged or undercharged — a billing error and a trust problem.',
    }),
  },
  {
    test: (f, a) => a === 'ui-cart' && /count changes when the cart page is opened/i.test(f.title),
    explain: () => ({
      headline: 'The cart count changes on its own when the cart is opened',
      summary: 'The number on the cart icon is different on the cart page from what it was on the product list.',
      whyItMatters: 'Customers cannot trust how many items they have, and may order the wrong quantity.',
    }),
  },
  // ── Sorting / dropdowns ──────────────────────────────────────────────────
  {
    test: (_f, a) => a === 'ui-sort',
    explain: (f) => {
      const all = f.title.match(/"[^"]+"/g);
      const opts = all && all.length > 0 ? all.join(', ') : 'some options';
      return {
        headline: 'Sorting the list does not work',
        summary: `Choosing ${opts} in the sort menu does not put the items in that order — the list stays as it was or is in the wrong order.`,
        whyItMatters: 'Shoppers sorting by price or name see a wrong order, so they may miss the cheapest product or think items are missing.',
      };
    },
  },
  {
    test: (f, a) => a === 'ui-dropdowns',
    explain: (f) => ({
      headline: /keyboard/i.test(f.title)
        ? 'The dropdown cannot be changed with the keyboard'
        : 'Choosing an option in the dropdown does not change it',
      summary: /keyboard/i.test(f.title)
        ? 'Pressing the arrow keys on the dropdown does not change the selected option.'
        : `Picking a different option leaves the dropdown on its old value (${stripEnd(f.actual)}).`,
      whyItMatters: 'Users cannot use this control as intended; keyboard-only users cannot use it at all.',
    }),
  },
  // ── Links / items ────────────────────────────────────────────────────────
  {
    test: (f, a) => a === 'ui-linktarget' && /price .* differs/i.test(f.title),
    explain: (f) => {
      const item = quoted(f.title) ?? 'an item';
      return {
        headline: `"${item}" shows a different price on its own page`,
        summary: `The list shows one price for "${item}", but its detail page shows another (${stripEnd(f.actual)}).`,
        whyItMatters: 'Conflicting prices confuse customers and can lead to disputes, refunds or lost trust.',
      };
    },
  },
  {
    test: (_f, a) => a === 'ui-linktarget',
    explain: (f) => {
      const item = quoted(f.title) ?? 'an item';
      const other = f.title.match(/different item \("([^"]+)"\)/)?.[1];
      return {
        headline: `Clicking "${item}" opens the wrong page`,
        summary: other
          ? `Clicking "${item}" in the list opens the page for "${other}" instead.`
          : `Clicking "${item}" in the list opens a page that is not about it (${stripEnd(firstLine(f.actual))}).`,
        whyItMatters: 'People land on the wrong product and may buy the wrong thing, or give up because they cannot reach the one they wanted.',
      };
    },
  },
  // ── Forms ────────────────────────────────────────────────────────────────
  {
    test: (_f, a) => a === 'ui-inputretention',
    explain: (f) => {
      const field = quoted(f.title) ?? 'a field';
      const elsewhere = /another field|different field|changed from/i.test(`${f.title} ${f.actual}`);
      return {
        headline: `Typing in "${field}" doesn't work`,
        summary: `Whatever the user types into "${field}" does not stay there${elsewhere ? ' — it ends up changing a different field instead' : ''}. ${stripEnd(f.actual)}.`,
        whyItMatters: 'The form cannot be filled in correctly: users get stuck on a "required" error they cannot fix, or the wrong details are saved.',
      };
    },
  },
  // ── Images ───────────────────────────────────────────────────────────────
  {
    test: (f, a) => a === 'ui-images' && /same image/i.test(f.title),
    explain: (f) => {
      const n = f.title.match(/^(\d+)/)?.[1] ?? 'Several';
      return {
        headline: `${n} different products all show the same picture`,
        summary: `${n} items with different names all load exactly the same image file, so the pictures do not match the products.`,
        whyItMatters: 'Customers cannot see what they are buying. It looks broken and makes people less likely to buy. (Check the screenshot — a few sites reuse one image on purpose.)',
      };
    },
  },
  {
    test: (_f, a) => a === 'ui-brokenimages',
    explain: (f) => ({
      headline: 'Some images do not load',
      summary: `Some pictures on the page fail to load and show as broken. ${stripEnd(f.actual)}.`,
      whyItMatters: 'Missing pictures make the page look broken and hide information users need.',
    }),
  },
  // ── Errors the user sees / the code throws ───────────────────────────────
  {
    test: (_f, a) => a === 'ui-dialog',
    explain: (f) => {
      const msg = quoted(f.title) ?? quoted(f.actual) ?? 'an error';
      return {
        headline: 'The site shows an error pop-up',
        summary: `During normal use the browser showed a pop-up saying "${msg}"`,
        whyItMatters: 'Something failed behind the scenes, and the user is interrupted by a technical message instead of the feature working.',
      };
    },
  },
  {
    test: (f, a) => a === 'ui-jserror' && /third-party resource failed/i.test(f.title),
    explain: (f) => {
      const host = f.title.match(/load: ([^/\s]+)/)?.[1] ?? 'another company';
      return {
        headline: `A third-party service (${host}) is failing`,
        summary: `The page tries to use a service run by another company (${host}), and that service rejects or fails the request.`,
        whyItMatters: 'Users are not affected directly. The site owners may be missing data from that service (for example, crash reports or analytics) without knowing it.',
      };
    },
  },
  {
    test: (f, a) => a === 'ui-jserror' && /^resource failed to load/i.test(f.title),
    explain: (f) => ({
      headline: /page itself|single-page-app/i.test(f.actual)
        ? 'A page returns an "error" code even though it works'
        : 'A file the page needs did not load',
      summary: /page itself|single-page-app/i.test(f.actual)
        ? 'The server answers this page with a "not found" (404) code, but the page still loads and works in the browser.'
        : `A file from the site's own server failed to load: ${stripEnd(firstLine(f.actual))}.`,
      whyItMatters: /page itself|single-page-app/i.test(f.actual)
        ? 'Users are not affected. Search engines and uptime monitors may think the page is broken.'
        : 'Part of the page may be missing or not work.',
    }),
  },
  {
    test: (_f, a) => a === 'ui-jserror',
    explain: (f) => {
      const msg = firstLine(f.title.replace(/^JS error:\s*/i, '').replace(/^Error:\s*/i, ''));
      const crashed = /uncaught exception/i.test(f.actual) || f.severity === 'high';
      return {
        headline: crashed ? `The page's code crashed: "${msg}"` : `The page's code reported an error: "${msg}"`,
        summary: crashed
          ? `While the agent was using the page, its JavaScript code stopped with the error "${msg}" and nothing caught it.`
          : `The page's JavaScript logged the error "${msg}".`,
        whyItMatters: crashed
          ? 'When code crashes like this, whatever the user was doing at that moment usually fails silently — a button does nothing, or part of the page does not appear.'
          : 'Usually a sign something on the page did not work as intended; developers should check it.',
      };
    },
  },
  // ── Rapid clicks ─────────────────────────────────────────────────────────
  {
    test: (f, a) => a === 'ui-rapidclick' && /not debounced/i.test(f.title),
    explain: (f) => {
      const label = quoted(f.title) ?? 'the button';
      return {
        headline: `Clicking "${label}" quickly sends it several times`,
        summary: `Clicking "${label}" several times in a row sends the action to the server again each time (${f.title.match(/— (.*)$/)?.[1] ?? 'several requests'}).`,
        whyItMatters: 'An impatient user could place the same order, payment or message more than once.',
      };
    },
  },
  {
    test: (f, a) => a === 'ui-rapidclick' && /cart count wrong|added \d+ items instead/i.test(f.title),
    explain: (f) => ({
      headline: 'Fast clicking puts the wrong number of items in the cart',
      summary: `After clicking "${quoted(f.title) ?? 'Add to cart'}" quickly several times, the cart count is wrong (${stripEnd(f.actual)}).`,
      whyItMatters: 'Customers end up with more (or fewer) items than they meant to order.',
    }),
  },
  {
    test: (f, a) => a === 'ui-rapidclick' && /stays enabled/i.test(f.title),
    explain: (f) => ({
      headline: `"${quoted(f.title) ?? 'The button'}" gives no "working…" feedback`,
      summary: 'After clicking, the button stays clickable and shows no loading state while the server is still working.',
      whyItMatters: 'Users think nothing happened and click again, which can repeat the action.',
    }),
  },
  // ── Security ─────────────────────────────────────────────────────────────
  {
    test: (f, a) => a === 'security-headers' && /header\(s\) missing/i.test(f.title),
    explain: (f) => ({
      headline: 'Standard browser security protections are switched off',
      summary: `The site does not send some standard security instructions that tell browsers how to protect users (${stripEnd(f.actual.replace(/^Missing:\s*/i, ''))}).`,
      whyItMatters: 'These are cheap, standard protections against attacks such as injected malicious scripts or being downgraded to an insecure connection. Nothing is broken today, but the doors are left unlocked.',
    }),
  },
  {
    test: (f, a) => a === 'security-headers' && /clickjacking/i.test(f.title),
    explain: () => ({
      headline: 'The site can be secretly embedded inside another website',
      summary: 'The site does not tell browsers to refuse being shown inside another website\'s frame ("clickjacking" protection).',
      whyItMatters: 'A malicious site could load this one invisibly and trick logged-in users into clicking buttons — for example "buy" or "delete" — without realising.',
    }),
  },
  {
    test: (f, a) => a === 'security-headers' && /cookie/i.test(f.title),
    explain: (f) => {
      const credential = /looks like a session credential/i.test(f.actual) && !/does not look/i.test(f.actual);
      return {
        headline: credential ? 'The login cookie is not properly protected' : 'A cookie is missing standard protection flags',
        summary: `Some cookies can be read by the page's scripts or sent over insecure connections (${stripEnd(f.actual)}).`,
        whyItMatters: credential
          ? 'If an attacker ever gets a script onto the site, they could steal this cookie and log in as the user.'
          : 'Low risk: this cookie does not appear to hold login details, but adding the flags is free hardening.',
      };
    },
  },
  {
    test: (f, a) => a === 'api-auth' && /unauthenticated access/i.test(f.title),
    explain: (f) => ({
      headline: 'Some site data can be read without logging in',
      summary: `The agent fetched data from the server without any login (${f.title.split(': ').pop()}).`,
      whyItMatters: 'Anyone on the internet could read this data. If it is private, this is a data leak.',
    }),
  },
  {
    test: (f) => /token accepted as valid|alg":"none" accepted/i.test(f.title),
    explain: () => ({
      headline: 'The server accepts fake login tokens',
      summary: 'The agent sent a made-up or unsigned login token and the server treated it as a real logged-in user.',
      whyItMatters: 'Attackers could pretend to be any user, including administrators.',
    }),
  },
  {
    test: (f) => /returns data for \d+ different IDs|inconsistent authorization/i.test(f.title),
    explain: () => ({
      headline: 'Changing a number in the address shows other records',
      summary: 'By changing the ID in a request, the agent could fetch other records — possibly ones belonging to other users.',
      whyItMatters: 'If those records are private, one user could read (or change) another user\'s data.',
    }),
  },
  {
    test: (f) => /mass assignment/i.test(f.title),
    explain: (f) => ({
      headline: 'Users can change protected fields on their own account',
      summary: `The server accepted a change to a field users should never control (${quoted(f.title) ?? 'a protected field'}).`,
      whyItMatters: 'A user could, for example, make themselves an administrator or give themselves credit.',
    }),
  },
  {
    test: (f) => /unescaped payload/i.test(f.title) || /^security-xss/i.test(f.area),
    explain: () => ({
      headline: 'Text a user enters can run as code on the page',
      summary: 'The agent submitted text containing script code, and the site sent it back without making it safe.',
      whyItMatters: 'An attacker could run their own code in other users\' browsers — stealing sessions or showing fake content (cross-site scripting).',
    }),
  },
  {
    test: (f, a) => a === 'api-ratelimit' || /rate limit/i.test(f.title),
    explain: (f) => ({
      headline: 'A sensitive action can be repeated without any limit',
      summary: `The agent could call ${f.title.split(': ').pop()} many times quickly without being slowed down or blocked.`,
      whyItMatters: 'Attackers can guess passwords or codes by brute force, or abuse the feature at scale.',
    }),
  },
  // ── Accessibility ────────────────────────────────────────────────────────
  {
    test: (f, a) => a === 'a11y-keyboard' && /focus indicator/i.test(f.title),
    explain: (f) => ({
      headline: 'You can\'t see where you are when using the keyboard',
      summary: `When moving through the page with the Tab key, the selected button or link is not highlighted (${f.title.match(/^(\d+)/)?.[1] ?? 'several'} elements).`,
      whyItMatters: 'People who use a keyboard instead of a mouse — including many people with disabilities — get lost on the page.',
    }),
  },
  {
    test: (_f, a) => a === 'a11y-contrast',
    explain: (f) => ({
      headline: 'Some text is too faint to read easily',
      summary: `Some text does not stand out enough from its background (below the accessibility minimum): ${stripEnd(f.actual)}.`,
      whyItMatters: 'Hard to read for people with low vision, older users, or anyone on a bright screen.',
    }),
  },
  {
    test: (f, a) => a.startsWith('a11y-') || a === 'ui-accessibility',
    explain: (f) => ({
      headline: stripEnd(f.title),
      summary: `An accessibility check failed: ${lc(stripEnd(f.actual))}.`,
      whyItMatters: 'People using screen readers, keyboards or other assistive tools may not be able to use this part of the site.',
    }),
  },
  {
    test: (_f, a) => a === 'ui-touchtarget',
    explain: (f) => ({
      headline: 'Some buttons are too small to tap on a phone',
      summary: `On a phone-sized screen these controls are smaller than the recommended minimum tap size: ${stripEnd(f.actual)}.`,
      whyItMatters: 'Mobile users miss them or tap the wrong thing.',
    }),
  },
  // ── Links / controls / visual ────────────────────────────────────────────
  {
    test: (f, a) => a === 'ui-deadlinks' && /work in the browser/i.test(f.title),
    explain: () => ({
      headline: 'Some pages return an "error" code even though they work',
      summary: 'Asking the server for these pages directly returns a "not found" (404) code, but the pages still load normally in the browser.',
      whyItMatters: 'Users are not affected. Search engines, link checkers and uptime monitors may treat these pages as broken.',
    }),
  },
  {
    test: (_f, a) => a === 'security-session',
    explain: (f) => ({
      headline: /ignored/i.test(f.title)
        ? 'The login cookie is set but not actually used'
        : 'The login is stored where page scripts can read it',
      summary: 'Clearing the browser\'s cookies did not log the user out; clearing its local storage did. So the login token lives in browser storage, not in a protected cookie.',
      whyItMatters: /ignored/i.test(f.title)
        ? 'Two login mechanisms that disagree are confusing and easy to get wrong — e.g. logging out may clear one but not the other.'
        : 'Nothing is broken today — this is a common design. But if an attacker ever manages to inject a script into the site (XSS), they could read this token and log in as the user; an httpOnly cookie would be out of their reach.',
    }),
  },
  {
    test: (f, a) => a === 'ui-deadlinks' && /to other sites/i.test(f.title),
    explain: (f) => ({
      headline: 'A link to another website leads to an error page',
      summary: `This site links out to a page that does not exist: ${stripEnd(f.actual)}.`,
      whyItMatters: 'The other website is fine — the address in this site\'s link is wrong. Users who click it land on a "page not found" screen.',
    }),
  },
  {
    test: (_f, a) => a === 'ui-deadlinks',
    explain: (f) => ({
      headline: 'Some links lead to an error page',
      summary: `These links on the site go to a page that does not work: ${stripEnd(f.actual)}.`,
      whyItMatters: 'Users hit a dead end and may think the site is broken.',
    }),
  },
  {
    test: (f, a) => a === 'ui-actioninventory' && /no visible effect/i.test(f.title),
    explain: (f) => ({
      headline: 'Some buttons do nothing when clicked',
      summary: `Clicking these controls produced no visible change at all: ${stripEnd(f.actual.replace(/^No visible change after clicking:\s*/i, ''))}.`,
      whyItMatters: 'Users think the site is broken, or that their click did not register.',
    }),
  },
  {
    test: (_f, a) => a === 'ui-visual',
    explain: (f) => ({
      headline: stripEnd(f.title.replace(/^(Visual issue|AI suggestion to check \(unconfirmed\)):\s*/i, '')),
      summary: f.confidence === 'verified'
        ? `An AI review of the screenshot spotted this, and the agent confirmed it by measuring the page: ${lc(stripEnd(f.actual))}.`
        : `An AI review of the screenshot suggests: ${lc(stripEnd(f.actual))}. The agent could not measure this itself — check the screenshot.`,
      whyItMatters: 'Visual problems make the site look broken or untrustworthy.',
    }),
  },
  {
    test: (_f, a) => a === 'regression-visual',
    explain: (f) => ({
      headline: 'The page looks different from last time',
      summary: `Compared with the saved reference screenshot from an earlier run, the page has changed: ${lc(stripEnd(f.actual))}.`,
      whyItMatters: 'If nobody meant to change the design, something in the layout broke. Compare the two screenshots.',
    }),
  },
  // ── Network / performance ────────────────────────────────────────────────
  {
    test: (f, a) => a === 'chaos-network' && /silently breaks/i.test(f.title),
    explain: () => ({
      headline: 'The page breaks silently when the connection is unreliable',
      summary: 'When some of the page\'s data requests fail (as on a weak mobile connection), content disappears and the user is not told anything or offered a retry.',
      whyItMatters: 'Users on poor connections see an empty or half-loaded page with no way to recover except reloading.',
    }),
  },
  {
    test: (f) => /slow (initial )?load|slow network|slow initial render|core web vital/i.test(f.title),
    explain: (f) => ({
      headline: 'The page is slow to load',
      summary: `${stripEnd(f.title)}. ${stripEnd(f.actual)}.`,
      whyItMatters: 'Slow pages lose visitors — many people leave if a page takes more than a few seconds.',
    }),
  },
  // ── Agent / informational ────────────────────────────────────────────────
  {
    test: (f) => f.severity === 'info' && /^golden snapshot captured/i.test(f.title),
    explain: (f) => ({
      headline: `Saved a reference screenshot of the "${f.title.split(': ').pop()}" page`,
      summary: 'The agent saved a screenshot of this page so the next run against this site and login can spot visual changes.',
      whyItMatters: 'For information only — not a bug.',
    }),
  },
  {
    test: (f) => f.severity === 'info' && /^action inventory:/i.test(f.title),
    explain: (f) => ({
      headline: 'Summary of the buttons and links the agent clicked',
      summary: stripEnd(f.actual).replace(/dom-change/g, 'changed the page').replace(/no-effect-expected/g, 'no effect (expected)').replace(/skipped-risky/g, 'skipped as risky').replace(/no-effect/g, 'no visible effect') + '.',
      whyItMatters: 'For information only — shows how much of the page was exercised.',
    }),
  },
  {
    test: (_f, a) => a === 'ui-error' || a === 'ui-environment',
    explain: (f) => ({
      headline: 'The agent could not finish one of its checks',
      summary: `This is about the testing run, not the website: ${lc(stripEnd(firstLine(f.actual)))}.`,
      whyItMatters: 'Not a website bug. That part of the site was not fully tested in this run.',
    }),
  },
  {
    test: (f, a) => a === 'ui-journey' && /^skipped/i.test(f.title),
    explain: (f) => ({
      headline: `Skipped: ${stripEnd(f.title.replace(/^Skipped:\s*/i, ''))}`,
      summary: 'The agent stopped before this step on purpose, because it would need real details (such as payment information) or would have a real effect.',
      whyItMatters: 'Not a bug — this step was not tested. Provide the details in the chat if you want it covered.',
    }),
  },
  {
    test: (f) => f.severity === 'info',
    explain: (f) => ({
      headline: stripEnd(firstLine(f.title)),
      summary: `${stripEnd(firstLine(f.actual))}.`,
      whyItMatters: 'For information only — not a bug.',
    }),
  },
];

/** Plain-English explanation of a finding (see the header comment). Never throws. */
export function explainFinding(f: F): PlainExplanation {
  const area = (f.area || '').toLowerCase();
  const label = areaLabel(f.area || 'General');
  try {
    for (const rule of RULES) {
      if (rule.test(f, area)) return { areaLabel: label, ...rule.explain(f) };
    }
  } catch {
    /* fall through to the generic explanation */
  }
  const expected = stripEnd(f.expected || '');
  const actual = stripEnd(firstLine(f.actual || ''));
  const why =
    f.severity === 'info'
      ? 'For information only — this is not a bug.'
      : f.severity === 'critical'
        ? 'Could stop users completing an important task, lose data, or expose private information.'
        : f.severity === 'high'
          ? 'Breaks an important part of the site for at least some users.'
          : f.severity === 'medium'
            ? 'Makes the site harder to use or gives wrong results, though users may find a way around it.'
            : 'A minor problem that is unlikely to stop anyone.';
  return {
    areaLabel: label,
    headline: stripEnd(firstLine(f.title)),
    summary: expected && actual ? `The agent expected: ${lc(expected)}. What actually happened: ${lc(actual)}.` : actual || expected,
    whyItMatters: why,
  };
}
