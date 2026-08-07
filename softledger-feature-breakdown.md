# SoftLedger Recording — Feature-by-Feature Breakdown

Source: "Screen Recording 2025-10-21 at 8.43.38 PM.mov" (16:52, Ben Taylor presenting `app.softledger.com`, tenant "Holding Company, Inc.", Fireflies notetaker bot present but transcript not pulled — this analysis is visual-only, from frames sampled every ~10s plus full-res detail crops).

No audio narration was available, so *why* Ben does things is inferred from UI context, not confirmed by his commentary. Flag anything here you know to be wrong.

---

## 1. Consolidated, multi-entity Balance Sheet (0:00–3:50)
**What the reference does:** Report Type = Balance Sheet, Select Report = Default. Columns run NORTH AMERICA | EU OPERATING ENTITY | HOLDING COMPANY | ELIMINATIONS | CONSOLIDATED — one balance sheet with a column per legal entity plus an eliminations column and a consolidated total. Row groups (CURRENT ASSETS → CASH → …) collapse/expand.
**Why:** Money Buddy or its holding structure apparently has (or is modeled with) multiple entities/subsidiaries that need combined reporting with intercompany eliminations.
**How the prototype differs:** `ledger-prototype.jsx` has a single flat ledger — one set of books, one Trial Balance/Income Statement/Balance Sheet, no entity dimension, no eliminations column, no consolidation.
**Files affected:** `ledger-prototype.jsx` (new "entity"/"location" dimension on transactions and accounts, Reports rewritten to pivot by entity), design doc (new architecture section).
**Risk:** Large. This is a structural change — every transaction needs an entity tag, and "eliminations" requires identifying intercompany accounts and auto-zeroing them, which is genuinely complex accounting logic. Recommend scoping this as its own multi-step effort, not a quick add.

## 2. Report templates / saved views ("Select Report: Default")
**What the reference does:** Alongside Report Type there's a "Select Report" dropdown — implies named, savable report configurations (e.g. different date ranges or entity groupings saved as "Default", possibly others).
**Why:** Lets a user re-run a report configuration without rebuilding filters each time.
**How the prototype differs:** No concept of saved report configs; Reports tab is a fixed live computation.
**Files affected:** `ledger-prototype.jsx` Reports tab.
**Risk:** Low-medium, but low value until entity/date-range dimensions (items 1 and 8) exist to make a "saved view" meaningful.

