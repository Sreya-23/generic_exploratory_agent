# Exploration Matrix

Reference catalog for generic exploratory QA. Designed to work on **any website** — the agent adapts its exploration based on what it finds.

All tests run automatically when you provide a URL. Say **"list tests"** to see this list,
or pick tests by ID (e.g. `"run A6, B2, C4"`) for targeted runs.

Legend: ✅ Implemented & running | 🔄 Partial (limited coverage) | 📋 Planned (not yet implemented)

---

## How the Agent Adapts to Any Site

Before running any tests, the agent goes through a 4-layer intelligence pipeline:

```
1. RECON          Read page signals: title, buttons, links, inputs, URL paths, body text
      ↓
2. CLASSIFY       Score against 7 site-type rules (ecommerce / booking / saas /
                  auth-portal / blog / social / fintech / generic)
      ↓
3. JOURNEY        Run site-type-specific user flows first (using semantic button
                  discovery — works across languages and frameworks, not hardcoded English)
      ↓
4. MATRIX SWEEP   Run all A1–H3 tests on the discovered site structure
                  A1 navigation uses BFS traversal — clicks hamburger/sidebar/tabs,
                  visits up to 25 pages 3 levels deep, discovers all routes
```

### Site-type journeys (run before matrix tests)

| Classified as | Journey steps |
|---|---|
| **ecommerce** | Catalog → Product detail → Add to cart → Cart → Checkout |
| **booking** | Search/availability form → Select option → Fill details → Confirm |
| **saas-dashboard** | List entities → Create → Edit → Delete → Settings/profile |
| **auth-portal** | Valid login → Invalid login → Logout → Redirect check |
| **blog-cms** | Browse articles → Open article → Search → Browse by category |
| **social** | Feed → Profile → Follow/like → Create post → Notifications |
| **fintech** | Balance view → Transfer initiation → History → Receipt |
| **generic** | Navigation traversal + form validation only |

### Semantic button discovery (language & framework agnostic)

For each journey step, the agent finds buttons using 4 strategies in order:
1. `data-testid` / `data-test` / `data-action` attributes
2. `aria-label` attributes (language-independent)
3. Button text — English + French, German, Spanish, Italian
4. CSS class patterns (`btn-cart`, `buy-btn`, `checkout-btn`, `cta`)

---

## UI & Interaction

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| A1 | Happy path navigation | `navigation` | ✅ | BFS traversal — clicks hamburger/sidebar/tabs/dropdowns, visits up to 25 pages 3 levels deep, checks broken links, blank pages, JS console errors |
| A2 | Form validation | `form-validation` | ✅ | Empty submit (skips login walls), waits 800ms for async validation, uses `findVisibleErrorText` (ignores empty containers) |
| A3 | Input boundary | `input-boundary` | ✅ | 0, 1, max-1, max, max+1, negative, special chars, unicode, emoji |
| A4 | Double / rapid actions | `double-click` | ✅ | 5 rapid clicks (~60ms apart) on action buttons (Add to Cart, Delete, Pay, Send etc.); cart badge count before/after; button disabled-state check |
| A5 | Focus & keyboard | `keyboard-nav` | ✅ | Clicks body first (headless fix), Tab order, Escape on modals, focus trap detection |
| A6 | Scroll & viewport | `viewport` | ✅ | Mobile/tablet/desktop; hamburger-aware (`[class*="burger"]`, small top-bar elements); skips login walls |
| A7 | Modal lifecycle | `modal-lifecycle` | ✅ | Open, close via X, overlay click, Escape, browser back |
| A8 | Empty & loading states | `empty-states` | ✅ | Skeleton, spinner, empty lists |
| A9 | Error UI | `error-ui` | ✅ | `findVisibleErrorText` after submit; toast duration (8s); error clears after field correction |
| A10 | Copy/paste & autofill | `autofill` | ✅ | Browser autofill, paste behaviour, masked field detection |
| A11 | File upload | `file-upload` | ✅ | Wrong MIME type, 10MB+ file, empty file, cancel mid-upload |
| A12 | Pagination | `pagination-ui` | ✅ | Last page, jump pages, prev/next disabled states, refresh mid-scroll, search result-count consistency, sort-control reordering, filter-control narrowing |
| A13 | Multi-step wizard | `wizard` | ✅ | URL step-skip, back on step 3, data persistence across steps |
| A14 | Malicious file upload content | `file-upload-security` | 📋 | Double extension (`.jpg.exe`), script embedded in SVG, zip bomb, polyglot file — extends A11's MIME/size-only checks |
| A15 | Internationalization & RTL | `i18n-rtl` | 📋 | RTL layout rendering, bidi/non-Latin text input, locale-specific date/number formats |
| A16 | Empty-credential login boundary | — | ✅ | Submits the login/OTP form with every field left blank, in its own throwaway browser context before the real login runs. Zero real-account risk (no credential guess made, so it can never count against a lockout counter) — flags silent no-feedback submissions and, most importantly, blank credentials being accepted as valid. Not a scheduled matrix task: runs once from the orchestrator (`runEmptyCredentialLoginCheck` in `run-session.ts`) before `performSessionLogin`, so it has no `FLOW_CLASSES`/`FLOW_HANDLERS` entry. Deliberately does NOT test wrong (non-blank) credentials — that risks tripping the real site's own lockout/fraud-alert policy against a live account and was intentionally scoped out |

