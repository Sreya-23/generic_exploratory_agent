
# AGENTS.md — Generic Exploratory QA Agent

This file guides AI coding assistants working on this codebase.
Read this before making any changes.

---

## What this project is

A **generic exploratory QA agent** that accepts any website URL, automatically detects its type and login mechanism, and runs a full matrix of UI, API, chaos, security, and performance tests — without manual test selection.

**Optional PRD:** users may upload a PRD (PDF) from chat or classic setup. When a PRD is present, follow the **PRD-Driven Protocol** in `.cursor/skills/generic-exploratory-qa/SKILL.md` — auth smoke gate, then PRD-only feature testing (happy / negative / interruption) with verified assertions, requirement→task traceability, and coverage summary. When no PRD is uploaded, keep the existing generic matrix behaviour.

---

## Monorepo structure

```
apps/
  api/          → Fastify HTTP + WebSocket API server (port 3001)
  web/          → Vite + React UI (port 5173)
packages/
  shared/       → Types, constants, shared interfaces (@qa/shared)
  agent-core/   → Planner, orchestrator, site classifier (@qa/agent-core)
  explorer-ui/  → Playwright-based UI flows (@qa/explorer-ui)
  explorer-api/ → HTTP API probing flows (@qa/explorer-api)
  chaos-engine/ → Network chaos flows (@qa/chaos-engine)
  chat-agent/   → Setup + live chat logic (@qa/chat-agent)
  prd-parser/   → PRD document parser (@qa/prd-parser)
```

---

## Build rules — ALWAYS follow these

```bash
# After ANY code change to packages/ or apps/:
npm run build

# THEN start the dev server:
npm run dev
# UI → http://localhost:5173   API → http://localhost:3001
```

**Critical:** `npm run dev` does NOT watch `packages/` (explorer-ui, explorer-api, agent-core, shared). Changes to those packages require a manual `npm run build` before they take effect. Forgetting this is the #1 cause of "my change isn't working".

When adding a new type to `packages/shared/src/types.ts`, always build `shared` first before the full build:
```bash
npm run build -w packages/shared && npm run build
```

---

## Intelligence pipeline — how exploration works

```
URL given (+ optional PRD upload)
  ↓
probeAuth()           Detect login type (password / Otp / oauth / magic-link / saml / none)
                      Uses waitUntil:'load' + 1.5s wait for SPA hydration
                      URL-path fallback: /login, /signin, /auth → requiresAuth=true
  ↓
performSessionLogin() ONE-TIME login per session, saves auth-state.json
                      Each subsequent task restores cookies from auth-state.json
  ↓
IF PRD uploaded:
  parsePrd()          Extract features + constraints (PDF / md / txt)
  ↓
  merge into context  Overview + constraints on SessionConfig.context
  ↓
  buildPrdOnlyPlan()  For each feature: happy + negative + interruption (NO generic matrix)
  ↓
  prd-driven flow     Locate UI by keywords → run QA variants → coverage summary
ELSE (no PRD — existing behaviour):
  recon.ts            Collect page signals + capture XHR/fetch network calls
  ↓
  classifySite()      Score signals against site-type rules
  ↓
  navigation.ts       BFS traversal + API harvest
  ↓
  Matrix tasks        UI, chaos, API, security, accessibility, performance, regression (ALL_AREAS)
                      API executor uses real discovered endpoints — not guesses
```

**Skill source of truth for PRD mode:** always follow `.cursor/skills/generic-exploratory-qa/SKILL.md` → section **PRD-Driven Protocol** when `config.prdPath` is set.

---

## Key rules when coding flows

### Authentication
- Login runs **once** via `performSessionLogin()` before any tasks. Result saved to `auth-state.json`.
- Each task's `createPage()` restores auth via Playwright `storageState`.
- Never add per-task login loops — they break OTP-based sites.
- `detectLoginWall(page)` checks password, OTP, phone, AND URL path signals.

### API testing — avoid false positives
- Always use `new URL(ctx.config.targetUrl).origin` — never the raw `targetUrl` (which may be `/login`).
- Only flag HTTP 200 responses as findings if `Content-Type: application/json` or body starts with `{`/`[`.
- React/Vue SPAs return 200 + HTML for every path — this is NOT an exposed API endpoint.
- Public endpoints (`/health`, `/api/health`, `/status`) are intentionally unauthenticated — never flag HIGH.
- Use `ctx.discoveredApiEndpoints` (real endpoints from recon + BFS) before falling back to guesses.

### Sensitive data — never fill without user confirmation
```
HIGH-RISK fields  → recipient, whatsapp, SMS, send-to, message-to  → SKIP entirely
SENSITIVE fields  → email, phone, card, bank, Aadhar, PAN         → no random data
SAFE fields       → name, search, title, notes, description        → safe placeholders OK
```
Before clicking Send / Share / Invite / Pay / Transfer — call `gateIfSensitive()` which emits a `pre_action:required` event and waits for user input. If user replies `skip`/`no`/`cancel` → set `_user_skip: 'true'` in extras and skip.

### Login-wall pages
- Always call `isLoginWallPage(page)` before reporting "no nav links", "no forms", or "nav not visible".
- Login pages have no nav by design — skip those findings.

