# Cryptio Software — Feature Breakdown

Source: "Cryptio software.mov" (~20:04, screen recording of `app.cryptio.co` on a demo workspace called "Stablecoin/Token Issuer"), in the MNBD Accounting folder. No usable narration was extracted, so this is a visual walkthrough of every screen the recording touches, sampled roughly every 30 seconds across the full runtime plus targeted frames around each screen transition.

---

## 1. Trial Balance (opening screen, 0:00–0:45)

The recording opens straight into **Trial Balance**, not a generic dashboard. Key elements:

- A banner flags **"Trial Balance Data is Outdated — Last updated: July 8, 2026 10:07 AM (28 days ago)"** with an "Update Now" button — the trial balance is a materialized/cached view that has to be explicitly refreshed, not always computed live.
- Two tabs: **Mapping** and **Reports**.
- A collapsible **"COA Hygiene"** panel (warning icon) sitting above the table — a dedicated data-quality check on the chart of accounts itself.
- A **Standard / Entity** view toggle — the same trial balance can be viewed consolidated or split per legal entity.
- A period picker with Start/End date fields and a full quick-range calendar: Today, Yesterday, This week, Last week, Last 30 days, This month, Last month, Last 3 months, Last 6 months, Last 9 months, This year, Last year, All — plus a "Select full history" checkbox and an "Account sources" filter.
- **"Export Filtered Trial Balance"** and **"Generate Trial Balances Report"** buttons.
- The table itself: standard trial balance shape (Opening Balance / Activity within period / Ending Balance) broken into real chart-of-accounts sections — Liabilities (Custodial digital asset liabilities, Stablecoins issued and outstanding, Token minting obligations, Token burning obligations), Equity, Income (**Realized gains on digital assets**, Redemption fee revenue, **Unrealized gains – digital assets**), Expense (**Gas fees**, Realized losses on digital assets, Unrealized losses – digital assets), down to Net Income. Every row has a **"See movements"** drill-through link.
- Realized and unrealized gains/losses on crypto are tracked as their own distinct income/expense line items, separate from gas fees.

## 2. Account Testing / drill-down into a specific account (0:00–0:45)

Clicking into an account (shown: "Realized gains on digital assets") opens an **"Account testing"** view — effectively a mini general ledger for that one account:

- Summary cards for Total Expenses and Net Income for that scope.
- A transaction table filtered to that account: Date, From/To, Incoming, Outgoing, Fee, Cost basis, Gains/Losses, **Label** (editable, pill-style), Status.
- Filter tabs: **All / Debit / Credit / Incomplete COA / Complete COA** — lets you specifically surface transactions whose chart-of-accounts mapping is still incomplete.

## 3. Sources — data ingestion (1:30–3:00)

**Sources** (under Data Management) lists every connected data source feeding the ledger:

- Tabs: **Imported Sources**, **Wallet Clusters**, **Protocols**, **Consolidos**, **Kilo** *(Feature Prep)*, **Source Operations** *(Feature Prep)*.
- A table of all sources (73 shown in the demo) with Type, Name, Entity, Address, Import Date, Data Range, Status, Last Updated, Transaction count, Cluster, and a per-row Comment field. Sources span exchanges and on-chain wallets across many chains (Ethereum, Base, Polygon, Optimism, Arbitrum, and more), each tagged with an icon for its chain/venue and a role like "Lending wallet" or "Corporate wallet".
- Global controls: **Auto-update** toggle, search-by-name, **Update all**, **Filter**, **Import**, **Export**.
- The **Import** flow is a searchable marketplace of integrations, tabbed **All / Exchanges / Chains / Custody / Data Bridge**, with a large logo grid (Kraken, Akash, Algorand, AlphaPoint, and dozens more visible). Below the grid: **"Batch source import"** and **"See CSV Example"** — CSV import is the fallback, not the primary path.
- Connecting an exchange (shown: Kraken) opens a named-connection form: Name, API Key, API Secret, and options — **"Fetch complete history"** and **"Auto trade consolidation"** *(Feature Prep)* toggles, plus an Advanced options section.