## Navigation & Session

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| B1 | Back during API call | `back-during-post` | ✅ | Orphan state, duplicate submit detection |
| B2 | Forward after back | `forward-after-back` | ✅ | Stale form resubmit, browser history edge cases |
| B3 | Refresh during request | `refresh-during-request` | ✅ | Double charge risk, partial state |
| B4 | Close tab mid-operation | — | 📋 | Requires browser-close hook (not possible in headless Playwright) |
| B5 | Deep link without context | `deep-link` | ✅ | Discovers real paths from site's own links first; also probes common guesses; only fires if page has >150 chars of content AND no login wall (catches client-side router guards) |
| B6 | Session timeout mid-flow | `session-timeout` | ✅ | **Two-phase**: Phase 1 clears cookies only (real-world expiry) — if still authenticated → HIGH finding (auth in localStorage). Phase 2 clears storage too — confirms where auth lives. Also checks leftover storage keys after logout |
| B7 | Logout in another tab | `multi-tab-logout` | ✅ | Two-context test; reloads tab 1 after tab 2 logs out |
| B8 | Bookmark stale URL | — | 📋 | Requires persisted session IDs from prior run |
| B9 | Concurrent edit / lost update | `concurrent-write` | 📋 | Two sessions/tabs edit the same resource simultaneously; checks for last-write-wins silently discarding one edit vs a conflict warning |
| B10 | Unexpected external redirect | `navigation` | ✅ | A link queued same-origin at discovery time (external links are filtered out of the BFS queue up front) that lands on a different domain after navigating — a genuine app-initiated redirect, not a link that was external to begin with. Heuristic: SSO/payment-gateway redirects are a common legitimate cause |
| B11 | Infinite redirect loop | `navigation` | ✅ | Browser-engine-detected redirect loop (ERR_TOO_MANY_REDIRECTS) during BFS traversal, surfaced as its own finding instead of a generic nav-failure log line |
| B12 | Orphan page (in sitemap, no discoverable link) | `coverage-report` | ✅ | Fetches sitemap.xml (+ any `Sitemap:` entries in robots.txt), compares each listed page against routes actually discovered by crawling — flags any with no discoverable link path |