## 3. Analytics dashboard (0:40–2:30ish)
**What the reference does:** A separate "Analytics" nav item shows a "Financials Overview" dashboard: cash on hand, revenue, a trend chart, an expense breakdown, and an "Intercompany Balances by Location" panel with a location filter and reported-currency selector.
**Why:** At-a-glance financial health view, and specifically surfaces intercompany balances (ties to item 1's consolidation/eliminations).
**How the prototype differs:** No dashboard/Analytics tab exists at all.
**Files affected:** New tab in `ledger-prototype.jsx`; depends on item 1's entity model for the intercompany panel to mean anything.
**Risk:** Medium. Charting is easy; the intercompany balances panel is only meaningful once multi-entity exists.

## 4. Coins — master asset reference list (`/v2/coins`, ~4:00–5:10)
**What the reference does:** A global list of *tradable assets* — not wallets, not holdings. Rows include Aave, ApeCoin, **Apple Computer (AAPL)**, **Bank of America 0.50% bond**, Basic Attention Token, Binance Coin, Bitcoin — i.e. crypto *and* equities/bonds all live in the same reference table, each with a Symbol and Market Rate. Clicking a coin (e.g. BTC) opens a metadata form: Name, Symbol, Rate Symbol, Is Fiat, Contract Address, Asset Type, Chain, Category, plus "Include Balances for Wallets in Child Locations."
**Why:** Single source of truth for "what is this asset, what's it worth, and how do we price it" — decoupled from any specific wallet or holding.
**How the prototype differs:** Nothing like this exists. The prototype has no asset master list and no market-rate concept; the COA's crypto accounts are just static Asset accounts with a name.
**Files affected:** New data structure in `ledger-prototype.jsx` (coins/assets array), new tab, and it becomes a dependency for items 5–7 below.
**Risk:** Medium — mostly new surface area, low logic risk on its own, but it's foundational to the rest of the Crypto section.

## 5. Wallets — dedicated custody register (`/v2/wallets`, ~7:20–8:00)
**What the reference does:** A list of named wallets (Copper, Customer Holdings, Daedalus, DeFi Trading, ETH Staking…) each with an on-chain Address, Wallet Type, Location, Exchange, Blockchain, Compliance Status.
**Why:** Wallets are custody locations, distinct from the accounting *account* they map to — same relationship as "bank" is to "cash account" in the fiat side.
**How the prototype differs:** This is the biggest conceptual gap. The prototype treats each wallet/venue as **just a line in the Chart of Accounts** (e.g. `112101 Bitgo hot wallet - Company`, `121102 Binance spot - Company #Crypto`). There's no separate wallet entity with its own address/type/compliance metadata — the wallet *is* the account.
**Files affected:** `ledger-prototype.jsx` (new wallets array distinct from `accounts`, each wallet linking to an underlying Asset account), COA UI, accounting-software-design.md.
**Risk:** Medium-high. This changes the data model most existing crypto logic (accounts, code-suggester, transaction templates) currently assumes ("wallet name == account name"). Needs careful sequencing if adopted.

## 6. Crypto Transactions module (`/v2/cryptoTransactions/transactions`, ~8:00–13:20)
**What the reference does:** A dedicated transaction list for crypto activity (Deposit/Withdrawal/Transfer/Trade, filterable by Type) with `IMPORT`, `EDIT COST BASIS`, and `BUILD JOURNALS` actions. "Add Transaction" modal fields, by type:
- Type (Deposit shown; filter panel confirms Deposit/Withdrawal/Transfer/Trade)
- Received Coin (searchable, references item 4), Received Wallet (references item 5, with inline "+" to create one), Received Quantity, Per Coin Price (with a "Get Rate" auto-fetch button, defaults to market rate if blank)
- Fee Coin / Fee Quantity / Fee Per Coin Price (optional second leg)
- Date, **Ledger Account** (the contra/offset account — e.g. `405000` revenue for a mining-reward deposit, or an investment/equity account for a capital contribution), Reference, TX Hash, Notes, attachments
**Why:** This *is* Section C/D territory (token swaps, trades) — a structured, typed entry form per crypto activity type, each of which implies a specific set of debits/credits, rather than free-text bank-feed categorization.
**How the prototype differs:** The prototype's `Transaction Types` template engine covers structured internal events (referrals, gas fees) generically via `{field}`-templated legs, but has no crypto-specific Deposit/Withdrawal/Transfer/Trade typing, no coin/wallet/quantity/price triad, no per-transaction "Get Rate" market pricing, and no Fee as a distinct second leg.
**Files affected:** `ledger-prototype.jsx` — likely a new screen/model rather than forcing this into the existing template engine, since the reference's fields are richer and type-specific (Trade in particular will need two-sided coin legs). accounting-software-design.md.
**Risk:** High. This is exactly the "Section C/D" work you'd previously flagged as too complex to guess at — cost-basis-affecting entries (Deposit adds a cost layer, Withdrawal/Trade consumes one via FIFO) need to be gotten right or a real ledger's tax-lot accounting breaks.

## 7. Build Journals → Draft journal entries (~11:20–11:50)
**What the reference does:** "BUILD JOURNALS" turns a batch of crypto transactions into journal entries in **Draft** status (Journal #3399: Source Ledger = Crypto, Reference = "Crypto Deposit", Status = Draft, Entry Type = Standard, with Location/IC Location/Posted Currency and a link back to the source crypto transaction).
**Why:** Two-phase posting — build (compute the debits/credits, including FIFO cost basis) as a reviewable draft, then presumably a separate approve/post step before it hits the real ledger.
**How the prototype differs:** Every posted prototype transaction goes straight to the live journal — there's no draft/review stage anywhere in the app (bank import posts directly once categorized; transaction-type templates post immediately once matched).
**Files affected:** `ledger-prototype.jsx` posting logic broadly, if adopted.
**Risk:** Medium-high, and it's a workflow-philosophy decision, not just a feature — worth explicitly deciding whether Money Buddy wants a draft/review gate before committing to it.

## 8. Unused Cost Layers — FIFO lot tracker (`/v2/cryptoTransactions/unused_cost_layers`, ~12:00–13:20)
**What the reference does:** A second tab next to "Transactions" listing every Deposit lot (ID, Type, Date, remaining Quantity) that hasn't been fully consumed yet — a live FIFO tax-lot ledger.
**Why:** Crypto disposals (withdrawals, trades) need a cost basis, and FIFO lot tracking is the standard way to compute realized gain/loss per disposal.
**How the prototype differs:** No cost-basis/lot concept exists anywhere in the prototype.
**Files affected:** Tightly coupled to item 6 (Crypto Transactions) — a Deposit creates a lot here, a Withdrawal/Trade consumes lots FIFO and that consumption drives the realized-gain journal entry.
**Risk:** High — this is real accounting logic (FIFO matching, partial-lot consumption, realized gain/loss calculation) that needs verification against sample data before trusting it, per your established pattern.

## 9. Bank Transactions + multi-tenant switcher (~13:20–16:40)
**What the reference does:** The fiat side (`Bank Transactions`) looks close to the prototype's Import/Categorize screen — a date-range picker, a transaction list with description/category/cleared/posted date/amount. But getting there involved a **"Select a Tenant to continue"** modal listing separate tenants: "2025 Demo," "Holding Company, Inc.," "Bar Bar," and others — these are fully separate company books, not just a location tag within one ledger.
**Why:** SoftLedger is multi-tenant at the account level — Ben switched from the "Holding Company, Inc." demo tenant to a different one ("2025 Demo") partway through, which is why the screenshots after ~13:50 show a different (smaller) COA in the left rail.
**How the prototype differs:** Single ledger, single company, no tenant concept — this is a bigger structural question than item 1's consolidation, and them coexisting (tenants *and* entities-within-a-tenant with consolidation) suggests two separate axes: tenant = separate company entirely, entity/location = subsidiary within one company's consolidated books.
**Files affected:** Architectural — would touch the design doc's roadmap and possibly the entire app shell.
**Risk:** High if pursued now; recommend treating as a roadmap item unless Money Buddy actually needs multiple separate legal entities each with fully separate books (as opposed to one consolidated set, which is item 1).

---

## What I'd suggest as a starting point

Items 4, 5, and 6 (Coins → Wallets → Crypto Transactions) form one coherent thread that directly extends your existing crypto COA work and gets you closest to answering the Section C/D question you'd deliberately deferred. Item 8 (FIFO cost layers) is the highest-risk piece and depends on 6. Items 1, 3, and 9 (multi-entity consolidation, dashboard, multi-tenant) are architecturally heavier and probably deserve their own dedicated pass rather than being threaded in alongside the crypto work.

I haven't written any code yet — this is the "what/why/risk" pass. Let me know which feature(s) to start on and I'll implement one at a time, verifying accounting logic against simulated data the way we did for cash flow and split transactions.
