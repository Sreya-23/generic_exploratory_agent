# Site-type exploration policies

Companion to [SKILL.md](SKILL.md). Defines what “complete” and “relevant” mean per site type.

---

## fintech (maximum care)

### Relevant surfaces (visit all that exist)
- Dashboard / home / overview
- Accounts / wallets / balances
- Cards
- Transfer / Pay / Send money / P2P
- Transaction history / statements
- Beneficiaries / payees
- KYC / profile / security / 2FA settings
- Bills / recharge (if present)

### On each surface
1. Inventory all fields; mark amount, account, IFSC, UPI, beneficiary as sensitive/high-risk
2. Check empty states, loading, validation on safe fields only
3. Unusual: editable balance, pay without confirm, PII in URL, unmasked secrets

### Crucial (consent required)
- Transfer, Pay, Send money, Withdraw, Top up, Add beneficiary, Pay bill
- Never submit with invented recipient or amount

### Explicitly do not
- Complete a real transfer without `confirm: yes` + user extras
- Rapid-click Pay/Transfer (matrix A4 may still probe UI disablement **without** confirming payment)

---

## ecommerce

### Relevant surfaces
- Home / category / search results
- Product detail (at least one product)
- Cart
- Checkout (open forms; do not place order without consent)
- Account / orders (if logged in)

### Crucial
- Place order / Pay now / Confirm purchase → consent

---

## booking

### Relevant surfaces
- Search / availability
- Results list
- Detail / room or slot selection
- Guest details form
- Confirmation step (gate final Book / Pay)

### Crucial
- Confirm booking / Pay → consent

---

## saas-dashboard

### Relevant surfaces
- Every primary sidebar / top-level nav item
- List → create/edit drawers or pages (fill safe fields only)
- Settings / billing / team (read + inventory; gate Invite / Delete / change plan)

### Crucial
- Invite member, Delete project/user, Update billing, Destroy resource → consent

---

## social

### Relevant surfaces
- Feed / home
- Profile (self or one other)
- Notifications
- Compose / message entry (do not send without consent)

### Crucial
- Send, Share, Message, Invite, Forward → consent  
- Like / Follow may proceed without consent unless user asked to avoid writes

---

## blog-cms

### Relevant surfaces
- Article list / categories
- Single article
- Search
- Author/about if linked from nav

### Crucial
- Publish, Send newsletter, Email author → consent if present

---

## auth-portal

### Relevant surfaces
- Login, register, forgot password, SSO entry
- Post-login landing only if credentials provided

### Crucial
- None beyond using user-provided credentials; never invent passwords or OTPs

---

## generic

### Relevant surfaces
- All primary nav / tab items discovered in structure map (cap only if user sets depth)
- All forms on those pages

### Crucial
- Any button matching pay / transfer / send / invite / delete patterns → consent

---

## Relevance filters (all types)

**Include:** main nav, sidebar, tabs, in-app CTAs tied to core product verbs.  
**Exclude by default:** footer legal links, app-store badges, external social icons, cookie banners (dismiss once), chat widgets that open third-party support.
