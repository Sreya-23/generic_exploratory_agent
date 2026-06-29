# Exploration Matrix

Reference catalog for generic exploratory QA. Apply relevant flow classes to any target.

## UI & Interaction

| ID | Flow | Actions |
|----|------|---------|
| A1 | Happy path navigation | All menus, tabs, breadcrumbs, deep links |
| A2 | Form validation | Empty, min/max, special chars, unicode, emoji |
| A3 | Input boundary | 0, 1, max-1, max, max+1, negative |
| A4 | Double / rapid actions | Double-click submit, spam click while loading |
| A5 | Focus & keyboard | Tab order, Enter, Escape, shortcuts |
| A6 | Scroll & viewport | Mobile size, zoom 200%, sticky headers |
| A7 | Modal lifecycle | Open, close via X, overlay, Escape, back |
| A8 | Empty & loading states | Skeleton, spinner, empty lists |
| A9 | Error UI | Inline errors, toast duration |
| A10 | Copy/paste & autofill | Browser autofill, masked fields |
| A11 | File upload | Wrong type, huge file, cancel mid-upload |
| A12 | Pagination | Last page, jump pages, refresh mid-scroll |
| A13 | Multi-step wizard | Skip step via URL, back on step 3 |

## Navigation & Session

| ID | Flow | Why |
|----|------|-----|
| B1 | Back during API call | Orphan state, duplicate submit |
| B2 | Forward after back | Stale form resubmit |
| B3 | Refresh during request | Double charge |
| B4 | Close tab mid-operation | Partial persistence |
| B5 | Deep link without context | Missing session |
| B6 | Session timeout mid-flow | Re-auth, data loss |
| B7 | Logout in another tab | Silent 401 |
| B8 | Bookmark stale URL | Old IDs |

## Network & Chaos

| ID | Flow |
|----|------|
| C1 | Slow network (3G) |
| C2 | Offline mid-request |
| C3 | Offline → online recovery |
| C4 | Flaky network (50% drop) |
| C5 | Request timeout + retry |
| C6 | WebSocket disconnect |

## API

| ID | Flow |
|----|------|
| D1 | CRUD completeness |
| D2 | Auth matrix (no token, expired, wrong role) |
| D3 | Idempotency (duplicate POST) |
| D4 | Pagination edge (page=0, -1, huge) |
| D5 | Missing required fields |
| D6 | Type confusion |
| D7 | Rate limiting |
| D8 | Error shape consistency |

## Security

| ID | Flow |
|----|------|
| F1 | IDOR (change ID in URL) |
| F2 | Horizontal privilege |
| F3 | Vertical privilege |
| F4 | XSS in inputs |
| F5 | Mass assignment |

## Performance

| ID | Flow |
|----|------|
| G1 | Spike load |
| G2 | Large payload |
| G3 | N+1 UI pattern |
| G4 | Cold start |

## Regression

| ID | Flow |
|----|------|
| H1 | Golden path snapshot |
| H2 | API schema drift |
| H3 | Visual regression |
