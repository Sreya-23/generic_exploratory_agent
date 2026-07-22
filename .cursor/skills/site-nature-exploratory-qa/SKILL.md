---
name: site-nature-exploratory-qa
description: >-
  Performs complete, site-nature-driven exploratory QA — classify the product
  (fintech, ecommerce, booking, saas, social, etc.), map every relevant tab /
  sidebar / form / action, explore each surface thoroughly, and always ask user
  consent before crucial actions (pay, transfer, send link, invite, purchase).
  Use when the user wants nature-specific exploration, fintech-careful testing,
  full tab/field coverage, consent-gated actions, or deeper exploration than the
  generic matrix alone.
disable-model-invocation: true
---

# Site-Nature Exploratory QA

This skill is **not** the generic matrix sweep. It is the **specific** exploration
mode: understand what the product is, map its real UI, visit every relevant
surface, run exploratory checks there, and **never** perform irreversible or
external actions without user consent.

For the broad A1–H3 catalog, see sibling skill
[generic-exploratory-qa](../generic-exploratory-qa/SKILL.md).
For per-type policies, see [site-policies.md](site-policies.md).

---

## Implementation status — read before invoking

This skill is currently a **design spec, not fully live behaviour**. Verified against the
code as of this writing:

- No structure-map / complete-surface-sweep implementation exists anywhere in
  `packages/explorer-ui`. There is no `structureMap`, no per-surface loop, no
  "visit every relevant tab" traversal beyond what the generic BFS `navigation.ts`
  already does for its own purposes.
- `runFintechJourney` ([journey.ts](../../../packages/explorer-ui/src/flows/journey.ts))
  does exactly the anti-pattern this skill warns against: it finds the **first**
  Transfer/Pay button, gates it once, and stops — it does not walk Accounts / Cards /
  History / Beneficiaries / Settings the way [site-policies.md](site-policies.md) describes.
- `gateIfSensitive` in the same file is a fixed regex over button labels, not driven by
  any discovered structure map — so "consent gate on every crucial action discovered"
  is not yet true; only the hardcoded label patterns are gated.