## 4. Transactions (3:30–7:30)

The core ledger view, and clearly the highest-traffic screen in the recording:

- **10,750 transactions** in the demo workspace, with a **"Needs review 47%"** indicator right next to the page title — an at-a-glance data-quality metric, not just a filter.
- Actions: **Filter**, **Update cost basis** (dropdown), **Invoices**, **Add Manual Transaction**.
- Table columns: Date, From/To, Incoming, Outgoing, Fee, Cost basis, Gains/Losses, **Label** (pill with inline edit), Status (gear icon per row for further actions).
- Every row is individually labeled (e.g. "Stablecoin Forward", "USDC mint/burn") — labels are the categorization unit that everything downstream (COA mapping, reports) keys off of.

### 4a. Filters

Opening **Filter** reveals two tabs:

- **Filter** — build a query from conditions: Labels ("is" / "all labels", with a **"Paste multiple"** bulk-entry option), Order Type, Import Type, **"+ Add filter"** for more conditions, plus two headline toggles: **"Select full history"** and **"Filter out spam"** (built-in spam/dust transaction filtering). Clear / Apply / **Favorite** (save the filter).
- **Favorite filters** — a list of saved filters (shown: "X Engine Deposits", "Unknown payout", "USDC token"), each with an **"Add rule"** button that promotes a saved filter into an ongoing auto-labeling rule, plus edit/delete and creation timestamps.

## 5. Chart of Accounts (5:30–11:00)

**Chart of Accounts** — *"Automate the mapping of accounts from your chart of accounts to the transactions in your Cryptio subledger."*

- Tabs: **All Accounts**, **COA Mappings**, **Classification Dimensions**, **Needs Review**.
- Within COA Mappings, five mapping types as sub-tabs: **All Mappings**, **Default Mapping**, **Source Mapping**, **Label Mapping**, **FMV & Impairment**.
- The mapping table: Type (Label/Source), Name, Movement count, Location, Entity, Department, Priority (star), delete. Rows mix system-level mappings (e.g. "Mock Burn" → Token burning obligations, "Mock Mint" → Token minting obligations) with business ones ("Fiat Deposit" → Stablecoins issued and outstanding, "Customer Deposits" → Custodial digital asset liabilities, "USDMinting", "Transaction Fees" → Gas fees).
- **"Apply Mappings"** and **"+ Add Mapping"** actions; pagination (5/10/25/50/100 per page).

### 5a. Mapping Details (per-label rule editor)

Clicking into a single label mapping (e.g. "Fiat Deposit", "Transaction Fees") opens a detailed rule editor with five sections:

1. **Label Mapping** — the Label Name and its target Account, with an option to map separate Debit and Credit accounts instead of one.
2. **Transaction Fee** — optionally override the fee accounts for transactions carrying this label (separate debit/credit), so a fee only gets its own account when it needs to; otherwise it falls back to the source/default fee account.
3. **Classification Dimensions** — assign Department, Location, and Entity to this mapping rule (both Department and Location showed "Network error" placeholders in the demo, suggesting these pull from a live dimension list).
4. **Asset Mapping** *(Optional)* — per-Asset / per-Cluster account overrides, with **"+ Add another asset mapping"** to stack more than one.
5. **Realised Gains and Losses** *(Optional)* — a dedicated "map all realised gains to" account selector, separate from the main label mapping.

This is a materially richer rule engine than a flat "label → account" table: one label can fan out into different debit/credit accounts, its own fee treatment, dimensional tagging, and per-asset overrides all in one rule.

## 6. Internal Controls & Audit (11:30–14:30)

**Controls & Risk Management**, under a Reporting → "Internal Controls & Audit" section (siblings: Data Integrity, Wallet Coverage, Related Parties):