### Findings — prevent duplicates
- Use deduplication sets (`reportedAuthPaths`, `reportedPrivilegePaths`) in api-executor.ts.
- `auth-matrix` and `auth-bypass` both call `testAuthMatrix()` — the set prevents duplicate findings.

---

## Shared context across tasks

The orchestrator in `run-session.ts` persists cross-task data on `SessionState`:
- `state.discoveredApiEndpoints` — written after each task, injected into the next task's `ctx`
- `state.classification` — set by recon, injected into journey and subsequent tasks

When adding new cross-task shared data, add the field to both `SessionState` (types.ts) and `ExecutorContext` (types.ts), then wire it in `runTasks()` in orchestrator.

---

## Adding a new flow

1. Create `packages/explorer-ui/src/flows/your-flow.ts`
2. Export `async function runYourFlow(page, ctx, task): Promise<void>`
3. Register in `FLOW_HANDLERS` in `packages/explorer-ui/src/ui-executor.ts`
4. Add flow class string to the right area in `packages/shared/src/constants.ts` `FLOW_CLASSES`
5. Add display title to `FLOW_TITLES` in `constants.ts`
6. Add to phase categorization in `planner/index.ts`
7. **Only add the area to `ALL_AREAS` once every flow class in it has a real `FLOW_HANDLERS` entry.** A flow class with no handler falls back to the generic `navigation` flow — scheduling it by default just duplicates A1 for no new signal. New/candidate IDs proposed but not yet built (A14–A15, B9, D9–D11, F6–F9, I1–I4 — see [exploration-matrix.md](.cursor/skills/generic-exploratory-qa/exploration-matrix.md)) must stay out of `ALL_AREAS` until handlers exist.
8. Run `npm run build` and verify

---

## Adding a new auth type

1. Add type to `AuthMethod` union in `packages/shared/src/types.ts`
2. Add detection logic in `packages/explorer-ui/src/auth/probe.ts` (`probeAuth`)
3. Add login handler in `packages/explorer-ui/src/ui-executor.ts` (`performSessionLogin`)
4. Add chat prompt in `packages/chat-agent/src/auth-chat.ts` (`authPromptFromProbe`)
5. Add input parsing in `parseAuthFields` in `auth-chat.ts` if user provides data via chat
6. Build `shared` first: `npm run build -w packages/shared && npm run build`

---

## Skill and matrix documentation

- **`.cursor/skills/generic-exploratory-qa/SKILL.md`** — generic baseline: auth, matrix A1–H3 (+ candidate A14–A15, B9, D9–D11, F6–F9, I1–I4), false-positive rules. Update when adding capabilities or detection rules.
- **`.cursor/skills/generic-exploratory-qa/exploration-matrix.md`** — catalog of all test IDs, including a "Not Implemented (📋 Planned)" table. Update the status column (📋 → 🔄 → ✅) as flows get built, never mark ✅ before a real `FLOW_HANDLERS` entry exists and is wired into `ALL_AREAS`.
- **`.cursor/skills/site-nature-exploratory-qa/SKILL.md`** — **site-nature / complete exploration**: map every relevant tab/field, explore each surface, consent before crucial actions. Use when the user wants nature-specific (e.g. fintech-careful) coverage, not only the generic matrix. Currently a design spec, not live behaviour — see its own "Implementation status" section. Policies: `site-policies.md`.

Keep these accurate — coding agents read them at runtime. Status markers (✅/🔄/📋) are load-bearing: they're how an agent knows whether "run E1" will do anything real or just fall back to `navigation`.

---

## Common mistakes to avoid

| Mistake | Correct approach |
|---|---|
| Using `ctx.config.targetUrl` as API base URL | Use `new URL(ctx.config.targetUrl).origin` |
| Flagging HTTP 200 from guessed paths as HIGH | Check `isJson` first — HTML = SPA catch-all |
| Re-doing login inside each flow task | Restore from `auth-state.json` via `storageState` |
| Using `waitUntil: 'domcontentloaded'` for auth probe | Use `'load'` + 1500ms wait for SPA hydration |
| Filling email/phone fields with random test data | Call `classifyInputRisk()` first |
| Clicking Send/Share without user confirmation | Call `gateIfSensitive()` before clicking |
| Running same auth check in two flow classes | Use `reportedAuthPaths` Set for deduplication |
| Forgetting to rebuild after package changes | Always `npm run build` before `npm run dev` |
| Adding a new area to `FLOW_CLASSES` but not `ALL_AREAS` | Both must be updated in `planner/index.ts` |
| Running full matrix when a PRD was uploaded | Use `buildPrdOnlyPlan` — PRD-only happy/negative/interruption |
| Mapping `prd-driven` to generic `runNavigation` | Use `runPrdDrivenFlow` and record `onPrdCoverageUpdate` |
| Adding a new area/flow class to `FLOW_CLASSES` and also to `ALL_AREAS` before it has a `FLOW_HANDLERS` entry | Build the handler first. Unhandled flow classes silently fall back to `navigation` — scheduling them by default wastes task budget re-running A1 |
| Marking a matrix ID ✅ in `exploration-matrix.md` before the handler is registered and scheduled | Only mark ✅ once `FLOW_HANDLERS` has a real implementation AND the area is in `ALL_AREAS` (or explicitly documented as opt-in) |