Until the items in the [Implementation checklist](#implementation-checklist-for-coding-agents)
below are built, invoking this skill will fall back to the same shallow, single-button
journeys as `generic-exploratory-qa` — it will **not** actually produce a complete
tab-by-tab sweep. Treat this document as the target behaviour to build toward, and update
this status section once a checklist item ships.

## When to use this skill

Use when the user asks for any of:
- Explore based on the **nature / type** of the website
- **Complete** exploration (all tabs, all relevant buttons — not random clicks)
- **Fintech-careful** (or other high-risk) behaviour
- Field-level inventory and unusual-UI reporting
- Consent before pay / transfer / send link / invite / purchase

Do **not** treat this as “click a few happy-path buttons then stop.”

---

## Core rules (non-negotiable)

1. **Classify first** — ecommerce | booking | saas-dashboard | auth-portal | blog-cms | social | fintech | generic.
2. **Map structure before acting** — tabs, sidebar, top-nav, drawers, forms, fields, action buttons.
3. **Complete coverage** — visit **every relevant** nav item / tab / primary CTA for that site type. No random sampling of 2–3 links.
4. **Explore in place** — on each surface, run field inventory + exploratory checks (validation, empty states, unusual UI). Do not only screenshot and leave.
5. **Consent before crucial actions** — pay, transfer, withdraw, send money, send link/email/WhatsApp/SMS, invite, place order, delete account/data. Ask in chat; honor `skip` / `no` / `cancel`.
6. **No random data in sensitive fields** — high-risk fields skipped; sensitive fields only with user-provided values.
7. **Report unusual** — missing labels, editable balances, PII in URL, confirm with no review step, password without `type=password`, etc.

---

## Pipeline

```
URL + login (once)
      ↓
RECON + CLASSIFY          → siteType, confidence, inferred journeys
      ↓
STRUCTURE MAP             → nav items, tabs, forms, fields, actions
      ↓
NATURE POLICY             → which surfaces are “relevant”; care level
      ↓
COMPLETE SURFACE SWEEP    → for EACH relevant item:
                            open → inventory fields → exploratory checks
                            → gate any crucial action → continue
      ↓
OPTIONAL MATRIX SWEEP     → generic A1–H3 only after nature pass (or in parallel
                            if user asked for both)
```

---

## Structure map (required artifact)

Before deep clicks, build and log a map:

| Section | Capture |
|---------|---------|
| Nav / tabs | label, href or role=tab, visible after hamburger/sidebar reveal |
| Forms | form id/name, field count, submit label |
| Fields | label/placeholder/name/type, risk: `safe` \| `sensitive` \| `high-risk` |
| Actions | button/link text, category: `nav` \| `safe` \| `crucial` |

**Relevant** = matches the site-type policy in [site-policies.md](site-policies.md)
(e.g. fintech: Accounts, Wallet, Transfer, History, Cards, Settings — not marketing footer links).

Skip: logout (unless testing session), external social share widgets, pure marketing footer, language switchers (unless asked).

---

## Complete exploration loop

For **each** relevant nav/tab/action marked `nav` or `safe`:

```
1. Open the surface (click tab / sidebar / button)
2. Wait for load / network idle (SPA-aware)
3. Field inventory + risk classify
4. Exploratory checks on THIS surface:
   - empty / loading / error UI
   - required-field empty submit (safe fields only)
   - broken images, blank main content, console errors
   - unusual findings (see below)
5. If a crucial action is present → CONSENT GATE (do not click yet)
6. Mark surface done; move to next unvisited relevant item
7. Stop only when all relevant items are visited or user aborts
```

**Anti-pattern:** clicking one “Transfer” button and calling the fintech journey done.  
**Required:** every account/wallet/history/settings-style tab that exists in the map.

---

## Consent gate (crucial actions)

Before clicking any action in the crucial set, pause and ask in live chat.

### Crucial patterns

| Pattern | Type | Ask for |
|---------|------|---------|
| Pay, Transfer, Send money, Withdraw, Top up | `payment` | `confirm: yes` + any required extras (amount, recipient) |
| Place order, Checkout, Buy now (final submit) | `purchase` | `confirm: yes` |
| Send, Share, Invite, Email, WhatsApp, SMS, Forward | `send_link` | `recipient: ...` (or skip) |
| Delete account, Close account, Remove beneficiary | `destructive` | `confirm: yes` |

### User replies

- Data / `confirm: yes` → proceed once with provided values only
- `skip` / `no` / `cancel` / `ignore` / `don't` / `not now` / `pass` → skip that action; continue exploring other surfaces
- Timeout / no reply → treat as skip; log finding that action was not exercised

Never invent recipient phone/email/account numbers. Never submit payment without explicit confirm.

---

## Field risk (same policy as generic agent)

| Risk | Examples | Behaviour |
|------|----------|-----------|
| high-risk | recipient, whatsapp, SMS, send-to, invite-email | Never fill randomly; only after consent + user value |
| sensitive | email, phone, card, bank, PAN, Aadhaar, amount (fintech) | No random data; user-provided only |
| safe | name, search, title, notes, quantity (non-money) | Safe placeholders OK for validation tests |

On fintech, treat **amount**, **account number**, **IFSC**, **beneficiary** as sensitive/high-risk even if labels are vague.

---

## Unusual findings to report

Flag when observed (severity by impact):

- Balance / amount appears editable without a transfer flow
- Transfer/Pay with **no** confirmation / review step
- Password or PIN field not `type=password` / `type=tel` masked
- PII or full account numbers in URL query
- Crucial button enabled with empty required fields and no client validation
- Same CTA performs send/pay without second factor when site otherwise uses OTP
- Tab/section empty with no empty-state message
- Nav item leads to blank page or infinite spinner (>10s)

---

## Site-type care levels

| Type | Care | Exploration emphasis |
|------|------|----------------------|
| fintech | **Maximum** | All money tabs; never auto-submit money movement; heavy unusual checks |
| ecommerce | High at checkout | Full catalog→cart path; gate Place order |
| booking | High at confirm | Search→select→details; gate final book |
| saas-dashboard | Medium–high | Every sidebar section; gate Invite / Delete / Billing |
| social | High on send | Feed + profiles; gate Send/Share/Message |
| blog-cms | Lower | Articles + search; gate only if publish/email exists |
| auth-portal | Auth-focused | Login/logout/redirect; no inventing credentials |
| generic | Structure-led | Full relevant nav map + forms; gate if crucial CTAs appear |

Details: [site-policies.md](site-policies.md).

---

## Relationship to generic matrix

| Mode | Skill | Behaviour |
|------|-------|-----------|
| Generic baseline | `generic-exploratory-qa` | Auth + classify + short journey + A1–H3 matrix |
| Site-nature complete | **this skill** | Full structure map + every relevant surface + consent + unusual findings |

When implementing code for this mode:
- Prefer extending `journey.ts` / `navigation.ts` / consent helpers over one-off scripts
- Persist discovered structure on session context if useful for later tasks
- Keep login once via `performSessionLogin` + `auth-state.json`
- Update this skill when policies or consent rules change

---

## Implementation checklist (for coding agents)

When the user asks to implement this skill in the product:

- [ ] Structure-map step after login (tabs/sidebar/forms/fields/actions)
- [ ] Complete sweep: iterate **all** relevant items, not a fixed 3-step happy path
- [ ] Per-surface exploratory checks + unusual-finding reporters
- [ ] Consent gate on every crucial action discovered (not only hardcoded Transfer)
- [ ] Stronger `runFintechJourney` (and other journeys) following [site-policies.md](site-policies.md)
- [ ] Chat prompts for consent + skip handling (reuse `_user_skip`)
- [ ] Cross-link from `AGENTS.md` / generic skill when behaviour ships