## Network & Chaos

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| C1 | Slow network (3G) | `slow-network` | ✅ | Throttles to 3G, checks page load time and UI feedback |
| C2 | Offline mid-request | `offline-mid-request` | ✅ | Goes offline during form submit, checks error state |
| C3 | Offline → online recovery | `offline-recovery` | ✅ | Restores connection, checks if app recovers or needs manual refresh |
| C4 | Flaky network (50% drop) | `flaky-network` | ✅ | 50% request abort rate, checks for retry logic |
| C5 | Request timeout + retry | `timeout-retry` | ✅ | Delays all /api/** by 5s, monitors retry behaviour |
| C6 | WebSocket disconnect | `websocket-disconnect` | ✅ | Closes WS mid-session, checks reconnection |

## API

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| D1 | CRUD completeness | `crud` | ✅ | GET/POST/PUT/DELETE on discovered endpoints |
| D2 | Auth matrix | `auth-matrix` | ✅ | No token, expired token, wrong role — checks response codes |
| D3 | Idempotency | `idempotency` | ✅ | Duplicate POST — checks if server deduplicates |
| D4 | Pagination edge cases | `pagination` | ✅ | page=0, page=-1, page=99999, per_page=0 |
| D5 | Missing required fields | `boundary` | 🔄 | API probe only — sends empty bodies, checks for 400/422. Expanded far more thoroughly by D16 `malformed-input` (15 payload shapes including null/empty/wrong-type) — this entry kept for its original narrower scope |
| D6 | Type confusion | `boundary` | 🔄 | API probe only — sends wrong types (string for int etc.). Also expanded by D16 `malformed-input` |
| D7 | Rate limiting | `rate-limit` | ✅ | 20 rapid requests to target site's own endpoint (not local server); checks for 429 |
| D8 | Error shape consistency | — | 📋 | Needs API contract/schema to compare error formats |
| D9 | Token/clock-skew edge cases | `token-expiry` | 📋 | Near-expiry JWT, token expired by 1s, server tolerance for client clock skew |
| D10 | CSRF protection | `csrf-probe` | 📋 | State-changing request replayed without CSRF token / custom header / Origin check |
| D11 | GraphQL-specific probes | `graphql-probe` | 📋 | Introspection query exposure, batch-query cost abuse, query-depth limit bypass — only runs if a GraphQL endpoint is discovered |
| D12 | Response hygiene | `response-hygiene` | ✅ | Passive scan of responses already fetched for other checks: sensitive-data patterns (API keys, internal paths, stack traces) in JSON bodies, missing `Cache-Control` on per-user endpoints, absent request-tracing headers (observability note only) |
| D13 | HTTP method validation | `http-method-validation` | ✅ | OPTIONS + bodyless POST against confirmed GET endpoints only (never PUT/PATCH/DELETE — no mutation risk); flags 5xx crashes and silent 2xx acceptance of an unsupported method |
| D14 | Functional pagination & search correctness | `functional-listing` | ✅ | Distinct from D4 (which only checks invalid params don't crash) — verifies page 2 actually returns different records than page 1, declared total/count matches actual array length, and a guaranteed-no-match search term returns 0 results consistently |
| D15 | CRUD lifecycle & data consistency | `crud-lifecycle` | ✅ | Full create→get→update→get→delete→get chain on one self-created synthetic resource (never touches a pre-existing id); flags a created resource that isn't immediately readable, an update that reports success but isn't persisted, and a deleted resource still retrievable |
| D16 | Malformed input / request validation | `malformed-input` | ✅ | 15 malformed-payload shapes (null/empty/wrong-type/oversized/SQLi/NoSQLi/path-traversal) against discovered write endpoints; flags only 5xx server errors as confirmed defects — a clean 2xx/4xx is logged, not asserted wrong, since the real schema is unknown |
| D17 | Concurrency / race conditions | `concurrency` | ✅ | True-concurrency (`Promise.all`) probes: does an `Idempotency-Key` actually dedupe under simultaneous requests (catches a TOCTOU race that D3's sequential check can't), and do concurrent updates to the same resource ever corrupt it (final value matches none of the submitted values) rather than just "last write wins" |
| D18 | File/payload upload probing | `file-payload` | ✅ | Only runs against a path that looks upload-shaped (upload/file/avatar/attachment/image/document/media). Raw multipart POST: oversized file (5MB), path-traversal filename, dangerous `.php` extension — flags server crashes/timeouts; an accepted dangerous extension is logged as a manual-verification note, not asserted wrong (storage/serving config isn't visible to this check) |
| D19 | Async/background job operations | `async-operations` | ✅ | Conditional — only activates if a discovered endpoint actually returns 202 Accepted. Verifies the 202 contract itself: a trackable job id/Location/poll URL must be present, and polling it must resolve out of pending/processing within ~10s for a trivial synthetic payload |
| D20 | Token validation (invalid/malformed/expired/alg-none) | `token-validation` | ✅ | Sends a battery of fake bearer tokens (garbage, non-JWT-shaped, expired-shaped JWT) against protected endpoints, plus a JWT `alg:none` re-signing of the session's own real token — all must be rejected |
| D21 | Token refresh race | `token-refresh` | ✅ | Conditional — only runs if a refresh-shaped endpoint is discovered. Fires 2 simultaneous refresh calls on the real session, flags if both mint different new tokens |
| D22 | Error response consistency | `error-consistency` | ✅ | Compares the error-body shape (which field name: error/message/errors/etc) across endpoints, flags inconsistency; also scans for a leaked stack trace in any 4xx body |
| D23 | Status code validation (non-existent resource) | `status-code-validation` | ✅ | GET on a guaranteed-non-existent id should return 404, not 200 (phantom success) or 500 |
| D24 | Request ordering | `request-ordering` | ✅ | Two sequential (not simultaneous) rapid writes to the same self-created resource — the later one must win, not a slower-but-earlier one |
| D25 | State transition (API) | `state-transition-api` | ✅ | Conditional — only activates if the self-created resource exposes a status/state field. Flags an unconditional jump straight to a terminal state, and a crash on repeating the current state |
| D26 | CORS misconfiguration | (part of `response-hygiene`) | ✅ | Sends a foreign Origin header; flags a reflected/wildcard Access-Control-Allow-Origin combined with Access-Control-Allow-Credentials: true |
| D27 | ETag/conditional caching | (part of `response-hygiene`) | ✅ | If a response carries an ETag, a follow-up If-None-Match request must return 304 |
| D28 | Dependency failure (passive) | (part of `response-hygiene`) | ✅ | Opportunistic only — a 502/503/504 observed during routine exploration is surfaced; this agent cannot actively induce a downstream failure |
| D29 | Sort/filter functional correctness | (part of `functional-listing`) | ✅ | `sort=`/`order=` params must actually reorder results; a `?field=value` filter must only return matching items |
| D30 | CRUD lifecycle PUT coverage | (part of `crud-lifecycle`) | ✅ | PUT (full-replace) tested against the same self-created resource, alongside the existing PATCH/DELETE coverage |
| D31 | Duplicate upload | (part of `file-payload`) | ✅ | Uploads identical content twice in a row; flags a server crash, logs the outcome either way |
| D32 | Retry after client timeout | (part of `idempotency`) | ✅ | Simulates a client giving up (50ms timeout) then retrying with the same Idempotency-Key — flags if both the timed-out attempt and the retry created separate resources |
| D33 | Concurrent delete+update race | (part of `concurrency`) | ✅ | Fires DELETE and PATCH simultaneously on a fresh resource; flags a crash or a final state matching neither outcome |
| D34 | OpenAPI/Swagger-driven discovery | (part of `crud`/`boundary`) | ✅ | If `config.openApiUrl` is provided, parses its `paths` and merges them into the discovered-endpoint pool used by every other check; also tags high-risk endpoints (payment/delete/password/admin) |
| D35 | Response sensitive-data evidence + observability finding | (part of `response-hygiene`) | ✅ | Expanded sensitive-data patterns (SSN, unmasked card number); a systemic absence of request-tracing headers across ALL inspected responses is now a real low-severity finding, not just a log line |

**2026-10-06 (API checklist completeness pass):** closed the gaps identified in a 35-category API-testing-scenario audit. Every API finding across all 18+ check files now captures real request/response evidence (`writeApiEvidence`/`formatEvidence` in `probe-helpers.ts`, surfaced in the UI via a "View raw request/response" link in `FindingCard.tsx` — previously every API finding had `evidence: []` with no way to see the actual request/response behind it).

## Security

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| F1 | IDOR (change ID in URL) | `idor-probe` | ✅ | Manipulates resource IDs in API paths, checks cross-user access |
| F2 | Horizontal privilege | `horizontal-privilege` | ✅ | Same role, different user's resources |
| F3 | Vertical privilege | `vertical-privilege` | ✅ | Low-role user accessing admin endpoints |
| F4 | XSS in inputs | `xss-probe` | 🔄 | Basic payload injection; reflection check only |
| F5 | Mass assignment | `mass-assignment` | ✅ | Extra fields in POST body (role, isAdmin, price) |
| F6 | Security headers audit | `security-headers` | 📋 | Presence/misconfig of CSP, X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy |
| F7 | Cookie security flags | `cookie-flags` | 📋 | Secure / HttpOnly / SameSite attributes on session cookies |
| F8 | Clickjacking | `clickjacking-probe` | 📋 | Page frameable via iframe; missing frame-busting / CSP `frame-ancestors` |
| F9 | Open redirect | `open-redirect` | 📋 | Manipulate redirect/return-url query params to point at an external domain |
| F10 | Hidden route access | `hidden-route-access` | ✅ | Finds links present in the DOM but hidden/disabled from view, navigates their href directly in the same session, and flags it if the destination renders real content instead of a login wall or permission-denied message — a client-side-only authorization gap |

## Accessibility

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| E1 | Labels & ARIA | `labels` | ✅ | Flags form controls with no accessible label (`label[for]`/`aria-label`/`aria-labelledby`/`title`) and images missing `alt` |
| E2 | Keyboard access | `keyboard` | ✅ | Tabs through the page and flags focusable elements with no visible focus indicator (outline/box-shadow); distinct from `A5 keyboard-nav`, which covers Tab order/focus trap, not focus-visibility semantics |
| E3 | Colour contrast | `contrast` | ✅ | Computes WCAG AA contrast ratio (4.5:1 normal text, 3:1 large/bold) between visible text and its effective background colour |

## Performance

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| G1 | Spike load | `spike-load` | ✅ | 50 concurrent GET / — checks success rate and response time |
| G2 | Large payload | `large-payload` | 🔄 | Sends large JSON body; checks for timeout/truncation |
| G3 | N+1 UI pattern | `n-plus-one` | ✅ | Counts API calls on list page load; flags excessive per-item fetches |
| G4 | Cold start | — | 📋 | Needs infrastructure restart hook |

## Regression

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| H1 | Golden path snapshot | `golden-path` | ✅ | Full-page screenshot saved to `sessions/golden-snapshots/` as baseline |
| H2 | API schema drift | `schema-drift` | ✅ | Compares response shape against known endpoints; flags missing/added fields |
| H3 | Visual regression | `visual-regression` | ✅ | Pixel-diff against golden snapshot; reports if diff > threshold |

## Business Logic

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| I1 | Client-side price/total tampering | `price-tamper` | 📋 | Modify cart total/quantity/price via devtools or intercepted request before submit; server must recompute from source of truth, not trust the client value |
| I2 | Negative/zero quantity or amount | `negative-value` | 📋 | Submit -1 quantity, 0-amount transfer, negative discount — checks server-side bounds validation |
| I3 | Coupon/discount reuse or stacking | `coupon-abuse` | 📋 | Apply a single-use coupon twice, or stack discounts meant to be mutually exclusive |
| I4 | Expired / future-dated business logic | `date-boundary-logic` | 📋 | Book a past date, use an expired offer, select a date across a DST boundary |

---

## Not Implemented (📋 Planned)

| ID | Reason |
|----|--------|
| B4 | Requires hooking `beforeunload` — not reliable in headless Playwright |
| B8 | Needs session IDs persisted from a prior run to simulate stale bookmarks |
| D8 | Needs an API contract (OpenAPI/Swagger) to compare error shape against |
| G4 | Needs server-level restart/cold-start hooks outside the browser |
| A14, A15, B9, D9–D11, F6–F9, I1–I4 | New cases proposed 2026-07-15 — none have a `FLOW_CLASSES` entry, `FLOW_HANDLERS` implementation, or planner scheduling yet. Highest-value first builds: F6 (security-headers, cheap — one `page.on('response')` header read), I1 (price-tamper, catches real business-logic bugs), D9 (token-expiry, reuses existing auth-matrix plumbing) |

**2026-10-06: D3 (idempotency) and F6 (security-headers) were both discovered to be dead code** — present in `FLOW_CLASSES`/scheduled by the planner, but silently falling back to the generic `navigation` flow because no executor actually owned them (`idempotency` had no `FLOW_HANDLERS`-equivalent branch in `api-executor.ts`; `security-headers` is a UI-only check that lives under the `ui` executor, but the `security` area it's declared under is owned by `ApiExecutor`). Both are now genuinely wired: D3 got a real `testIdempotency` implementation, and a new `FLOW_CLASS_EXECUTOR_OVERRIDE` map in `run-session.ts` routes `security-headers` (and `golden-path`/`visual-regression`/`schema-drift`) to the correct executor without touching the `.areas` arrays. **D12–D19 above were added the same day**, covering Response Hygiene, HTTP Method Validation, Functional Pagination/Search, CRUD Lifecycle, Malformed Input, Concurrency, File/Payload probing, and Async Operations — all real `FLOW_HANDLERS`-equivalent branches in `api-executor.ts`, registered in `FLOW_CLASSES.api`/`FLOW_TITLES`, and bucketed into planner phase categorization (`boundary` or `report`).

**E1–E3 (accessibility) went ✅ and `accessibility` was re-added to `ALL_AREAS`** — see [accessibility.ts](../../../packages/explorer-ui/src/flows/accessibility.ts).

## Element integrity & dead links (not in the A–H matrix numbering, run under `ui`)

| Flow Class | Status | What it does |
|-----------|--------|--------------|
| `element-integrity` | ✅ | Flags interactive elements blocked by an overlapping element (occlusion via `elementFromPoint`), disabled-state visual/actual mismatches, and zero-size/off-screen elements still in the tab order |
| `touch-target` | ✅ | Flags interactive elements smaller than 44×44px at mobile viewport |
| `dead-links` | ✅ | Crawls same-origin links found on the page and flags any returning 4xx/5xx |