- Tabs: **Controls Checklist**, **Testings Trail**, **General Audit Trail**.
- A checklist of pre-built control modules, each with a description, a Risk Type (Completeness / Accuracy / Compliance / Disclosures, Completeness & EOD), a Recommended Frequency, and per-control **"Add preparer"** / **"Add reviewer"** assignments plus a **"Test"** button — a real segregation-of-duties workflow, not just a static checklist. Modules shown:
  - Inventory: EVM Wallets completeness (Weekly)
  - Data Integrity: Balance Sanity Check (before month-end/year-end closing)
  - Data Integrity: Prices Sanity Check (before month-end closing)
  - Data Integrity: Cost Basis Sanity Check (before month-end closing)
  - Data Integrity: Manual Data (before month-end closing)
  - Internal Transfers Identification (Weekly)
  - **Potential Spams Review** — explicitly says it leverages a *"proprietary Spams Cleaner algorithm"* (before month-end closing)
  - Related Parties: Counterparties Identification (Monthly)
  - Trial Balance completeness/accuracy (before month-end closing)
  - Principal Market Pricing / GAAP-IFRS compliance (before year-end)
- **"Lock a period"** — an internal control that freezes transaction data (prices, labels, cost basis) up to a chosen date so nothing already booked can be edited afterward. Has its own toggle/lock control and date picker.

### Other sidebar sections glimpsed but not opened in this recording

The left nav exposes several modules the recording never actually clicks into — worth knowing they exist, even without visual confirmation of their contents:

- **Reconciliation**: AutoRec Engine, Token Supply, Token Reconciliation Engine
- **Accounting**: FS Mapping, Financial Statements, Multi-Inventory, Revaluation, ERP Integrations, Fund Accounting
- **Data Management**: Assets, Labels, Contacts, Smart Contract Functions, Data Bridge
- **Portfolio**: Positions, Positions Summary, FP&A *(Beta)*
- **Loan Management**: Overview, Loan List, Lending, Borrowing
- **Intelligence**: Principal Market Analysis, Close Center, COA benchmark, **Policy Generator**
- **APPS** (a top-level nav item, contents not shown)

## 7. Reports (14:30–16:30, revisited ~16:45)

**Reports** — *"Download and run reports for your accounting and compliance needs."*

- Tabs: **Run Reports**, **Report History**.
- Left rail of **Report Groups**: All, Monthly Reporting, Ledger Reporting, Balance Reporting, Audit Support, Archive, plus several integration-specific groups marked *Feature Flag*: Exceptions reports, Administrator Tools, Circle, Bridged transactions, Consensys, Filecoin Reporting Module. A Favorite section too.
- Under **Monthly Reporting** (14 reports total), each with a name, description, and a favorite star. Six were readable in the recording:
  - **Asset Roll Forward** — "a breakdown of asset balance by wallets: includes beginning balance, deposits, withdrawals and ending balance."
  - **Detailed Assets Roll Forward** — same, but broken down further by wallet *and* label activity.
  - **End of Month Reconciliation** — "a comparison report to summarize and reconcile the changes in asset balances, journal entries summarizing monthly activity and a transaction level view for the period. Please save a copy of this report each month as support for your completed reconciliation."
  - **Impairment Balance** *(Feature Flag)* — asset-level detail for a specific impairment adjustment.
  - **Ledger Entries** — "an export of transactions in journal entry format within a given period. These can be imported directly into a 3rd party ERP software."
  - **Ledger Entries (Fair Value)** — the fair-value-adjustment counterpart, also ERP-importable.

## 8. "Month End" Google Sheets export (~16:00)

A generated report opens as a **Google Sheets workbook named "Month End"**, with what looks like a bundled **Cryptio menu item** in the Sheets menu bar (alongside File/Edit/View/...) — this is a live add-on integration, not a one-time flat export. The workbook has one tab per report/period, seen tabs:

- Asset Reconciliation
- Ledger Reconciliation
- August Ending Balances
- **September Ending Balances** (shown open) — an "Asset Roll Forward" sheet with Source name, Asset symbol, Asset unique symbol, Beginning Units, Beginning Balance (USD), Deposits (Units/USD), Withdrawals (Units/USD), Realized P&L, Fair Value Adjustment, Impairments, Ending Units, Ending Balance (USD), and a **"Missing volume"** flag column per row.
- September Transaction History
- September Movement History
- **September Ledger Entries** (shown open) — a true double-entry journal export: Id, Label, Date (UTC), Account number, Account name, Asset, Volume, Debit (USD), Credit (USD), Order type, Source name, Other parties names/aliases (contacts), Notes, Transaction hash, Error, Transaction ID.
- September Trial Balances

## 9. Treasury (17:00–17:45, revisited ~17:15)

**Treasury** (Portfolio section) — a live holdings/exposure dashboard:

- **Overview** total value with "Last update [timestamp]" and a manual **Update** button, broken into a segmented bar: Staking Positions, Spot Assets, DeFi Positions, NFT Value.
- **Cluster** section, split two ways:
  - **Asset Clusters** — holdings bucketed as e.g. "Self-issued" vs. "Legitimate" (third-party) assets, each with its own dollar total and share of the bar.
  - **Wallet Clusters** — holdings bucketed by wallet role, e.g. "Corporate wallet" vs. "Lending wallet".
- **Holdings** table beneath: Asset (icon + ticker, e.g. USDT, USD Coin, USDb, US Dollar, AUSD, Morpho Token, Steakhouse USDC, Steakhouse USDC RWA, Ethereum, Lido Staked Ether), Cluster tag, Allocation (% with a small ring indicator), Amount, Cost Basis, Value, and a Wallets count — filterable by Asset/Cluster, paginated.

## 10. Entities (18:30–end)

**Entities** (Data Management → Entities), titled **"Entity Settings — Manage entities and their associated wallets."**

- **"Import from ERP"** and **"+ Create Entity"** actions.
- Table: Entity Code, Name, Wallets (chips, truncated list), Wallet Clusters, Actions (edit/delete). Demo shows two entities ("ENTUS01 — Stablecoin US Main", "ENTUS02 — Stablecoin US Entity 2"), each with its own wallet assignments.
- Confirms Cryptio has native multi-entity support with wallets assigned per entity, and can pull entity definitions from a connected ERP rather than only defining them manually.

---

## Notable patterns across the product

A few things show up repeatedly enough to call out as deliberate design choices, not one-offs:

- **Everything keys off "Labels."** A transaction gets a label (manually, by rule, or by a saved filter promoted to a rule), and every downstream mapping — COA, fee treatment, classification dimensions, realized-gains routing — is defined per label, not per transaction or per account directly.
- **Rules are layered, not flat.** A single label mapping can branch into separate debit/credit accounts, its own fee override, dimensional tags, per-asset sub-mappings, and its own realized-gains account — one rule doing the job of what would otherwise be five separate settings.
- **Data-quality signals are surfaced everywhere, not just in one "health" screen** — the 47% "Needs review" badge on Transactions, the "COA Hygiene" panel and Complete/Incomplete COA filters on Trial Balance, the "Missing volume" flag per row in the roll-forward export, and an entire Internal Controls & Audit module with assignable preparer/reviewer workflow and period-locking.
- **ERP interoperability is a first-class concern**, not an afterthought: Ledger Entries and Ledger Entries (Fair Value) reports are explicitly described as ERP-importable, entities can be imported *from* an ERP, and there's a dedicated "ERP Integrations" nav item.
- **Spam/dust filtering is built in**, both as a one-click "Filter out spam" toggle on Transactions and as its own named control ("Potential Spams Review," backed by a "proprietary Spams Cleaner algorithm").
