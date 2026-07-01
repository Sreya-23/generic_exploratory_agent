---
name: generic-exploratory-qa
description: >-
  Performs intelligent exploratory QA on web applications — edge cases, chaos
  testing, API probes, regression, and PRD-driven flows. Use when the user asks
  for exploratory testing, QA edge cases, chaos testing, test case discovery,
  PRD testing, regression testing, API testing, or stress testing any web app.
---

# Generic Exploratory QA

## Quick Start

1. Determine input mode:
   - **PRD provided** → extract flows, then apply generic matrix
   - **Context provided** → derive flows from description
   - **Neither** → run Generic Baseline Protocol (below)

2. Ask for target URL and credentials only if needed (login wall detected).

3. Select exploration areas (default: UI + Chaos for smoke).

4. Execute flows, collect findings in report template format.

5. Export report using [report-template.md](report-template.md).

## Setup Chat Flow

The agent uses a simple 3-step conversational setup:

```
1. User pastes URL
   → Agent auto-probes for auth (login wall detection)

2. If login required: Agent asks for credentials
   User replies with: username: admin   password: secret   otp: 123456
   Or provides extra site-specific inputs: phone: +91...   card: 4111...   account: ACC123

3. User says "start" (or clicks Start Exploration)
   → Agent runs ALL tests automatically — no test selection needed
```

### What runs automatically (no user input needed)

After the URL is given and start is clicked, the agent runs ALL of these:
- **UI & Interaction** (A1–A13): navigation, forms, viewport, autofill, file upload, pagination, wizard
- **Navigation & Session** (B1–B7): back/forward, deep links, session timeout, multi-tab logout
- **Network & Chaos** (C1–C6): slow network, offline, flaky network, WebSocket disconnect
- **API** (D1–D7): CRUD, auth matrix, rate limiting, idempotency
- **Security** (F1–F5): IDOR, privilege escalation, XSS, mass assignment
- **Performance** (G1–G3): spike load, large payload, N+1 patterns
- **Regression** (H1–H3): golden path snapshots, visual regression, schema drift

### Pre-action confirmation gates

Before any irreversible action, the agent pauses and asks in the live chat:

| Action | What agent asks |
|--------|----------------|
| Purchase / checkout | `card: 4111111111111111` |
| Send payment link | `phone: +91 9876543210` |
| Transfer funds | `phone: +91 9876543210` |
| Book / confirm reservation | Confirmation (no extra data needed) |
| Follow / interact (social) | Confirmation |

The user replies in the live chat with the requested data. The agent stores it and uses it for that and any future flows in the session.

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
| UI & Interaction | A1–A13 | navigation, form-validation, input-boundary, double-click, keyboard-nav, viewport, modal-lifecycle, empty-states, error-ui, autofill, file-upload, pagination-ui, wizard |
| Navigation & Session | B1–B7 | back-during-post, forward-after-back, refresh-during-request, deep-link, session-timeout, multi-tab-logout |
| Network & Chaos | C1–C6 | slow-network, offline-mid-request, offline-recovery, flaky-network, timeout-retry, websocket-disconnect |
| API | D1–D7 | crud, auth-matrix, idempotency, pagination, rate-limit |
| Security | F1–F5 | idor-probe, horizontal-privilege, vertical-privilege, xss-probe, mass-assignment |
| Performance | G1–G3 | spike-load, large-payload, n-plus-one |
| Regression | H1–H3 | golden-path, visual-regression, schema-drift |

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

### Layer 4 — BFS Site Traversal (`navigation.ts`)

After login, regardless of site type, the agent physically explores the entire UI:

```
1. Click all reveal triggers (hamburger ≡, dropdowns, accordion toggles)
2. Collect all nav items from: nav, header, sidebar, tabs, [role="navigation"]
3. Visit each page (BFS, up to 25 pages, 3 levels deep)
4. On each page: screenshot, audit for broken images / blank content / JS errors
5. Discover new nav items on that page and add to queue
6. Report all JS console errors collected across the full traversal
```

This catches pages that aren't linked from the homepage and nav items only revealed after interaction.

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
| Accessibility | Labels, tab order, contrast |
| Performance | Load time, rate limits |

Full catalog: [exploration-matrix.md](exploration-matrix.md)

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

## File Structure

```
packages/
  shared/src/
    types.ts                       # SiteType, SiteClassification, SessionCredentials.extras,
                                   # SessionConfig.flowInstructions/selectedFlowClasses, SetupDraft
    constants.ts                   # FLOW_CLASSES (deduplicated per area), FLOW_TITLES
                                   # security=[xss-probe only]; H1/H3 in regression only
  agent-core/src/
    intelligence/
      classify-site.ts             # classifySite(signals) → SiteClassification
    planner/index.ts               # buildGenericPlan — selectedFlowClasses, BFS phase assignment
                                   # 'report' phase covers H1/H2/H3, G1, rate-limit, idempotency
  explorer-ui/src/
    flows/
      helpers.ts                   # isLoginWallPage(), findVisibleErrorText() — shared utilities
      recon.ts                     # collectIntelligenceSignals(), skips no-link finding on login walls
      navigation.ts                # BFS authenticated site traversal — clicks hamburger/sidebar/tabs,
                                   # visits up to 25 pages 3 levels deep, JS error collection
      journey.ts                   # site-type-specific journeys; findVisibleErrorText for error detection;
                                   # two-phase credential verification before valid login test
      user-directed.ts             # plain-language instructions; pre-action gate for risky ops
      forms.ts                     # skips login-wall pages; findVisibleErrorText after 800ms wait
      keyboard.ts                  # clicks body first (headless focus fix); escape on modals
      double-click.ts              # 5-click rapid flood on action buttons (Add to Cart, Delete, Pay etc.);
                                   # cart badge count before/after; button disabled-state check
      viewport.ts                  # mobile/tablet/desktop; hamburger-aware; skips login walls
      error-ui.ts                  # findVisibleErrorText; toast duration check
      autofill.ts                  # A10 — paste, autofill, masked fields
      file-upload.ts               # A11 — wrong type, large file, empty file
      pagination-ui.ts             # A12 — last page, prev/next disabled states
      wizard.ts                    # A13 — URL skip, back navigation, data persistence
      session-flows.ts             # B2 forward-after-back, B5 deep-link (BFS path discovery +
                                   # content check before firing), B6 TWO-PHASE cookie test
                                   # (cookies-only first, then full storage), B7 multi-tab logout
      regression.ts                # H1/H3 — golden path snapshots, visual regression
    ui-executor.ts                 # FLOW_HANDLERS: all flows registered
  chaos-engine/src/
    chaos-executor.ts              # C4 flaky-network, C5 timeout-retry, C6 websocket-disconnect
  explorer-api/src/
    api-executor.ts                # rate-limit probes TARGET site (not local /api/health);
                                   # F2/F3 privilege, F5 mass-assignment, G1 spike-load,
                                   # G3 n-plus-one, H2 schema-drift
  chat-agent/src/
    setup-chat.ts                  # MATRIX_ID_MAP, extractMatrixIds, matrixTestList
                                   # Parses "run A6, B2" → selectedFlowClasses in draft
    auth-chat.ts                   # parseAuthFields, auth state machine (no username loop)
    live-chat.ts                   # parseExtras (key: value pairs), pre_action:required handler
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
