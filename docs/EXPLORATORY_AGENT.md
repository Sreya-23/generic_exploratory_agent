# Exploratory Agent

> **Purpose:** Automatically explore a web application, identify unexpected behavior, and surface potential defects with reproducible evidence — without hand-written test cases.

**Status:** 🟢 Active Development
**Owner:** QA / Automation
**Repository:** `generic_exploratory_agent`
**Version:** `0.1.0`
**Last Updated:** 2026-09-08

---

## Table of Contents

1. [Overview](#1-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Agent Workflow](#3-agent-workflow)
4. [Core Components](#4-core-components)
5. [Exploration Strategy](#5-exploration-strategy)
6. [Configuration](#6-test--exploration-configuration)
7. [Bug / Finding Lifecycle](#7-bug--finding-lifecycle)
8. [Evidence & Reporting](#8-evidence--reporting)
9. [Technology Stack](#9-technology-stack)
10. [Project Structure](#10-project-structure)
11. [Setup & Installation](#11-setup--installation)
12. [Running the Agent](#12-running-the-agent)
13. [Example Exploration](#13-example-exploration)
14. [Limitations & Known Issues](#14-limitations--known-issues)
15. [Future Improvements](#15-future-improvements)
16. [Troubleshooting](#16-troubleshooting)
17. [FAQ](#17-faq)
18. [Glossary](#18-glossary)

---

## 1. Overview

### What is the Exploratory Agent?

The Exploratory Agent is a **project-agnostic QA agent**: give it a URL (and, optionally, some free-text context about the site), and it works out what kind of application it's looking at, how it logs in, and then runs a matrix of UI, API, chaos, security, accessibility, and performance probes against it — with no manually authored test cases.

- **What it does** — crawls a target site, classifies it (e-commerce, booking, SaaS dashboard, auth portal, blog/CMS, social, fintech, or generic), builds a task plan sized to a chosen depth, drives a real browser (and the site's HTTP API) through that plan, and files structured, deduplicated findings with screenshots and reproduction steps.
- **Why it was built** — writing and maintaining exploratory test scripts per-application doesn't scale, and exploratory testing is exactly the kind of open-ended, judgment-heavy work that benefits from a system that can reason about "what haven't I tried yet" rather than a fixed script.
- **What problem it solves** — catches the class of bugs that scripted regression suites miss by construction: edge cases, interruption/race conditions, unauthenticated access, chaos/network-failure handling, and inconsistent UI states — on **any** target, not just ones with existing test coverage.
- **Who uses it** — QA and automation engineers who want a first exploratory pass on a build before/alongside manual testing, and CI pipelines that want a smoke-level regression gate on every deploy.
- **What makes it different from conventional automated testing** — it is not a fixed test script executed against a known DOM. It classifies the site's *nature* first, plans a phased matrix from that classification, then reuses a single authenticated session (logging in exactly once), and prunes/extends its own plan mid-run as it learns more about the target (see [§5](#5-exploration-strategy)). The default matrix of ~40 UI flows, all API/security checks, and chaos scenarios are deterministic, rule-based TypeScript throughout — none of it depends on an LLM. Three specific, optional layers add real AI judgment on top, all gated on `GEMINI_API_KEY` and all falling back cleanly (or simply skipping) if it's absent: site classification (§4.1), one visual-defect check (§4.5), and a genuine live per-step reasoning loop (§4.6) that decides its own next action by looking at the actual current page, rather than following a pre-written script.

### Key Capabilities

| Capability | Description |
|---|---|
| Application Exploration | Automatically browses the whole site page by page — opening hidden menus first, and following in-app navigation even on modern apps where links aren't plain clickable URLs |
| Site Classification | Looks at each page and works out what kind of site it is (online store, booking site, dashboard, login portal, blog, social app, banking/finance) so it knows what to test for |
| Test Generation | Builds its own list of tests to run based on the site type and how thorough you want it to be — no one has to write test cases by hand |
| Interaction | Uses the site the way a person would — clicking, typing, scrolling, double-clicking, navigating with just a keyboard, resizing the window, filling out forms |
| API Probing | Finds the site's backend requests and checks them directly for common security holes — unprotected data, broken permissions, one user seeing another's data, being able to overload it with requests. Probes are sent as a real authenticated user whenever you've supplied a login, an API key, or a bearer token, not as an anonymous outsider |
| Chaos Injection | Deliberately breaks the connection — slow network, going offline mid-action, dropped or delayed requests, a slowed-down device — to see if the site handles it gracefully |
| Validation | Double-checks every potential issue before reporting it, so it doesn't flag normal behavior as a bug (e.g. a login page with no menu, or a public status page, aren't bugs) |
| Bug Detection | Flags real problems it finds, sorted by type — visual, functional, security, resilience, accessibility, performance |
| Evidence Collection | Saves a screenshot, the relevant logs, and step-by-step instructions to reproduce every issue it finds |
| Reporting | Produces a clean report (with duplicates removed and a plain-English summary) and shows what's new, fixed, or still happening compared to the last run |

---

## 2. High-Level Architecture

```text
                    ┌───────────────────┐
                    │   Target App      │
                    │ (any web URL/API) │
                    └─────────┬─────────┘
                              │ Playwright + HTTP
                              ▼
        ┌────────────────────────────────────────┐
        │        apps/web  ⇄  apps/api             │
        │  React setup/chat UI     Fastify + WS    │
        └─────────────────┬────────────────────────┘
                           ▼
                 ┌───────────────────────┐
                 │   agent-core           │
                 │   SessionOrchestrator  │
                 └──────────┬──────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
 ┌─────────────┐    ┌──────────────┐    ┌───────────────┐
 │ UiExecutor  │    │ ApiExecutor  │    │ ChaosExecutor │
 │explorer-ui  │    │explorer-api  │    │chaos-engine   │
 │(Playwright) │    │(HTTP probes) │    │(CDP/route)    │
 └──────┬──────┘    └──────┬───────┘    └───────┬────────┘
        └───────────────────┼────────────────────┘
                             ▼
                   ┌───────────────────┐
                   │ Reporter           │
                   │ dedupe · fingerprint│
                   │ diff · md/html/json │
                   └───────────────────┘
```

Each box below is a real package in the monorepo, not a logical layer — see [§10](#10-project-structure) for the exact file layout.

- **apps/web / apps/api** — the front door. A React UI (chat-driven or classic form) talks to a Fastify server over REST and a WebSocket for live findings.
- **agent-core** — the orchestration brain: builds the plan, owns session state, dispatches tasks, generates the report.
- **UiExecutor / ApiExecutor / ChaosExecutor** — the three workers that actually touch the target application, each responsible for a disjoint set of exploration areas.
- **Reporter** — turns raw findings into a deduplicated, health-scored, human-readable report and a fingerprint diff against the last run.

---

## 3. Agent Workflow

### End-to-End Flow

**1. Initialize**
→ `POST /api/sessions` creates a `SessionState`
→ `probeAuth()` loads the target and detects the login mechanism
→ Configuration (depth, areas, credentials, context) is loaded onto `SessionConfig`

**2. Understand Application**
→ `collectIntelligenceSignals()` (recon) fingerprints the page: title, headings, link/button text, input types, URL path
→ `classifySiteWithAI()` (if `GEMINI_API_KEY` is set) or `classifySite()`'s 7 weighted rule sets otherwise → site type + confidence + inferred journeys (§4.1)
→ BFS `navigation.ts` crawl discovers routes and real API calls (XHR/fetch capture)

**3. Select Action**
→ `buildPlan()` turns depth + areas + classification into a phased list of `FlowTask`s (recon → smoke → boundary → interruption → auth → chaos → report)
→ Unlikely tasks are pruned once recon signals are in (`removeUnlikelyTasks`); classification-driven "journey" tasks are injected if confidence ≥ 0.3

**4. Execute Action**
→ The orchestrator's `runTasks()` loop dispatches each task to whichever executor declares that task's area
→ The executor clicks / types / scrolls / navigates / sends requests as the flow requires, restoring the one-time login session first

**5. Validate**
→ Each flow/check applies its own false-positive rules before raising anything — e.g. "is this really JSON, or an SPA catch-all returning HTML-200?", "is this page a login wall by design?"

**6. Record Finding**
→ Evidence (screenshot, request/response, console errors) is attached
→ The finding is deduplicated against others in the same run and fingerprinted for cross-run diffing

**7. Continue Exploration**
→ Cross-task state (`discoveredApiEndpoints`, `discoveredRoutes`, `classification`, `actionInventory`) carries forward into the next task
→ The loop continues until the plan is exhausted, the session is paused, or the environment-degraded circuit breaker trips

---

## 4. Core Components

### 4.1 Application Understanding

**Purpose**
Fingerprint the target well enough to classify it and steer the rest of the plan — this is recon + classification, not a generic DOM diff.

**Inputs**
- Page title, meta description, headings, link/button text
- Input field types present on the page (password, date, tel, email…)
- URL path
- Captured XHR/fetch network calls during the visit

**Processing — hybrid: AI judgment first, deterministic rules always as the fallback**

A fixed keyword-scored rule set can only ever recognize the handful of categories someone thought to write a rule for, and has no way to reason about what a genuinely unusual or hybrid site is actually *for* — this was a fair criticism of the original design, and the fix is additive rather than a rewrite:

1. **`classifySite(signals)`** (`packages/agent-core/src/intelligence/classify-site.ts`) always runs first — free, synchronous, zero dependencies. It scores the combined signal text and structural cues against 7 hardcoded rule sets (ecommerce, booking, saas-dashboard, auth-portal, blog-cms, social, fintech), each a weighted strong/medium keyword match plus structural bonuses (e.g. a date input strongly suggests `booking`; a password input alone is down-weighted for `auth-portal` if ecommerce signals are also present, to avoid misclassifying a login page). The highest-scoring rule wins; below 0.3 confidence, the site is classified `generic`. This result is *always* computed and is the guaranteed fallback — the rule set is never removed or bypassed, only outranked when something better is available.
2. **`classifySiteWithAI(signals)`** (`packages/agent-core/src/intelligence/classify-site-ai.ts`) then makes one Gemini call — once per session, not per task — sending the same recon signals and asking for genuine contextual judgment: what kind of site this actually is, *specific* testable journeys (not a generic template reworded), and the evidence for its answer. The model's `siteType` is still constrained to the same fixed set of categories (so everything downstream that dispatches behavior by site type — journey selection, flow relevance — keeps working unmodified), but `inferredJourneys`/`signals`/`keyFeatures` are free-form and can be far more specific to the actual site than any hardcoded template.
3. If the AI call succeeds and validates (key present, response parses, `siteType` is one of the known values, at least one real journey returned), its result **replaces** the rule-based one for this session. If the key is unset, the call times out, fails, or the response doesn't validate, the rule-based result from step 1 is used exactly as before — silently and safely, logged as a plain `[Classify] Using rule-based classification…` message rather than surfaced as an error.

Nothing about this changes the deterministic side of the agent: `injectJourneyTasks()` still only reads `classification.siteType` (to pick a handler) and `classification.inferredJourneys` (as human-readable task titles) — it has no idea, or need to know, which of the two classifiers produced them.

**Outputs**
- `SiteClassification` — site type, confidence, inferred journeys, key features (source is AI-assisted or rule-based, transparently logged either way)
- `discoveredApiEndpoints` / `discoveredRoutes` seeded for the rest of the session
- Login-wall / missing-nav findings suppressed correctly (login pages have no nav by design)

---

### 4.2 Action Engine

**Purpose**
Turn a task plan into real browser/API interaction. There is one action engine per exploration area — the orchestrator never interacts with the target itself, only the three executors do.

**Supported Actions** (UI executor, via Playwright)

| Action | Example |
|---|---|
| Click | Click the primary CTA / submit button |
| Type | Fill a form field with a boundary or safe placeholder value |
| Scroll | Scroll to reveal lazy-loaded content |
| Navigate | Follow a discovered nav link or route |
| Select | Choose a dropdown/select value |
| Keyboard | Tab-only navigation, Escape to close a modal |
| Wait | Wait for network idle / real interactive content before acting |

**Supported Actions** (API executor, via HTTP)

| Action | Example |
|---|---|
| GET/POST probe | Hit a discovered endpoint with/without auth headers — headers built once per check via `buildHeaders()`, layering an `Authorization: Bearer …` / `X-API-Key: …` from `credentials` on top of the restored session cookie (see [§6, API key & bearer-token usage](#api-key--bearer-token-usage)) |
| ID iteration | Walk `1,2,3,999,0` against a collection path (IDOR check) |
| Concurrency | Fire 50 concurrent requests (spike-load) or 20 rapid ones (rate-limit) |
| Payload injection | Send a mass-assignment or reflected-XSS payload |

**Supported Actions** (Chaos executor, via CDP + route interception)

| Action | Example |
|---|---|
| Throttle | Emulate 3G-like network conditions |
| Go offline/online | Toggle connectivity mid-request |
| Drop/delay requests | Abort every other request, or delay API calls 5s |
| Throttle CPU | Emulate a 6× slower device |

---

### 4.3 State Management

```text
SessionState (in-memory + sessions/<id>/state.json)
     ↓
Task dispatched with an ExecutorContext snapshot
     ↓
Executor runs, may mutate discoveredApiEndpoints /
discoveredRoutes / actionInventory / classification
     ↓
Orchestrator diffs "before" vs "after" context
     ↓
Only changed fields are merged back into SessionState
```

The agent avoids re-exploring the same ground in three ways:

- **Visited-route tracking** — the BFS crawl records every route it has already visited, and skips re-queuing it.
- **`executedTaskIds`** — the task loop re-reads the live plan every iteration (since it can be pruned/extended mid-run) but tracks completed work by task id, not by array position.
- **Change-gated merges** — context fields are only re-merged into session state if the executor actually changed them, which also prevents an accidental doubling of accumulated arrays (a real bug once observed, since fixed) across dozens of tasks.

There is no database — session state, plan, and findings are persisted as JSON under `sessions/<id>/` and can be rehydrated after a server restart.

---

### 4.4 Bug Detection

Findings are grouped by exploration **area**, not by a single generic "bug" bucket:

- **Functional issues** — form validation gaps, incorrect redirects, broken CRUD journeys
- **UI/UX issues** — overflow, broken images, placeholder text left in production, modal/focus-trap defects
- **Navigation issues** — dead links, broken back/forward-cache behavior, deep-link failures
- **Validation issues** — boundary/edge-value handling, pagination fuzzing
- **Crash/error issues** — unhandled JS console errors, 5xx responses under boundary or load probes
- **Security issues** — unauthenticated JSON endpoints, IDOR, privilege escalation, mass assignment, reflected XSS
- **Chaos/resilience issues** — no visible error on offline submit, duplicate POSTs on double-submit, no reconnect UI on WebSocket drop
- **Performance issues** — slow load time, N+1-shaped list endpoints, spike-load failures
- **Accessibility issues** — missing labels, keyboard-nav gaps, contrast issues

---

### 4.5 AI-Assisted Visual Review (optional)

**Purpose**
Every check above is rule-based — it reads the DOM, CSS, or an HTTP response and compares it against a rule (e.g. "is this field required?", "did the server return 401?"). That works well for anything a computer can measure, but it structurally cannot catch a defect that is only wrong *visually* — two cards that overlap on screen despite each having valid CSS, a stretched product image, leftover "Lorem ipsum" text, a spinner stuck mid-load. No amount of additional rules closes that gap, because the bug isn't in the code, it's in how the page *looks*.

This component closes that one gap by giving the agent an actual pair of eyes: it hands a screenshot to Google's Gemini model and asks it to look for exactly the kinds of things a human QA tester would notice at a glance. It is **not** a verification step that re-checks other flows' findings, and it doesn't change how anything else in the agent thinks or decides — it's a self-contained specialist for one category of bug that nothing else here can see, plugged in as a pure addition.

Because "does this look wrong" is a judgment call rather than a verifiable fact, its findings are always tagged `confidence: heuristic` (see [§7](#7-bug--finding-lifecycle)) — this adds coverage for a real blind spot without quietly lowering the trustworthiness of the rest of the report.

**Inputs**
- A full-page screenshot of the current page, plus (when cheaply available) a second screenshot of a genuinely different page, bundled into the same request
- A fixed prompt listing 13 specific visual-defect categories to look for, and explicit instructions not to flag deliberate patterns (cookie banners, empty-state placeholders, pagination controls) as bugs

**Processing**
Sends the screenshot(s) to Google's Gemini model (`gemini-3.6-flash`) and parses its JSON response into candidate issues. Runs only if `GEMINI_API_KEY` is set, only at `standard`/`deep` depth, and only within quota: max 15 calls/day (`GEMINI_VISUAL_REVIEW_DAILY_LIMIT`) and a 6-hour cooldown per site origin (`GEMINI_VISUAL_REVIEW_COOLDOWN_HOURS`), tracked in `sessions/.gemini-visual-review-usage.json`. If the key is missing or the call fails for any reason, it logs a message and skips — every other flow in the session is unaffected.

**Outputs**
- Zero or more `UI-Visual` findings, each with the screenshot attached as evidence
- Every such finding is tagged `confidence: heuristic` — a note that this came from a single AI read of one image and should be checked against the attached screenshot before being treated as confirmed. This is deliberately the *lowest*-trust confidence level in the report, not the highest.

---

### 4.6 Live AI-Driven Exploration (optional) — a genuine perceive → reason → act loop

**Purpose**
Every other flow in this codebase, journeys included, is a fixed sequence someone wrote in advance: "go here, click this, check that." That's automation, not really an *agent* in the technical sense — the decisions were all made ahead of time by whoever wrote the flow, not by anything looking at the page in front of it. `agentic-explore` (`packages/explorer-ui/src/flows/agentic-explore.ts`) is the one flow where that's genuinely not true: at each step, it hands Gemini the actual current page's interactive elements and asks it to decide, in the moment, what the single most useful next action is — then executes that specific decision, observes what happened, and asks again. It can choose to follow a link, fill a field, open a menu it wasn't told about, or stop once it judges nothing more is worth trying — the same way a human exploratory tester improvises rather than following a script.

**Inputs, at every step**
- Every visible clickable/fillable element on the current page, numbered (buttons, links, menu items, dropdowns, safe-only input fields)
- The site's classification and inferred journeys (§4.1), for context on what's worth testing
- A running history of every action taken so far this session and what happened as a result — so it doesn't repeat itself or lose the thread

**Processing — bounded and gated exactly like the rest of the agent, not exempt from it**
- Skips outright if `GEMINI_API_KEY` is unset, and only runs at `standard`/`deep` depth
- Hard-capped at 5 actions per session, each with its own 12s response budget — bounds both cost and wall-clock regardless of what the model wants to keep doing
- **High-risk and sensitive input fields are never even offered as an option** — `classifyInputRisk()` (§1) filters them out of the candidate list before the model ever sees the page, so it structurally cannot choose to fill one, not merely "instructed not to"
- **Every risky-looking click still goes through `gateIfSensitive()`** — the same human-confirmation gate every other flow uses. The model can decide "click Delete" is the most interesting thing to try (a legitimate thing to explore), but it cannot execute it without the same confirmation a hand-written journey would need
- Each step's one-sentence reasoning is written to the live log in real time (`[AgenticExplore] Step N reasoning: …`) — this is deliberately visible, not hidden internal state, so a person watching the live session can see *why* the agent did what it did, not just *what* it did

**Outputs**
- Zero or more `AI-Explore` findings, only raised when the model points at something concretely already wrong (not a hypothesis) — same `confidence: heuristic` convention as §4.5, for the same reason
- A per-step reasoning trail in the session log, independent of whether anything was flagged as a bug — the "explanation" is a first-class output of this flow, not just a side effect

---

## 5. Exploration Strategy

### Exploration Model

- **Initial state** — the target URL itself, plus any free-text context or specific matrix IDs the user supplied.
- **Action/task selection** — the planner (`buildPlan` → `buildGenericPlan`) always runs a `recon-site-map` task first, then expands the selected (or all) exploration areas into flow-class tasks, capped by a per-depth task budget.
- **Prioritization of unexplored areas** — post-recon pruning (`removeUnlikelyTasks`) drops tasks for features recon didn't detect (e.g. no file-upload task if there's no upload control on the page); classification-driven journey tasks are inserted once confidence is high enough.
- **Tracking previously explored states** — `discoveredRoutes`/visited-route sets during BFS crawl; `executedTaskIds` at the task-loop level.
- **Loop avoidance** — the BFS crawl is capped by `MAX_PAGES`/`MAX_DEPTH` (scaled by exploration breadth), and OTP/login flows never re-trigger a second real login once one is in flight.
- **Stopping criteria** — the plan is exhausted, the user pauses the session, or the environment-degraded circuit breaker fires (3 consecutive timeout failures on the same signature quarantines the rest of that streak and shortens subsequent timeouts).

### Exploration Prioritization

| Priority | Condition |
|---|---|
| Always first | Recon / site-map task (`recon-site-map`) |
| High | Classification-driven "journey" tasks (checkout, entity CRUD, publish — only once site type is known with ≥0.3 confidence) |
| High | Auth-matrix / privilege-escalation checks against newly discovered endpoints |
| Medium | Generic matrix tasks for the selected areas (forms, boundary, modals, viewport, …) |
| Medium | Chaos scenarios, scheduled at `chaos` depth or when `chaos` area is selected |
| Low | Regression/golden-path and visual-review tasks (deep/standard depth only) |
| Excluded | Any flow class not yet wired to a real handler — falls back to generic navigation rather than being scheduled, so it never displaces real coverage |

---

## 6. Test / Exploration Configuration

Configuration is split between **session config** (what to explore, supplied per run via UI/chat/API) and **environment config** (`.env`, how the platform itself runs).

```yaml
# SessionConfig — created via POST /api/sessions
target:
  targetUrl: https://example.com
  context: "focus on the checkout flow"       # optional free text

exploration:
  depth: standard                              # smoke | standard | deep | chaos
  areas: [ui, api, chaos, security, performance, regression, accessibility]
  selectedFlowClasses: []                      # optional — restrict to specific matrix IDs
  flowInstructions: []                         # optional user-directed steps

credentials:
  type: login                                  # none | login | api-key | bearer — see below
  authMethod: password                         # password | otp | password-otp | oauth | magic-link | saml | none
  username: ...
  password: ...
  apiKey: ...                                  # used when type: api-key
  bearerToken: ...                             # used when type: bearer
  extras: {}                                   # card/phone/etc., only supplied when a gate asks for it

reporting:
  screenshots: true                            # always captured on finding
  format: [md, html, json]
```

| Field | Description |
|---|---|
| `target.targetUrl` | The site to explore — required |
| `target.context` | Free text steering plan generation (e.g. "test the payment flow") |
| `exploration.depth` | Controls the task budget: smoke 15, standard 80, deep 200, chaos 20 |
| `exploration.areas` | Which of `ui, chaos, api, security, performance, regression, accessibility` to schedule |
| `exploration.selectedFlowClasses` | Run only specific matrix IDs (e.g. `A6`, `B2`) instead of the full area matrix |
| `credentials.type` | Which credential shape is supplied — see **API key & bearer-token usage** below |
| `credentials.authMethod` | For `type: login` — drives which browser login handler `performSessionLogin()` uses |
| `credentials.extras` | Free-form key/value data supplied only when a sensitive-action gate requests it |

### API key & bearer-token usage

This is a **per-session credential you supply for the target site's own API** — unrelated to `GEMINI_API_KEY` (§4.5, §9, §11), which is a platform-level `.env` setting that only unlocks one optional AI flow. `credentials.type` is a separate axis from `authMethod`, for targets that should be probed as an API rather than logged into as a browser session:

| `credentials.type` | Behavior |
|---|---|
| `none` | No credentials — every probe is unauthenticated |
| `login` | Browser login via `authMethod` (password/OTP/OAuth/magic-link/SAML); the resulting session cookie is what authenticates both UI flows and API probes |
| `api-key` | No browser login. `ApiExecutor`'s `buildHeaders()` attaches `X-API-Key: <apiKey>` to every HTTP probe it sends |
| `bearer` | No browser login. `buildHeaders()` attaches `Authorization: Bearer <bearerToken>` to every HTTP probe |

`buildHeaders()` (`packages/explorer-api/src/probe-helpers.ts:43`) is called once per API check and layers the credential header on top of the restored browser-session cookie (`readSessionCookieHeader()`) when both exist — so a `login`-type session's cookie and an `api-key`/`bearer` header aren't mutually exclusive, though in practice a target usually only needs one or the other. This is what makes IDOR, privilege-escalation, and mass-assignment checks (see [§4.4](#44-bug-detection)) meaningful against APIs that authenticate purely via a header rather than a cookie session — without it, every probe would look identically "unauthenticated" whether or not the endpoint was actually protected.

Supplied via: the classic setup form's credential-type selector (`SessionSetupPage.tsx`), or in chat by typing `api-key: <key>` or `bearer: <token>` (parsed by `auth-chat.ts`).

See [§11](#11-setup--installation) for the platform-level `.env` variables.

---

## 7. Bug / Finding Lifecycle

```text
Detected (a flow/check raises a candidate)
   ↓
Validation (false-positive rules: SPA catch-all? login wall? public endpoint?)
   ↓
Evidence Collection (screenshot, request/response, console logs)
   ↓
Deduplication (exact-key, then near-duplicate merge by target/title overlap)
   ↓
Severity Assessment (critical / high / medium / low / info)
   ↓
Final Finding (persisted, fingerprinted, included in the report)
```

Three-stage deduplication happens across the run's lifetime, not just at report time: dedup sets (`reportedAuthPaths`, `reportedPrivilegePaths`) prevent two checks that share the same underlying test function from double-reporting the same path while the session is still running; `dedupeFindings()` then does a second pass at report-generation time.

### Finding Format

| Field | Description |
|---|---|
| `title` | Short description of the issue |
| `severity` | `critical` / `high` / `medium` / `low` / `info` |
| `area` | Which exploration area raised it (`ui`, `api`, `chaos`, `security`, …) |
| `taskId` / `flowClass` | Which task and flow produced the finding |
| `pageUrl` / `targetSelector` | Where it occurred |
| `expected` | Expected behavior |
| `actual` | Actual behavior observed |
| `evidence` | Screenshot / request-response / console log |
| `confidence` | How firmly established the finding is. Rule-based checks assert this directly (e.g. an unauthenticated 200+JSON response is a verifiable fact); the one AI-vision check (§4.5) always tags its findings `heuristic` — a single AI read of one screenshot, flagged for a human to confirm against the attached image rather than trusted outright |
| `fingerprint` | `area\|normalizedTitle`, used for cross-run diffing |
| `quarantineReason` | Set (and severity downgraded to `info`) if raised during a detected environment-degraded streak |
| `status` (report-level) | New / Fixed / Recurring, from the fingerprint diff against the previous same-URL session |

---

## 8. Evidence & Reporting

### Example Finding

> **Unauthenticated access to `/api/orders` returns customer order data**

**Severity:** High
**Area:** Security (`auth-matrix`)

**Steps**
1. Discover `/api/orders` during recon's network capture
2. Send a GET request with no `Authorization` header
3. Observe the response

**Expected:** `401 Unauthorized`, no order data returned.

**Actual:** `200 OK` with `Content-Type: application/json` and a JSON array of orders.

**Evidence**
- Raw request/response pair
- Confirmation the endpoint was excluded from `PUBLIC_ENDPOINTS` (i.e. not an intentionally open health/status route)
- Screenshot of the corresponding UI page, if the endpoint was discovered from it

### Example Finding — from the AI visual review (requires `GEMINI_API_KEY`)

> **Visual issue: Product cards show inconsistent heights, causing overlapping "Add to Cart" buttons**

**Severity:** Medium
**Area:** UI-Visual
**Confidence:** `heuristic` — *"Single AI-vision read of one screenshot, not cross-validated against a second signal — check the attached screenshot before treating as confirmed."*

**Steps**
1. Open `/catalog`
2. Visually inspect the rendered page

**Expected:** No visual rendering defects.

**Actual:** Product cards render at inconsistent heights; the "Add to Cart" button on shorter cards overlaps the card below it.

**Evidence**
- Full-page screenshot attached

This finding only ever appears if `GEMINI_API_KEY` is set, the session ran at `standard`/`deep` depth, and daily/cooldown quota wasn't already used up (§4.5) — otherwise the report simply has no `UI-Visual` findings, since no other check in this codebase looks for this class of bug.

Reports are generated in three formats from the same finding set:

- **Markdown** — for PR comments, CI artifacts, chat.
- **HTML** — fully self-contained; screenshots are inlined as base64 so the report survives being emailed or printed to PDF standalone.
- **JSON** — machine-readable, used by `scripts/ci-run.mjs` to decide pass/fail against a `--fail-on` severity threshold.

Every report also includes an executive summary, a health score, area/flow coverage, and — when a previous completed session exists for the same target URL — a **New / Fixed / Recurring** findings diff.

---

## 9. Technology Stack

| Layer | Technology |
|---|---|
| Agent orchestration | TypeScript, custom `SessionOrchestrator` (agent-core) — no external agent framework |
| "Intelligence" | Auth detection and planning are deterministic rule-based TypeScript, always. Site classification is hybrid: AI-assisted via Gemini when `GEMINI_API_KEY` is set (§4.1), deterministic rule-based scoring otherwise — **no LLM anywhere in the actual execution/probing logic** |
| AI-assisted (optional) | Google Gemini (`gemini-3.6-flash`), called with your `GEMINI_API_KEY` — three independent uses: site classification once per session (§4.1), the `visual-review` flow (§4.5), and the `agentic-explore` live reasoning loop (§4.6), the last two at standard/deep depth only. All three are additive and bounded; every other flow works identically with or without this key set |
| Browser automation | Playwright (Chromium — all flows; Firefox + WebKit — cross-browser/device-matrix only) |
| HTTP probing | Native `fetch`-based probes (`explorer-api`) |
| Network chaos | Chrome DevTools Protocol + Playwright `page.route()` interception |
| Backend | Fastify (HTTP + WebSocket), Node.js 20+ |
| Frontend | React 19, Vite 6, react-router-dom 7 |
| Language | TypeScript throughout (NodeNext, strict mode) |
| Monorepo tooling | npm workspaces, `tsc` project builds, `concurrently` for local dev |
| CI/CD | GitHub Actions (manually-dispatched workflow), `scripts/ci-run.mjs` as the CI entry point |

---

## 10. Project Structure

```text
generic_exploratory_agent/
│
├── apps/
│   ├── api/                Fastify HTTP + WebSocket server (@qa/api, :3001)
│   └── web/                React + Vite UI (@qa/web, :5173)
│
├── packages/
│   ├── shared/             Types + constants shared by every package (@qa/shared)
│   ├── agent-core/         Planner, orchestrator, site classifier, reporter (@qa/agent-core)
│   │   └── src/
│   │       ├── planner/        Plan construction, phase categorization
│   │       ├── orchestrator/   SessionOrchestrator + task loop (run-session.ts)
│   │       ├── intelligence/   classifySite() (rules) + classifySiteWithAI() (Gemini, optional)
│   │       └── reporter/       Report generation, dedup, fingerprint diff
│   ├── explorer-ui/        Playwright UI flows + auth probing (@qa/explorer-ui)
│   │   └── src/flows/          ~40 flow modules (navigation, journey, forms, boundary, …)
│   ├── explorer-api/       HTTP API probing + security checks (@qa/explorer-api)
│   │   └── src/checks/         auth, idor, privilege, injection, performance, rate-limit, regression
│   ├── chaos-engine/       Network-chaos flows (@qa/chaos-engine)
│   └── chat-agent/         Deterministic setup/live/findings chat (@qa/chat-agent)
│
├── .claude/skills/         Claude Code skill — runtime source of truth for the matrix
├── scripts/                setup.sh, ci-run.mjs
├── sessions/               Per-session output (gitignored)
└── docs/                   This document, and future reference material
```

---

## 11. Setup & Installation

### Prerequisites

- Node.js 20+
- npm (workspaces support)
- OS packages Playwright's browsers need (`playwright install --with-deps chromium firefox webkit` on a bare Linux box/CI)

### Installation

```bash
git clone <repo-url>
cd generic_exploratory_agent

npm run setup   # npm install → build all workspaces → playwright install chromium firefox webkit → .env
npm run dev     # chat-agent + API (3001) + web (5173), together
```

All three browser engines are required, not just Chromium — the `cross-browser` and `device-matrix` flows (both part of the default `ui` area) launch real Firefox and WebKit browsers, and will misreport "page fails to load" as a HIGH-severity finding against whatever site you're testing if either engine isn't installed. That failure is about this machine's setup, not the target site.

Open `http://localhost:5173`.

### Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `API_PORT` | Fastify server port (default `3001`) | No |
| `SESSIONS_DIR` | Where session state, screenshots, and reports are written (default `./sessions`) | No |
| `CLEAR_SESSIONS_ON_START` | Set to `1` to wipe all session folders on every boot — CI/throwaway environments only | No |
| `VITE_API_URL` | Vite dev-proxy target for `/api` and `/sessions-files` (default `http://localhost:3001`) | No |
| `VITE_WS_URL` | Direct WebSocket URL override, otherwise derived from `VITE_API_URL` | No |
| `GEMINI_API_KEY` | Enables three optional, independent things: AI-assisted site classification (§4.1), the `visual-review` flow's screenshot analysis (§4.5), and the `agentic-explore` live reasoning loop (§4.6) | No |
| `GEMINI_VISUAL_REVIEW_DAILY_LIMIT` | Cross-session Gemini call cap per day (default `15`) | No |
| `GEMINI_VISUAL_REVIEW_COOLDOWN_HOURS` | Skip re-reviewing the same origin within this window (default `6`) | No |
| `JIRA_API_TOKEN` / `SLACK_WEBHOOK_URL` | Reserved for future findings-export integrations | No |
| `CURSOR_API_KEY` / `LLM_MODEL` | Reserved for a future Cursor/agent-SDK integration — not read by the current runtime | No |

Target-site credentials are **never** put in `.env` — they're supplied per-session via the UI or chat. `GEMINI_API_KEY` is the one exception: it's a platform-level key (this app's own API cost), not a target-site credential, which is why it lives here instead of in session config — see [§6, API key & bearer-token usage](#api-key--bearer-token-usage) for the per-session kind.

---

## 12. Running the Agent

### Basic Run

```bash
npm run dev
# then open http://localhost:5173 and click "Start New Exploration"
```

### Example (headless CI run)

```bash
node scripts/ci-run.mjs https://staging.example.com \
  --depth smoke --fail-on high --report-out qa-report.md
```

### Output

```text
session:created
   ↓
site:classified          (e.g. "ecommerce", confidence 0.62)
   ↓
task:started              recon-site-map
   ↓
task:completed
   ↓
task:started               form-validation
   ↓
session:finding            "Checkout form accepts empty shipping address"
   ↓
task:completed
   ↓
   ... (remaining tasks in the plan) ...
   ↓
session:completed           report written to sessions/<id>/report.{md,html,json}
```

---

## 13. Example Exploration

### Scenario: Login Flow

```text
Login Screen
     │
     ├── probeAuth() detects a password field
     │        ↓
     │     performSessionLogin() — one-time login, auth-state.json saved
     │
     ├── Enter valid credentials
     │        ↓
     │     Dashboard reached, postLoginUrl recorded
     │
     ├── Enter invalid credentials (separate probe, not the saved session)
     │        ↓
     │     Validation message expected
     │
     ├── Leave fields empty
     │        ↓
     │     Required-field validation expected
     │
     └── OTP/magic-link/OAuth/SAML detected instead
              ↓
          Chat pauses for the pasted code/link/cookie via `onPreActionNeeded`
```

What the agent actually discovers from this one flow: whether the login form validates empty/invalid input correctly, whether `isLoginWallPage()` correctly suppresses "no nav found" false positives on the login screen itself, and whether the post-login landing page is reachable without re-triggering a second real login (critical for OTP-based sites).

---

## 14. Limitations & Known Issues

| Limitation | Impact | Workaround |
|---|---|---|
Live per-step action decisions are the exception, not the rule, in this codebase | Only `agentic-explore` (§4.6) genuinely decides "click this specific button" live; the other ~40 UI flows and every API/security/chaos check are still fixed, hand-authored TypeScript — deliberately, since that keeps the bulk of the matrix auditable and reproducible run to run | This is a boundary, not a bug: the matrix's reliability comes from being mostly scripted; the one live-reasoning flow is capped (5 actions/session) and clearly separated so it can't destabilize everything else |
| `agentic-explore`'s per-step cost is materially higher than the once-per-session classification call | Up to 5 Gemini calls per session instead of 1, only at standard/deep depth | Bounded by `MAX_STEPS` in the flow itself; lower it (or drop the flow class from a session's `selectedFlowClasses`) if cost is a concern — no daily-quota tracker exists for this flow yet, unlike `visual-review`'s |
| Sensitive actions require a human reply | Exploration pauses on Send/Share/Pay/Invite-style actions until the user answers or explicitly skips | By design — this is a safety guarantee, not a bug; see the gating rules in the field guide |
| PRD-driven mode described in older docs is not currently implemented | `@qa/prd-parser` and its consuming flows (`prd-driven.ts`, `prd-assertions.ts`, `prd-quirks.ts`) have been removed from the codebase; no `buildPrdOnlyPlan` exists | This document describes the generic matrix pipeline that remains; treat any PRD-mode references in `README.md`/`AGENTS.md` as stale until updated |
| PRD upload UI has no working backend route | `apps/web` calls `POST /api/sessions/:id/upload-prd`, which is not registered in `apps/api` | Don't rely on PRD upload from the UI until the route is restored or the button is removed |
| `package-lock.json` still lists `@qa/prd-parser` | Cosmetic only | Regenerated automatically on the next full `npm install` |
| `npm run dev` does not watch `packages/` | Changes to any package require a manual `npm run build` before the dev server picks them up | Always rebuild after editing `packages/*`; build `shared` first if you changed `types.ts` |
| Site-nature-specific exploration (`site-nature-exploratory-qa` skill) is a design spec | More careful, domain-specific coverage (e.g. fintech) isn't wired into the runtime yet | Use the generic matrix; treat that skill doc as a roadmap, not current behavior |
| AI visual review needs its own billed API key and quota | Without `GEMINI_API_KEY`, purely visual defects (overlapping elements, broken images, leftover placeholder text) go undetected — no other check looks for this category | Every other capability in §1's Key Capabilities table works fully without any key; add `GEMINI_API_KEY` only if visual-bug coverage is worth the API cost |

---

## 15. Future Improvements

### Exploration
- Smarter action prioritization informed by prior-session findings, not just the current run's classification
- ~~Additional site-classification rule sets beyond the current 7~~ — superseded: AI-assisted classification (§4.1) now handles novel/hybrid site types via contextual judgment instead of needing a new hardcoded rule per category; the rule set stays at 7 as the deterministic fallback
- Extend the same "AI-assisted, deterministic fallback" pattern used for classification to severity/triage — re-rank findings by actual business risk given site context, instead of each check's static severity
- Broader loop/duplicate-state detection across sessions, not just within one run

### Detection
- Handlers for the candidate flow classes already reserved in the matrix but not yet built (see `exploration-matrix.md`'s "Not Implemented" table — IDs A14–A15, B9, D9–D11, F6–F9, I1–I4)
- Automatic bug deduplication across sessions on the same target, beyond the current fingerprint diff
- Restoring PRD-driven, requirement-traceable testing (or explicitly retiring the docs that describe it)

### Reporting
- Wiring up the already-reserved `JIRA_API_TOKEN` / `SLACK_WEBHOOK_URL` env vars to real findings-export integrations
- Automatic bug ticket creation from high/critical findings
- Historical health-score comparison across more than one prior run

---

## 16. Troubleshooting

### Agent does not start

**Possible causes**
- Dependencies not installed / Playwright browsers not downloaded
- A package was edited but not rebuilt, so `apps/api` is running against stale `dist/` output

**Resolution**
```bash
npm install
npx playwright install chromium firefox webkit
npm run build
npm run dev
```

### Cross-browser / device-matrix findings say "page fails to load" and you can't reproduce it

This is almost always a local environment gap, not a real site bug: those two flows launch real Firefox and WebKit browsers, and Playwright's own "Executable doesn't exist" error looks identical to a genuine page-load failure. Run `npx playwright install chromium firefox webkit` and re-run the session — if the finding disappears, that confirms it was this, not the target site.

### Application is not detected / misclassified

The classifier falls back to `generic` below 0.3 confidence — this is expected for very sparse or unusual pages, and the full baseline matrix still runs. If a well-known site type is misclassified, check whether its recon signals (headings, input types, URL path) genuinely resemble another rule set more strongly (e.g. a login-first SaaS dashboard can score close to `auth-portal`).

### Agent gets stuck / session never completes

Check for the environment-degraded circuit breaker: three consecutive timeout failures on the same signature will quarantine that streak and shorten subsequent timeouts rather than hang — if the session is still stuck beyond that, the target itself is likely unreachable or the saved `auth-state.json` has expired mid-session (triggering repeated `loginIfNeeded` re-auth attempts).

---

## 17. FAQ

**What applications can the agent test?**
Any URL reachable over HTTP(S) — public sites, sites behind password/OTP/OAuth/magic-link/SAML login, and REST-style JSON APIs. It classifies the site's nature automatically rather than requiring a per-app configuration.

**Does the agent generate deterministic tests?**
The plan structure (phases, task budgets) is deterministic given the same depth/areas/classification. The exact sequence can vary slightly run-to-run because BFS crawl order and network timing aren't fixed — this is intentional for an *exploratory* agent, not a regression-script replay tool.

**How does it know whether something is a bug?**
Each check/flow applies explicit false-positive rules before raising a finding — e.g. requiring `Content-Type: application/json` (not just HTTP 200) before treating a response as a real API hit, checking `isLoginWallPage()` before flagging "no nav found," and excluding known-public endpoints from unauthenticated-access findings.

**How does it avoid repeating the same actions?**
Visited-route tracking during the BFS crawl, an `executedTaskIds` set at the task-loop level, and a login-session-reuse design that logs in exactly once per session instead of per task.

**Do I need an API key to use this agent?**
No — the agent, its report, and every capability in §1's Key Capabilities table work with zero keys configured. There are two *optional* keys: a target-site **API key or bearer token** (§6) if you want to probe that site's API as an authenticated user instead of via browser login; and `GEMINI_API_KEY` if you want any of three independent AI-assisted upgrades — richer site classification (§4.1), the visual-defect check (§4.5), and the live per-step reasoning loop (§4.6). Neither key is required to run an exploration or generate a report, and each Gemini-gated feature falls back to a deterministic equivalent (or simply skips) on its own if the key is missing or a call fails.

---

## 18. Glossary

| Term | Meaning |
|---|---|
| Exploration | One end-to-end agent run against a target URL, from session creation to a final report |
| Session | The runtime unit of an exploration — has a status, a plan, findings, and persisted JSON state under `sessions/<id>/` |
| Depth | How large a task budget the plan gets — `smoke` (15), `standard` (80), `deep` (200), `chaos` (20) |
| Area | A category of exploration — `ui`, `api`, `chaos`, `security`, `performance`, `regression`, `accessibility` |
| Flow class | A specific test/probe implementation (e.g. `double-click`, `idor-probe`) mapped to a matrix ID like `A6` |
| Executor | One of `UiExecutor` / `ApiExecutor` / `ChaosExecutor` — owns a set of areas and actually interacts with the target |
| Classification | The inferred site type + confidence + likely user journeys — from `classifySiteWithAI()` when available, else the deterministic `classifySite()` rule set |
| Finding | A single recorded defect — severity, area, evidence, fingerprint, and (for report status) New/Fixed/Recurring |
| Confidence | A label on a finding showing how firmly it's established — from a verifiable rule-based assertion up to `heuristic` (a single AI-vision read that still needs a human look at the screenshot) |
| Fingerprint | `area|normalizedTitle` — the key used to match a finding across two different sessions on the same target |
| Gating | Pausing before a Send/Share/Pay/Invite-style action until the user confirms or explicitly skips |
