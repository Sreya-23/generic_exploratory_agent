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
| A12 | Pagination | `pagination-ui` | ✅ | Last page, jump pages, prev/next disabled states, refresh mid-scroll |
| A13 | Multi-step wizard | `wizard` | ✅ | URL step-skip, back on step 3, data persistence across steps |

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
| D5 | Missing required fields | `boundary` | 🔄 | API probe only — sends empty bodies, checks for 400/422 |
| D6 | Type confusion | `boundary` | 🔄 | API probe only — sends wrong types (string for int etc.) |
| D7 | Rate limiting | `rate-limit` | ✅ | 20 rapid requests to target site's own endpoint (not local server); checks for 429 |
| D8 | Error shape consistency | — | 📋 | Needs API contract/schema to compare error formats |

## Security

| ID | Flow | Flow Class | Status | What it does |
|----|------|-----------|--------|--------------|
| F1 | IDOR (change ID in URL) | `idor-probe` | ✅ | Manipulates resource IDs in API paths, checks cross-user access |
| F2 | Horizontal privilege | `horizontal-privilege` | ✅ | Same role, different user's resources |
| F3 | Vertical privilege | `vertical-privilege` | ✅ | Low-role user accessing admin endpoints |
| F4 | XSS in inputs | `xss-probe` | 🔄 | Basic payload injection; reflection check only |
| F5 | Mass assignment | `mass-assignment` | ✅ | Extra fields in POST body (role, isAdmin, price) |

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

---

## Not Implemented (📋 Planned)

| ID | Reason |
|----|--------|
| B4 | Requires hooking `beforeunload` — not reliable in headless Playwright |
| B8 | Needs session IDs persisted from a prior run to simulate stale bookmarks |
| D8 | Needs an API contract (OpenAPI/Swagger) to compare error shape against |
| G4 | Needs server-level restart/cold-start hooks outside the browser |
