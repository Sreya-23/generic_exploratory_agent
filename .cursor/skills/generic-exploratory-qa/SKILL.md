
---
name: generic-exploratory-qa
description: >-
  Performs intelligent exploratory QA on web applications — edge cases, chaos
  testing, API probes, regression, and PRD-driven flows. Use when the user asks
  for exploratory testing, QA edge cases, chaos testing, test case discovery,
  PRD testing, regression testing, API testing, or stress testing any web app.
---

# Generic Exploratory QA

For **complete, site-nature-driven** exploration (all relevant tabs/fields, consent
before pay/transfer/send, fintech-careful policies), use the sibling skill
[site-nature-exploratory-qa](../site-nature-exploratory-qa/SKILL.md) instead of
(or in addition to) this generic matrix baseline.

## Quick Start

1. Determine input mode:
   - **PRD provided (optional)** → parse PRD → run **PRD-only** feature QA (see [PRD-Driven Protocol](#prd-driven-protocol-when-prd-uploaded))
   - **Context provided (no PRD)** → derive flows from description, then generic matrix
   - **Neither** → run Generic Baseline Protocol (below)

2. Ask for target URL and credentials only if needed (login wall detected).

3. Select exploration areas (default: UI + Chaos for smoke).

4. Execute flows, collect findings in report template format.

5. Export report using [report-template.md](report-template.md).

## Setup Chat Flow

The agent uses a simple conversational setup:

```
1. User pastes URL (and optionally uploads a PRD PDF via the upload control)
   → Agent auto-probes for auth type (password / OTP / OAuth / magic-link / SAML / none)
   → Agent asks exactly the right questions for that auth type

2. If login required: Agent asks for credentials specific to the detected login type
   (see Auth Types table below)

3. Session starts —
   - If PRD uploaded → parse PRD, merge into context, run PRD-only feature QA
   - If no PRD → login once, save session, run full matrix as before
```

### Optional PRD upload (UI)

| Entry point | How |
|-------------|-----|
| **Chat setup** (`/chat`) | File picker above the chat — `.pdf` (also `.md` / `.txt`) |
| **Classic setup** (`/setup`) | "PRD file (optional)" field |

PRD is **optional**. Without it, behaviour is unchanged (generic exploratory matrix).

---

## Authentication — Generalized for Any Site

The agent detects 8 login types and handles each correctly:

| Detected type | How detected | What agent asks | How it logs in |
|---|---|---|---|
| **password** | `input[type="password"]` + email/username field | `username: ...` + `password: ...` | Fills form, submits |
| **otp** | `input[type="tel"]` / phone field + no password | `phone: +91...` or `email: ...` | Fills phone → clicks Send → **pauses for OTP code** → fills code |
| **password-otp** | Password field + OTP field after submit | `username + password` → then OTP code | Two-phase: password → wait for OTP prompt → fill code |
| **magic-link** | "Send magic link" / "Email me a link" button | `email: ...` → then asks for the link URL | Triggers send → **pauses for user to paste link URL** → navigates to it |
| **oauth** | "Continue with Google/Apple/Facebook/Microsoft" button | Asks user to paste cookies from DevTools | Injects cookies into browser context, reloads |
| **saml** | "Enterprise SSO / SAML" button | Asks for cookies or bearer token from DevTools | Injects into context |
| **api-key** | — | `api-key: ...` | Sends as header |
| **bearer** | — | `bearer: ...` | Sends as Authorization header |

### OTP login flow (phone-based, e.g. cofee.life)
```
1. Agent fills phone number in the field
2. Clicks "Continue / Send OTP"
3. Pauses → asks in live chat: "OTP sent. Reply with: otp: 123456"
4. User reads phone and types otp: 123456 in chat
5. Agent fills OTP field → clicks Verify → session saved
6. All 51 tasks now start already logged in (no re-login)
```

### OAuth/Google login flow (e.g. Gmail, social sites)
```
1. Agent detects OAuth button, cannot automate Google's IdP
2. Asks: "Log in manually in Chrome, then paste cookies from DevTools → Application → Cookies"
3. User pastes: cookies: session=abc123; csrf_token=xyz
4. Agent injects cookies → reloads → verified as authenticated
5. All tasks run from authenticated session
```

### RULE: Login happens ONCE per session
- A shared `auth-state.json` file stores cookies + localStorage after successful login
- Every subsequent task RESTORES this state instead of re-logging in
- This means OTP-based sites work correctly — only one OTP request per session

---

## Sensitive Data & External Communication Policy

### RULE: No random data for sensitive fields — EVER

The agent classifies every input field before filling it:

| Risk level | Field patterns | Agent behaviour |
|---|---|---|
| **HIGH-RISK** | recipient, send-to, whatsapp, SMS, message-to, invite-email, subject | **Skip entirely** — never fill with random data |
| **SENSITIVE** | email, phone, address, card number, bank account, PAN, Aadhar | Skip random data; only test empty-submit validation |
| **SAFE** | name, search, title, notes, description, quantity | Use safe placeholder values for testing |

### RULE: Gate all Send/Share/Invite/Pay actions

Before clicking any button whose label contains these words, the agent pauses and asks in live chat:

| Button label pattern | Action type | Agent asks in chat |
|---|---|---|
| Send, Forward, Message, Email, WhatsApp, SMS | `send_link` | "Provide recipient: `recipient: phone/email`" |
| Pay, Transfer, Send money | `payment` | "Provide confirmation: `confirm: yes`" |
| Place order, Submit order | `purchase` | "Provide confirmation: `confirm: yes`" |
| Share link, Invite | `send_link` | "Provide recipient: `recipient: phone/email`" |

If the user doesn't respond, the action is **skipped** and a finding is logged:
`"Action skipped — sensitive communication action requires user confirmation"`

**User can explicitly skip** by replying with any of:
`skip` / `no` / `cancel` / `ignore` / `don't` / `not now` / `pass`

→ Agent replies: "⏭️ Got it — skipping that action. Moving on to the next test."
→ The skip flag is consumed after one use — next sensitive gate asks again independently.

### What runs automatically (no user input needed)

After the URL is given and start is clicked, the agent runs ALL of these:
- **UI & Interaction** (A1–A13): navigation, forms, viewport, autofill, file upload, pagination, wizard, real device matrix (iPhone/iPad/Pixel/Galaxy Tab), AI visual QA review (optional — needs `GEMINI_API_KEY` in `.env`, silently skipped otherwise)
- **Navigation & Session** (B1–B7): back/forward, deep links, session timeout, multi-tab logout
- **Network & Chaos** (C1–C6): slow network, offline, flaky network, WebSocket disconnect
- **API** (D1–D7): CRUD, auth matrix, rate limiting, idempotency
- **Accessibility** (E1–E3): labels/alt text, keyboard focus visibility, colour contrast (WCAG AA)
- **Security** (F1–F5): IDOR, privilege escalation, XSS, mass assignment
- **Performance** (G1–G3): spike load, large payload, N+1 patterns
- **Regression** (H1–H3): golden path snapshots, visual regression, schema drift

> **Element integrity & dead links** (not in the A–H matrix numbering, run under `ui`): occlusion
> (an interactive element blocked by an overlapping element), disabled-state visual/actual mismatch,
> zero-size/off-screen tabbable elements, mobile touch-target size, and same-origin dead-link (4xx/5xx)
> checks. See [element-integrity.ts](../../../packages/explorer-ui/src/flows/element-integrity.ts) and
> [dead-links.ts](../../../packages/explorer-ui/src/flows/dead-links.ts).

### Power-user: select specific tests

Users can pick tests by matrix ID if needed (not required for normal use):
- Say **"list tests"** → shows all test IDs
- Say **"run A6, B2, C4"** → runs only those tests
- Say **"run all"** → forces full matrix (same as default)

### Selecting Tests by Matrix ID

Users can pick specific tests from the exploration matrix using their IDs:

```
"run A6, B2, F2"              → run viewport, forward-after-back, horizontal privilege
"run C4, C5, C6"              → run all chaos network flows
"run all"                     → run the complete matrix
"list tests"                  → display all available test IDs
```

Matrix IDs map to these flow classes:

| Section | IDs | Flow classes |
|---------|-----|-------------|
| UI & Interaction | A1–A15 | navigation, form-validation, input-boundary, double-click, keyboard-nav, viewport, modal-lifecycle, empty-states, error-ui, autofill, file-upload, pagination-ui, wizard, `device-matrix` (real iPhone/iPad/Pixel/Galaxy Tab emulation — not just resized viewport), file-upload-security 📋, i18n-rtl 📋 |
| Navigation & Session | B1–B9 | back-during-post, forward-after-back, refresh-during-request, deep-link, session-timeout, multi-tab-logout, concurrent-write 📋 |
| Network & Chaos | C1–C6 | slow-network, offline-mid-request, offline-recovery, flaky-network, timeout-retry, websocket-disconnect |
| API | D1–D11 | crud, auth-matrix, idempotency, pagination, rate-limit, token-expiry 📋, csrf-probe 📋, graphql-probe 📋 |
| Security | F1–F9 | idor-probe, horizontal-privilege, vertical-privilege, xss-probe, mass-assignment, security-headers (also covers cookie-flags + clickjacking-probe — one flow, one response's headers + cookie jar), open-redirect 📋 |
| Performance | G1–G3 | spike-load, large-payload, n-plus-one |
| Regression | H1–H3 | golden-path, visual-regression, schema-drift |
| Accessibility | E1–E3 | labels, keyboard, contrast — 📋 **planned, no handler yet; falls back to `navigation`** |
| Business Logic | I1–I4 | `business-logic-boundary` covers price-tamper/negative-value (I1/I2): discovers amount/price/quantity-like fields, fills negative/zero/oversized/decimal-precision values, checks for inline validation feedback WITHOUT ever clicking submit (avoids risking a real mutation on a live system). coupon-abuse, date-boundary-logic — 📋 still planned, no handler yet |

### What the agent accepts as credentials / inputs

| Input | Example |
|-------|---------|
| Login | `username: admin`, `password: secret` |
| OTP | `otp: 123456` |
| API key | `api-key: sk-abc123` |
| Phone | `phone: +91 9876543210` |
| Card number | `card: 4111111111111111` |
| Account ID | `account: ACC_001` |
| Any custom field | `merchant-id: M_xyz`, `referral: REF123` |

All extra inputs are stored and used to fill matching form fields throughout the session.

### Flow instructions

Tell the agent specific paths to test in plain language. These run first, before generic flows:

```
"test the payment flow"
"send a link to +91 9876543210"
"try checking out as a guest"
"explore the refund path"
"verify that logout redirects to login"
```

## PRD-Driven Protocol (when PRD uploaded)

When a PRD file is uploaded, **do not** run the generic A1–H3 matrix.

```
URL + optional credentials
  ↓
parsePrd()              Extract features + constraints from PDF/md/txt
  ↓
Merge into context      Overview, feature list, constraints on SessionConfig.context
  ↓
buildPrdOnlyPlan()      Auth smoke gate + for each feature (max 12):
                          • happy path (with verified assertions)
                          • negative / empty / invalid
                          • interruption (back + refresh mid-submit)
  ↓
recon (light)           Map site so feature UI can be located
  ↓
prd-auth-smoke          Fail-fast: auth-state + post-login URL + not login wall
  ↓
prd-driven executor     Locate UI by intent → assert outcomes (not just "no crash")
  ↓
Coverage summary        Chat + report with Req ID → task ID → result traceability
```

### Per-feature QA (think like a QA engineer)

| Variant | What is exercised |
|---------|-------------------|
| **Happy** | Seed required state (e.g. cart), exercise feature, **assert** outcomes: inventory count, cart badge/line items, checkout-complete URL, logout → login form (do not mistreat login-page validation as logout failure) |
| **Negative** | Empty + wrong password + locked_out_user (login); empty cart / whitespace names / missing postal (checkout); inventory blocked after logout |
| **Interruption** | Back + refresh mid-flow; **pass/fail** on healthy recovery (document whether fields retained or cleared) |

**Auth landing (critical):** After one-time login, the agent saves `auth-state.json` **and** `post-login-url.txt`. Each task restores cookies and opens the post-login app URL (not the login page). If the target root is still a login form (e.g. Sauce Demo `/`), it tries `/inventory.html` and similar paths before testing. Login-related PRD features intentionally use the login page; other features must not be blocked by a false login-wall.

**Auth smoke gate:** Runs after recon. If session restore / post-login landing fails, remaining PRD feature tasks are **skipped** (status `skipped`) instead of producing shallow false passes.

**Traceability:** Each feature gets a requirement id (`F1`, `F2`, …; smoke = `SMOKE`) plus truncated acceptance criteria from the PRD. Findings and coverage rows include `requirementId` + `taskId`. Screenshots are named `{taskId}-{label}.png` (no overwrites).

**Reliability harness:** Each UI task has a **90s timeout**, **10s heartbeat logs** (“Still working…”), short locator timeouts, and interruption `goBack` that ignores `about:blank` (history seeding / recover — not HIGH).

**Finding hygiene:** Fingerprints enable **baseline diff** (new / fixed / recurring vs previous session for the same URL). Known demo quirks (e.g. Sauce empty-cart → step-one) are **quarantined** to info with an explicit reason.

**State setup:** Cart/checkout happy paths call `seedCart()` so tests start from a known non-empty cart. Inventory asserts sort when present; cart asserts remove + price labels; checkout asserts overview totals before Finish.

Sensitive / high-risk fields still follow the Sensitive Data policy (never random email/phone/card; gate Send/Pay).

### Coverage summary (required when PRD was given)

Emit in **live chat** and store on `state.prdCoverage` / session report:

- Features extracted from PRD (with F1…Fn ids)
- Constraints extracted
- Per feature × variant: status (`passed` / `failed` / `tested` / `gap` / `blocked` / `skipped`) + notes + requirementId + taskId
- Gaps: PRD feature mentioned, but no matching UI found
- Blocked: login wall or sensitive gate stopped the test
- Totals: passed / failed / gaps / blocked / skipped

Report endpoint: `GET /api/sessions/:id/report?format=md|json`

### No PRD → unchanged

If no PRD is uploaded, follow the Generic Baseline Protocol and full matrix exactly as before.

## Generic Baseline Protocol (No PRD)

```
Phase 1 — Recon:        Map URLs, forms, API calls, text signals
Phase 1.5 — Classify:   Identify site type from recon signals (see below)
Phase 2 — Journeys:     Run domain-specific user journeys for the classified site type
Phase 3 — Boundary:     Empty/invalid/max inputs on every form
Phase 4 — Interruption: Back/refresh during submit, double-click
Phase 5 — Auth:         Unauthenticated access probes
Phase 6 — Chaos:        Offline, slow network, recovery
Phase 7 — Report:       Dedupe, severity, repro steps
```

## Intelligence Pipeline — How the Agent Adapts to Any Site

The agent uses a 3-layer intelligence system so it can explore ANY site without hardcoded assumptions:

### Layer 1 — Recon & Signal Collection (`recon.ts`)

On every session, before any tests run, the agent reads:
- Page title, meta description
- All heading text (h1/h2/h3)
- All button labels
- All link text
- Input field types (date, password, search, etc.)
- URL paths from anchor tags
- Body text sample (first 1000 chars)

### Layer 2 — Site Classification (`classify-site.ts`)

Scores the collected signals against 7 site-type rules:

| Site type | Key signals | Journeys that follow |
|-----------|-------------|---------------------|
| `ecommerce` | "add to cart", "checkout", /cart /products in URLs | Catalog → Product → Cart → Checkout |
| `booking` | "book now", "check availability", date inputs | Search → Select → Details → Confirm |
| `saas-dashboard` | "dashboard", "workspace", "create new", sidebar URLs | List → Create → Edit → Delete → Settings |
| `auth-portal` | password input dominant + "sign in" text | Valid login → Invalid login → Logout → Redirect |
| `blog-cms` | "read more", "author", "category", "min read" | Browse → Open article → Search → Categories |
| `social` | "follow", "like", "feed", "profile", "notification" | Feed → Profile → Interact → Notify |
| `fintech` | "balance", "transfer", "transaction", "send money" | Balance → Transfer → History → Receipt |
| `generic` | no strong signals (score < 0.3) | Navigation + form validation only |

Confidence ≥ 0.3 → runs that site type's specific journey first, then all matrix tests.

### Layer 3 — Semantic Button Discovery (`findSemanticButton` in `journey.ts`)

Journeys don't rely on hardcoded English button text. For each intended action, the agent tries 4 strategies in order:

```
1. data-testid / data-test / data-action attributes  (framework-agnostic)
2. aria-label attributes                              (language-independent)
3. Button text — English + French, German, Spanish, Italian translations
4. CSS class-name patterns (btn-cart, buy-button, checkout-btn, cta)
```

This means the same journey works on an English Shopify, a German WooCommerce, or a custom React storefront with icon-only buttons.

### Layer 4 — BFS Site Traversal + API Endpoint Harvesting (`navigation.ts`)

After login, regardless of site type, the agent physically explores the entire UI AND captures all real API calls:

```
1. Click all reveal triggers (hamburger ≡, dropdowns, accordion toggles)
2. Collect all nav items from: aside, nav, header, sidebar, tabs, [role="navigation"]
   — both real <a href> links AND href-less <button>/[role="button"] items, since many
   React/Vue/Angular SPA sidebars route via a client-side router with no href at all
   (only [class*="sidebar"|"side-nav"|...] a[href] would find literally nothing on
   those sites — action-inventory's generic "any button" selector still would, which is
   the tell: if it finds far more clickables than navigation.ts finds nav items, this is
   almost certainly why)
3. Visit each page — href items via page.goto(url); href-less items by locating +
   clicking the same element (current page first, since persistent sidebars are on
   every page already; falls back to reloading the page it was discovered on only if
   not found on the current one) and letting the SPA's own router navigate.
   BFS, up to 25 pages, 3 levels deep (scales with session depth)
4. On each page:
   - Screenshot
   - Audit: broken images, blank content, JS console errors
     (href-less visits skip the HTTP-status check — no response object for a
     client-side route change — everything else still applies)
   - Capture all XHR/fetch network calls (same-origin only)
5. Discover new nav items on that page and add to queue.
   Href-less items dedupe by LABEL alone, not by page — a persistent nav item's
   destination doesn't depend on which page you clicked it from, so without this a
   3-item sidebar re-discovered on 3 pages turns into 9+ redundant re-visits of the
   same 3 destinations instead of 3.
6. Report all JS console errors collected across the full traversal
7. Write all captured real endpoints to ctx.discoveredApiEndpoints
```

### Layer 5 — API Executor uses real endpoints (not guesses)

After recon and navigation have run, `api-executor.ts` has a list of real endpoints:

```
Recon captures:  login API calls (e.g. POST /api/auth/verify-otp)
Navigation captures: app API calls (e.g. GET /api/v2/menu, POST /api/cart)
Both stored in: state.discoveredApiEndpoints (persisted across all tasks)

API executor receives: these real endpoints via ctx.discoveredApiEndpoints
resolveEndpointPaths() returns: real endpoints if available, generic guesses only as fallback
```

**Critical false-positive prevention — Content-Type check:**
- A 200 response from a React/Vue SPA for ANY path (e.g. `/api/admin`) returns HTML (`text/html`)
- This is the SPA's catch-all route serving `index.html` — NOT an exposed API endpoint
- The API executor ONLY flags a 200 response if `Content-Type: application/json` OR body starts with `{`/`[`
- HTML responses are silently skipped with a log: `→ 200 HTML (SPA catch-all) — not a real API endpoint`

**Public endpoint whitelist — never flagged as HIGH:**
- `/health`, `/api/health`, `/api/status`, `/ping`, `/api/ping`, `/status`
- These are intentionally public (monitoring/uptime checks) — flagging them HIGH is always wrong

### Confidence threshold

- ≥ 0.3 → use that site type's specific journeys
- < 0.3 → run `generic` journeys (navigate + validate forms)

## Exploration Areas

| Area | Focus |
|------|-------|
| UI | Navigation, forms, modals, keyboard, viewport |
| API | CRUD, auth matrix, pagination, boundaries |
| Chaos | Network failure, back mid-POST, double-submit |
| Security | IDOR, auth bypass, XSS probes |
| Regression | Golden path vs baseline |
| Accessibility | Labels, tab order, contrast — 📋 planned, currently falls back to navigation |
| Performance | Load time, rate limits |
| Business Logic | Price/quantity tampering, negative-value (`business-logic-boundary.ts`) — implemented; coupon abuse, date-boundary logic — 📋 still planned |

Full catalog: [exploration-matrix.md](exploration-matrix.md)

## Efficiency — The Actionability-Wait Trap (write new flows with this in mind)

Playwright's `.getAttribute()`, `.textContent()`, `.inputValue()`, `.click()`, and `.fill()`
all **auto-wait** for their locator to resolve to an attached element before running — if a
sub-locator (`el.locator('i, svg').first()`, `page.locator('label[for="x"]').first()`, etc.)
matches ZERO elements, the call doesn't fail fast: it blocks for Playwright's full default
actionability timeout (tens of seconds) before the surrounding `.catch()` ever fires. Found
and fixed in 5+ places this session (`element-matcher.ts`'s scoring, `describeElement()`,
`forms.ts`'s label lookup, `wizard.ts`'s back-button check, ~22 unguarded `.fill()`/`.click()`
calls in `prd-driven.ts`) — this was the actual root cause behind every "Domain Journey
timeout after 90s" finding seen across two completely different real sites, not a slow site
or a single bad flow. Verified fix: one specific hang went from 39.5s to 8.8s.

**When writing a new flow**, any locator that might legitimately not exist on the page:
- For a read (`getAttribute`/`textContent`/`inputValue`): check `.count() > 0` first (a
  plain, non-waiting DOM query) before calling the auto-waiting accessor.
- For an action (`click`/`fill`/`check`) that's expected to sometimes have nothing to act
  on: always pass an explicit `{ timeout: 2000 }`-ish value — never leave it to Playwright's
  default, even under a `.catch(() => {})`, since the TIME cost happens before the catch.

## Detection Logic — False Positive Prevention

Key rules baked into the flows to prevent noise:

| Situation | Rule |
|-----------|------|
| Login/auth-wall page | Skip nav-link check, form validation, viewport nav finding |
| Blank page on deep-link probe (B5) | Route doesn't exist — NOT an auth bypass; skip finding |
| Client-side router auth guard | Detected via `input[type="password"]` on destination — counts as protected |
| Error element with no text | Empty container (e.g. Sauce Demo) — ignored; only fire when text is present |
| Hamburger menus | `[class*="burger"]`, `[class*="hamburger"]`, small clickable in top 80px |
| Cookie-only clear (B6) | Phase 1 clears cookies only; if still authed → HIGH finding. Phase 2 clears storage too |
| Rapid-click on login form | Medium severity (not high — auth != transactional) |
| SPA catch-all returning HTTP 200 | React/Vue SPAs return 200 + HTML for every URL. API executor checks Content-Type — only `application/json` or JSON body counts as a real API endpoint. HTML response = logged and skipped |
| Public health endpoints (200 no auth) | `/health`, `/api/health`, `/status` etc. are intentionally public — never flagged as HIGH |
| Duplicate auth/privilege findings | `reportedAuthPaths` and `reportedPrivilegePaths` sets prevent same path being reported twice (auth-matrix and auth-bypass both run the same test) |
| HIGH-RISK form fields | Fields matching recipient/whatsapp/SMS/message-to patterns — never filled with any data |
| Sensitive form fields | email, phone, card, bank, PAN — no random data; only empty-submit validation |
| `targetUrl` includes login path | API executor always extracts `new URL(targetUrl).origin` — strips `/login`, `/signin` etc. |
| Cross-browser check on a login-gated site | Firefox/WebKit contexts load the SAME saved `auth-state.json` (+ sessionStorage) as the Chromium baseline before navigating — without this they always land on the login page while Chromium (already authenticated) reaches the real app, producing a "title differs: Login vs Dashboard" finding that's really just missing auth-sharing, not a real cross-browser bug |
| Viewport nav check on a wide/desktop layout | Also recognizes an already-expanded, persistent sidebar (`aside`/`[class*="sidebar"]` etc. with 2+ links/buttons) as valid navigation — not just a semantic `<nav>` tag, hamburger trigger, or small header icon. A full sidebar shown directly (no hamburger needed at tablet/desktop widths) was previously reported as "no navigation found" |
| Href-less sidebar/nav items (client-side router, no `<a href>`) | `navigation.ts`'s BFS also collects and clicks `button`/`[role="button"]` nav items, not just `a[href]` — re-locating on the current page first (persistent sidebars are on every page) before falling back to reloading the discovery page. Previously these were invisible to the crawl entirely ("Discovered 0 nav items" on a page with a real, working sidebar) |
| Generic matrix task with no matching surface on the landing page | `removeUnlikelyTasks` (planner) drops already-queued tasks recon gives clear negative evidence for (e.g. `file-upload` with zero `input[type=file]` seen) — frees a limited-depth task budget for checks more likely to find something, rather than spending a slot proving a non-existent feature doesn't work |
| Device/visual checks vs. a legitimate app-download gate, cookie banner, maintenance page, or empty state | `non-bug-patterns.ts` — a growing, named library of regexes for known-legitimate UI patterns. `device-matrix.ts` checks rendered text against it before flagging "content differs"; `visual-review.ts`'s Gemini prompt explicitly lists these categories as non-defects. Real incident: a real fintech site's phone-sized "please download our app" interstitial was misread as both "rendering/content differs on Pixel 7" (DeviceMatrix) and "empty white dashboard" (AI vision) before this fix |
| AI-vision screenshot taken mid-load (skeleton/loading state) | `waitForStableContent()` in `visual-review.ts` samples a cheap content-shape signal (text length + interactive-element count) twice, 1.2s apart, before screenshotting — if it's still changing, waits longer (bounded) rather than reviewing a page still mid-transition. Cheaper than a second Gemini call to self-verify |
| Confidence of findings from single-signal/AI-vision checks vs. multi-signal/objective ones | `Finding.confidence` (`'verified'` \| `'heuristic'`) + `confidenceReason` — surfaced as a badge in the HTML report and a line in markdown. `'verified'`: an unambiguous browser-native fact (`naturalWidth===0`, a thrown JS exception, an HTTP status) or multiple independent signals agreeing. `'heuristic'`: a single AI-vision read or single fuzzy pattern match — not necessarily wrong, but flagged for a human spot-check before being treated as confirmed |

## File Structure

```
packages/
  shared/src/
    types.ts                       # AuthMethod (8 types incl. oauth, magic-link, saml)
                                   # SessionCredentials: cookieString, magicLinkUrl, extras
                                   # SessionState.discoveredApiEndpoints (persisted across tasks)
                                   # ExecutorContext.discoveredApiEndpoints (injected per task)
                                   # PreActionRequest.type includes 'otp'
    constants.ts                   # FLOW_CLASSES (deduplicated), FLOW_TITLES
                                   # ALL_AREAS includes 'accessibility' (labels, keyboard, contrast)
  agent-core/src/
    intelligence/
      classify-site.ts             # classifySite(signals) → SiteClassification (7 site types)
    planner/index.ts               # buildGenericPlan — ALL_AREAS excludes accessibility by default
                                   # (no FLOW_HANDLERS yet; still selectable explicitly)
                                   # areaForFlow() handles accessibility area
                                   # removeUnlikelyTasks(): drops already-queued tasks recon
                                   #   gives clear negative evidence for (file-upload with no
                                   #   file input, pagination-ui with no pagination signal) —
                                   #   wired into the same onClassification callback that
                                   #   injects domain journeys, in run-session.ts
    orchestrator/run-session.ts    # performSessionLogin() called ONCE before tasks start
                                   # state.discoveredApiEndpoints persisted after each task
                                   # ctx.discoveredApiEndpoints injected into each task's context
                                   # onPreActionNeeded: honours _user_skip flag from live chat
                                   # writeSessionReport() on completion → report.md + report.html
    reporter/
      generate-report.ts           # Markdown + HTML report from findings (report-template format)
                                   # dedupeFindings(): exact-match, then near-duplicate merge
                                   #   (pageUrl+targetSelector match, else title token-overlap)
      index.ts                     # saveSessionState + writeSessionReport
  explorer-ui/src/
    auth/
      probe.ts                     # probeAuth(): detects password, otp, oauth, magic-link, saml
                                   # Uses waitUntil:'load' + 1.5s wait for SPA hydration
                                   # URL-path fallback (/login, /signin, /auth → requiresAuth=true)
      login.ts                     # performLogin(): routes to correct handler per authMethod
                                   # detectLoginWall(): checks tel/phone/mobile inputs + URL path
    ui-executor.ts                 # performSessionLogin(): runs ONCE, saves auth-state.json
                                   # OAuth: injects cookieString as browser cookies
                                   # Magic-link: navigates to magicLinkUrl
                                   # OTP: two-phase (fill phone → pause → fill code)
                                   # All tasks restore auth from auth-state.json (no re-login)
    flows/
      helpers.ts                   # isLoginWallPage(), findVisibleErrorText()
      recon.ts                     # collectIntelligenceSignals()
                                   # Captures XHR/fetch calls → ctx.discoveredApiEndpoints
                                   # Skips no-link finding on login walls
      navigation.ts                # BFS authenticated site traversal (25 pages, 3 levels deep)
                                   # Collects both a[href] AND href-less button/[role=button]
                                   #   nav items (client-side router SPAs) — clicks the latter
                                   #   directly instead of page.goto(), current-page-first
                                   # page.on('request') captures ALL real API calls during BFS
                                   # Writes captured endpoints → ctx.discoveredApiEndpoints
                                   # Clicks hamburger/sidebar/tabs, audits each page
                                   # JS console error collection across all pages
      cross-browser.ts             # Firefox/WebKit contexts load the same saved auth-state.json
                                   #   + sessionStorage as Chromium before navigating
      device-matrix.ts             # Real device emulation — real user-agent + hasTouch, not
                                   #   just a resized viewport on the same desktop engine.
                                   #   Catalog (depth-scaled 1→4→8): iPhone 13, iPad (gen 7),
                                   #   Pixel 7, Galaxy Tab S4 (standard, iOS+Android phone+
                                   #   tablet core) + iPhone SE (smallest common screen),
                                   #   iPhone 13 / iPad (gen 7) landscape, Galaxy Z Fold 6
                                   #   (foldable — distinct near-square aspect ratio) (deep).
                                   #   Flags content/render divergence vs desktop baseline,
                                   #   AND hover-only-reachable UI (dropdowns/tooltips shown
                                   #   only via CSS :hover) — genuinely unreachable with no
                                   #   mouse, which plain viewport resizing can't catch since
                                   #   desktop Chromium still supports synthetic hover
      visual-review.ts              # OPTIONAL, Gemini-vision-powered — catches rendering
                                   #   defects with NO DOM/CSS signal at all: overlapping
                                   #   text, off-screen/clipped elements, leftover "Lorem
                                   #   ipsum"/unresolved {{template}} copy, broken icon
                                   #   fonts, FOUC-style unstyled content. Screenshots
                                   #   already-captured pages, sends to Gemini's vision API
                                   #   with a 13-category checklist prompt, one JSON finding
                                   #   per issue found. Skipped entirely — logged, not
                                   #   thrown — if GEMINI_API_KEY (.env) is unset or the API
                                   #   call fails for any reason (bad key, rate limit,
                                   #   timeout, malformed response). Purely additive: every
                                   #   other flow runs unconditionally either way.
                                   #   Quota protection (checked BEFORE any API call, so a
                                   #   skip here costs nothing): only runs at standard/deep
                                   #   depth (never smoke/chaos); a daily call cap, default
                                   #   15/day across all sessions (GEMINI_VISUAL_REVIEW_
                                   #   DAILY_LIMIT); and a per-site-origin cooldown, default
                                   #   6h (GEMINI_VISUAL_REVIEW_COOLDOWN_HOURS) — re-testing
                                   #   the same site minutes apart won't burn a second call
                                   #   on UI that hasn't visually changed. Usage tracked in
                                   #   sessions/.gemini-visual-review-usage.json (shared
                                   #   across all sessions, not per-session).
      elementFingerprint()         # helpers.ts — stable-ish id/data-testid/name/tag+text+index
                                   #   fingerprint for a Locator, used for finding dedup
      journey.ts                   # 7 site-type journeys + generic fallback
                                   # findSemanticButton(): 4-strategy discovery (testid→aria→text→class)
                                   # Multi-language button text (EN/FR/DE/ES/IT)
                                   # gateIfSensitive(): pauses before Send/Share/Pay/Transfer/Invite
                                   # _user_skip flag honoured → skip action if user said "skip"
      forms.ts                     # classifyInputRisk(): HIGH-RISK/SENSITIVE/SAFE per field
                                   # Never fills HIGH-RISK fields (recipient, WhatsApp, SMS)
                                   # Skips random data for SENSITIVE fields (email, phone, card)
                                   # Skips form validation on login walls
      user-directed.ts             # plain-language instructions; pre-action gate
      keyboard.ts                  # clicks body before Tab (headless focus fix)
      double-click.ts              # 5-click rapid flood; cart badge + button disabled check
      viewport.ts                  # 9 sizes, depth-scaled (3→5→9): mobile/tablet/desktop
                                   #   (smoke) + small-mobile 320px, large-desktop 1920px
                                   #   (standard) + Bootstrap-style breakpoint edges 576/992/
                                   #   1200px, ultra-wide 2560px (deep) — breakpoint EDGES
                                   #   specifically, since a media-query off-by-one only
                                   #   shows up right at the threshold, not at round numbers
                                   #   like 375/768/1280 that sit comfortably inside a range.
                                   #   hamburger-aware; skips login walls; also recognizes an
                                   #   already-expanded persistent sidebar as valid nav (not
                                   #   just <nav>/hamburger/small header icon)
      session-flows.ts             # B5: collects real paths from authenticated session before clearing
                                   # B6: two-phase cookie test
      regression.ts                # H1/H3 — golden path snapshots, visual regression
      security-headers.ts          # F6/F7/F8 — CSP/HSTS/X-Content-Type-Options/Referrer-Policy,
                                   #   cookie httpOnly/secure/SameSite flags, clickjacking exposure
      business-logic-boundary.ts   # I1/I2 — amount/price/quantity field boundary testing
                                   #   (negative/zero/oversized/decimal-precision), never submits
  chaos-engine/src/
    chaos-executor.ts              # C4 flaky-network, C5 timeout-retry, C6 websocket-disconnect
  explorer-api/src/
    api-executor.ts                # baseUrl = origin only (strips /login path)
                                   # resolveEndpointPaths(): uses ctx.discoveredApiEndpoints first,
                                   #   falls back to generic guesses only if nothing discovered
                                   # Content-Type check: only flags JSON responses (not SPA HTML)
                                   # PUBLIC_ENDPOINTS whitelist: /health, /api/health etc. never HIGH
                                   # reportedAuthPaths / reportedPrivilegePaths: dedup across tasks
  chat-agent/src/
    setup-chat.ts                  # MATRIX_ID_MAP, extractMatrixIds
    auth-chat.ts                   # authPromptFromProbe(): type-specific prompts per auth method
                                   # parseAuthFields(): cookies:, magic-link:, phone: support
    live-chat.ts                   # parseExtras(): key:value pairs for pre-action data
                                   # Skip detection: "skip"/"no"/"cancel" → sets _user_skip flag
                                   # Clears _user_skip when user later provides data
```

## Build & Dev

```bash
# After any code change — MUST build before running dev:
npm run build

# Then start dev server:
npm run dev
# UI: http://localhost:5173   API: http://localhost:3001
```

The API (`tsx watch`) imports from compiled `dist/` folders of all packages.
`npm run dev` does NOT watch `explorer-ui`, `explorer-api`, `agent-core`, or `shared` —
always run `npm run build` first after changes to those packages.

## High-Value Scenarios (Often Missed)

Prioritize these — manual QA and brittle scripts miss them:

- Browser **back during POST**
- **Offline** between request and response
- **Double-click submit** on slow 3G
- **Logout in tab B** while tab A submits
- **Refresh** on wizard step 2 of 4
- **Session timeout** after long form fill
- **Optimistic UI** + failed API rollback

## Output

Every finding MUST use the template in [report-template.md](report-template.md).

When a session completes, the agent:
1. Dedupes findings in two passes: exact-match (severity+area+title+actual), then
   near-duplicate merging — same page + same target element (`pageUrl`+`targetSelector`,
   when a flow attaches them) merges regardless of wording/area/severity (keeping the
   higher severity), otherwise falling back to title token-overlap ≥60% within the same
   severity+area. This is what stops the same broken element, hit by two different flows
   with differently-worded findings, from being reported as two separate bugs.
2. Writes `report.md`, `report.html`, and `report-summary.json` under `sessions/<id>/`
3. Serves the report via `GET /api/sessions/:id/report?format=json|md|html`
4. Shows the Report page at `/report/:id` with Markdown/HTML export

Severity guide:
- **Critical**: data loss, security breach, payment duplicate
- **High**: broken core flow, duplicate submit
- **Medium**: poor error handling, missing validation
- **Low**: UX issues, minor a11y
- **Info**: observations needing manual verification

## Web UI

If the project has the exploratory agent app:

```bash
npm run dev
# Open http://localhost:5173
```

## Playwright MCP

When Playwright MCP is available, use it for UI exploration:
- `browser_navigate`, `browser_snapshot`, `browser_click`
- `browser_navigate_back` during in-flight actions
- `browser_network_requests` for API discovery

## Changelog — false positives and bugs found and fixed

Kept so the credibility story is traceable, not just asserted. Every `Finding` now carries
an optional `confidence: 'verified' | 'heuristic'` + `confidenceReason` — deterministic,
objective signals (a thrown JS exception, `naturalWidth===0`, an HTTP status) get `verified`;
a single AI-vision read or a single fuzzy pattern match gets `heuristic` and should be
spot-checked. See [non-bug-patterns.ts](../../../packages/explorer-ui/src/flows/non-bug-patterns.ts)
for the growing library referenced below.

- **App-download-gate misread as "empty/broken page"** — `device-matrix.ts`'s content-diff
  check and the Gemini visual-review prompt both flagged a real, sparse-but-intentional
  "please download our mobile app" interstitial as a rendering defect. Fixed by detecting the
  pattern (`non-bug-patterns.ts`) and instructing the Gemini prompt to recognize it, plus three
  more common patterns (cookie-consent banners, maintenance pages, generic empty states).
- **AI-vision findings caught mid-load** — a screenshot taken while the page was still
  hydrating could produce a "content failed to render" finding that would have resolved
  itself moments later. Fixed with `waitForStableContent()` in `visual-review.ts`: samples a
  coarse content-shape signal twice, 1.2s apart, and only screenshots once it stops changing
  (bounded wait, no extra API cost).
- **`ctx` field propagation was silently broken** — `UiExecutor.execute()` builds a
  `wrappedCtx` copy (`{...ctx, onFinding}`) per task; flows setting
  `wrappedCtx.discoveredApiEndpoints`/`postLoginUrl`/`actionInventory` were mutating that
  throwaway copy only. The orchestrator's post-task checks read the original `ctx`, which
  was never touched — real discovered API endpoints, the post-login URL, and action-inventory
  aggregation were no-ops. Fixed by copying fields back in `ui-executor.ts`, gated on
  reference-inequality (not just truthiness) against a snapshot taken before the flow ran.
- **Exponential `actionInventory` growth once the above was fixed** — the orchestrator builds
  each task's `ctx` FROM `state.actionInventory`, so `ctx.actionInventory` is truthy on every
  task after the first one that set it, regardless of whether that task's flow touched it. The
  merge block's `if (ctx.actionInventory)` guard alone re-ran on every subsequent task, and
  since `ctx.actionInventory === state.actionInventory` when unchanged, the entries concat
  became `[...X, ...X]` — doubling the array every task. Reached 2,097,152 entries (2^21) from
  one real candidate, a ~450MB session state that could no longer be JSON-serialized and
  crashed the session. Fixed in `run-session.ts` by snapshotting the pre-execute reference and
  only merging when it actually changed.
- **External links counted as "uncovered routes"** — the Coverage Report's `discoveredRoutes`
  (from `recon.ts`) included any link found on the landing page, including ones to a different
  domain entirely (e.g. a partner site or docs link). Fixed with a same-origin filter, so
  coverage only measures the app under test, not the sites it happens to link to.
- **`long-content.ts` never found the fields it was meant to stress-test** — its selector only
  matched `type="text"`/`type="search"`/untyped inputs and `<textarea>`, missing `type="tel"`,
  `type="number"`, `type="email"`, `type="password"`, and `type="url"` — common real-world
  types (e.g. a phone-number field) it silently never touched. Widened to cover all of them.
