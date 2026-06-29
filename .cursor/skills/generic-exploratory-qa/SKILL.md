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

The agent always follows this conversational setup before starting:

```
1. User pastes URL
2. Agent asks: "Does this site need credentials or special inputs?"
3. User replies with one of:
   - "no" / "public" → skip auth
   - "yes" / credentials inline → collect username, password, OTP as needed
   - Extra inputs → phone: +91..., card: 4111..., account: ACC123
   - Flow instructions → "test the payment flow", "try sending a link to +91..."
4. Agent confirms everything and asks "start" or user clicks Start
```

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

## Site Classification

After recon, classify the site before running any flows. This drives the journey phase.

### Classifier — signals to check

| Signal type | Examples |
|-------------|---------|
| Button text | "Add to Cart", "Book Now", "Sign Up", "Create Project" |
| Link/nav text | "Products", "Reservations", "Dashboard", "Blog", "Transactions" |
| Form fields | Date pickers, guest counts, credit card fields, search bars |
| URL paths | `/cart`, `/checkout`, `/booking`, `/dashboard`, `/blog`, `/api/docs` |
| Page title / meta | "Shop", "Reserve", "Portal", "Dashboard", "Docs" |

### Site types and their journeys

| Site type | Detected when | Journeys to run |
|-----------|--------------|----------------|
| `ecommerce` | cart/checkout/product buttons present | Browse catalog → Product detail → Add to cart → Checkout flow → Order summary |
| `booking` | date pickers / availability / reservation forms | Search dates → Select option → Fill guest details → Confirm booking |
| `saas-dashboard` | sidebar nav / entity lists / CRUD buttons | List entities → Create → Edit → Delete → Verify state |
| `auth-portal` | login form is the primary/only form on landing | Login valid → reach home → Login invalid → verify error → Logout → verify redirect |
| `blog-cms` | article links / categories / reading time | Browse articles → Open article → Check reading flow → Test search |
| `social` | user profiles / feed / follow/like actions | Browse feed → Open profile → Interact → Verify state update |
| `fintech` | transaction/balance/payment UI | View balance → Initiate transfer → Verify confirmation → Check history |
| `generic` | no strong signals | Fall back to navigation + form validation |

### Confidence threshold

- ≥ 0.7 → use that site type's journeys
- < 0.7 → run `generic` journeys + log low-confidence classification

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

## File Structure

```
packages/
  shared/src/types.ts              # SiteType, SiteClassification, SessionCredentials.extras,
                                   # SessionConfig.flowInstructions, SetupDraft.credentialsAsked
  agent-core/src/
    intelligence/
      classify-site.ts             # classifySite(signals) → SiteClassification
    planner/index.ts               # buildPlan — user-directed tasks, journey tasks, prd tasks
  explorer-ui/src/
    flows/
      recon.ts                     # collectIntelligenceSignals() → SiteIntelligenceSignals
      journey.ts                   # runJourneyFlow(page, ctx, task) — dispatches by siteType
      user-directed.ts             # runUserDirectedFlow — follows plain-language instructions
                                   # fillExtras — fills custom inputs into matched form fields
    ui-executor.ts                 # FLOW_HANDLERS: journey, user-directed, recon, ...
  chat-agent/src/
    setup-chat.ts                  # Asks credentials upfront, collects extras, flow instructions
    auth-chat.ts                   # parseAuthFields, extractExtras
```

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
