import { useState, useEffect, useMemo, useRef, useContext, createContext } from "react";
import Papa from "papaparse";
import {
  BookOpen, Upload, ListChecks, ScrollText, BarChart3, Plus, Trash2,
  CheckCircle2, AlertTriangle, Landmark, Pencil, FileUp, Sparkles,
  Layers, Wand2, XCircle, Power, Zap, Coins as CoinsIcon, Wallet as WalletIcon,
  ArrowLeftRight, RefreshCw, Gauge, Building2, Settings as SettingsIcon, Languages, Scale,
  ChevronRight, ChevronDown
} from "lucide-react";

// ---------- constants & seed data ----------

const TYPES = ["Asset", "Liability", "Equity", "Income", "Expense"];

const NORMAL_BALANCE = {
  Asset: "debit", Expense: "debit",
  Liability: "credit", Equity: "credit", Income: "credit",
};

const CATEGORY_DIGIT = { Asset: "1", Liability: "2", Equity: "3", Income: "4", Expense: "5" };

// Cash-flow classification for Asset/Liability/Equity accounts. "cash" marks
// cash & cash equivalents - the thing the whole statement reconciles to, so
// those accounts are excluded from the operating/investing/financing split.
const CF_LABELS = { cash: "Cash", operating: "Operating", investing: "Investing", financing: "Financing" };
const CF_ORDER = ["operating", "investing", "financing"];
const defaultCf = (type) => (type === "Equity" ? "financing" : "operating");

// Real codes are structured (Category-Type-Subgroup-Sequential); a simple
// "next number up" suggestion is a starting point, not a substitute for
// picking the right subgroup - the field stays freely editable.
function suggestAccountCode(type, accounts) {
  const digit = CATEGORY_DIGIT[type];
  const used = accounts.filter((a) => a.type === type).map((a) => parseInt(a.code, 10));
  const base = parseInt(`${digit}00000`, 10);
  const max = used.length ? Math.max(...used) : base;
  return String(Math.max(max + 1, base));
}

// Reuse a Category+Type+Subgroup prefix (first 4 digits) and find the next
// unused sequential 2-digit slot within it, reserving 99 as the catch-all.
function suggestNextInSubgroup(prefix4, accounts) {
  const used = accounts
    .filter((a) => a.code.startsWith(prefix4) && a.code.length === 6)
    .map((a) => parseInt(a.code.slice(4), 10));
  for (let n = 1; n <= 98; n++) {
    if (!used.includes(n)) return prefix4 + String(n).padStart(2, "0");
  }
  return prefix4 + "99";
}

// Looks for an existing group of accounts that share a naming pattern with
// `name` across *different* first words (venues/banks) - e.g. "Binance spot -
// Company #Crypto" / "Kraken spot - Company #Crypto" / "OKX spot - Company
// #Crypto" all share everything after the first word. Tried two ways because
// venue names (constant suffix, e.g. "spot - Company #Crypto") and bank names
// (unique account number in the middle, only the trailing currency tag is
// shared, e.g. "... #USD") repeat differently.
function detectNamingFamily(name, type, accounts) {
  const tokens = (name || "").trim().split(/\s+/);
  if (tokens.length < 2) return null;

  // Strategy A: everything after the first word matches exactly (venue-style).
  const fullSuffix = tokens.slice(1).join(" ").toLowerCase();
  const bySuffix = accounts.filter((a) => {
    const t = a.name.trim().split(/\s+/);
    return a.type === type && t.length > 1 && t.slice(1).join(" ").toLowerCase() === fullSuffix;
  });
  if (bySuffix.length >= 2) return bySuffix;

  // Strategy B: only the last word matches (bank-style - the middle is a
  // unique account number). Require the matches to agree on Category+Type
  // (first 2 code digits) so an incidental shared tag like "#USD" can't pull
  // together two unrelated families (e.g. fiat banks vs. exchange balances).
  const lastToken = tokens[tokens.length - 1].toLowerCase();
  const candidates = accounts.filter((a) => {
    const t = a.name.trim().split(/\s+/);
    return a.type === type && t.length > 1 && t[t.length - 1].toLowerCase() === lastToken;
  });
  if (candidates.length < 2) return null;
  const counts = {};
  candidates.forEach((a) => { const p = a.code.slice(0, 2); counts[p] = (counts[p] || 0) + 1; });
  const bestPrefix = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const filtered = candidates.filter((a) => a.code.slice(0, 2) === bestPrefix);
  return filtered.length >= 2 ? filtered : null;
}

// A brand-new venue/bank for an established pattern needs a *new* subgroup,
// not another sequential slot inside an existing one. Figure out which
// subgroup digit actually encodes "which venue" by checking which one varies
// across the family, then extend it - first account in a new subgroup starts
// sequential at 01.
function extendSubgroupForNewVenue(family) {
  const subgroups = family.map((a) => a.code.slice(2, 4));
  const s1 = subgroups.map((s) => s[0]);
  const s2 = subgroups.map((s) => s[1]);
  const s1Const = s1.every((d) => d === s1[0]);
  const s2Const = s2.every((d) => d === s2[0]);
  let newSubgroup;
  if (s2Const && !s1Const) newSubgroup = String(Math.max(...s1.map(Number)) + 1) + s2[0];
  else if (s1Const && !s2Const) newSubgroup = s1[0] + String(Math.max(...s2.map(Number)) + 1);
  else newSubgroup = String(Math.max(...subgroups.map((s) => parseInt(s, 10))) + 1).padStart(2, "0");
  return family[0].code.slice(0, 2) + newSubgroup + "01";
}

// Priority: (1) this exact venue/bank already has an account -> just extend
// its own subgroup. (2) never-seen venue, but the rest of the name matches an
// established multi-venue pattern -> extend that pattern with a new subgroup.
// (3) a manually-picked "similar" account -> extend its subgroup. (4) nothing
// to go on -> crude next-code-in-category fallback.
function suggestAccountCodeSmart(name, type, similarId, accounts) {
  const tokens = (name || "").trim().split(/\s+/);
  const venue = (tokens[0] || "").toLowerCase();

  if (venue) {
    const sameVenue = accounts.find((a) => a.type === type && a.name.trim().split(/\s+/)[0].toLowerCase() === venue);
    if (sameVenue) return suggestNextInSubgroup(sameVenue.code.slice(0, 4), accounts);
  }

  const family = detectNamingFamily(name, type, accounts);
  if (family) return extendSubgroupForNewVenue(family);

  const similar = accounts.find((a) => a.id === similarId);
  if (similar) return suggestNextInSubgroup(similar.code.slice(0, 4), accounts);

  return suggestAccountCode(type, accounts);
}

const uid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Money Buddy chart of accounts. isBank marks the accounts that receive CSV
// bank-statement imports (the fiat operating accounts) - the custody wallets
// and venue holdings are posted via structured events (Transaction Types),
// not free-text bank-feed rows.
const DEFAULT_ACCOUNTS = [
  // ---- Assets ----
  { id: "acc_110101", code: "110101", name: "ACLEDA 0001-05709974-1-5 #USD", type: "Asset", isBank: true, cf: "cash" },
  { id: "acc_110102", code: "110102", name: "ACLEDA 0001-05709974-1-6 #KHR", type: "Asset", isBank: true, cf: "cash" },
  { id: "acc_110201", code: "110201", name: "ABA 013236987 #USD", type: "Asset", isBank: true, cf: "cash" },
  { id: "acc_110202", code: "110202", name: "ABA 013236995 #KHR", type: "Asset", isBank: true, cf: "cash" },
  { id: "acc_110301", code: "110301", name: "Phillip 000266847 #USD", type: "Asset", isBank: true, cf: "cash" },
  { id: "acc_110302", code: "110302", name: "Phillip 000266850 #KHR", type: "Asset", isBank: true, cf: "cash" },
  { id: "acc_112101", code: "112101", name: "Bitgo - Company #USD", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_112102", code: "112102", name: "Bitgo hot wallet - Company #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_112103", code: "112103", name: "Bitgo hot wallet - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112104", code: "112104", name: "Bitgo cold wallet - Company #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_112105", code: "112105", name: "Bitgo cold wallet - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112106", code: "112106", name: "Bitgo gas wallet - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113101", code: "113101", name: "Bitgo hot wallet - for Client #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_113102", code: "113102", name: "Bitgo hot wallet - for Client #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113103", code: "113103", name: "Bitgo cold wallet - for Client #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_113104", code: "113104", name: "Bitgo cold wallet - for Client #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113105", code: "113105", name: "Bitgo earn wallet - for Client", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113201", code: "113201", name: "Defi pool - for Client", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_121102", code: "121102", name: "Binance spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_121103", code: "121103", name: "Binance spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_131101", code: "131101", name: "Binance margin - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_132101", code: "132101", name: "Binance - Futures position MTM (asset side)", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_122102", code: "122102", name: "Kinesis spot - Company #USD", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_122103", code: "122103", name: "Kinesis spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_122104", code: "122104", name: "Kinesis spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_123102", code: "123102", name: "Kraken spot - Company #USD", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_123103", code: "123103", name: "Kraken spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_123104", code: "123104", name: "Kraken spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_131102", code: "131102", name: "Kraken margin - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_132102", code: "132102", name: "Kraken - Futures position MTM (asset side)", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_124102", code: "124102", name: "OKX spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_124103", code: "124103", name: "OKX spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_131103", code: "131103", name: "OKX margin - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_132103", code: "132103", name: "OKX - Futures position MTM (asset side)", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_140101", code: "140101", name: "Client fee receivable", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_140102", code: "140102", name: "Client Earn yield accrued", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_140201", code: "140201", name: "BNPL Collateral Escrow", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_140301", code: "140301", name: "Cash / Bank clearing", type: "Asset", isBank: false, cf: "cash" },
  { id: "acc_140401", code: "140401", name: "BNPL principal receivable", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_140501", code: "140501", name: "Accrued interests receivable", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_140601", code: "140601", name: "Allowance for impairment on asset", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_150101", code: "150101", name: "Shareholders' Equity Receivable", type: "Asset", isBank: false, cf: "financing" },
  { id: "acc_150102", code: "150102", name: "Security deposit", type: "Asset", isBank: false, cf: "investing" },
  { id: "acc_150199", code: "150199", name: "Other asset", type: "Asset", isBank: false, cf: "operating" },
  // ---- Liabilities ----
  { id: "acc_210101", code: "210101", name: "Customer Collateral Payable - prepaid", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_210102", code: "210102", name: "Customer Collateral Payable - financed", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_210201", code: "210201", name: "Liquidation settlement clearing", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_210302", code: "210302", name: "Client custody payable", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_210401", code: "210401", name: "P2P escrow payable", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230101", code: "230101", name: "Lender", type: "Liability", isBank: false, cf: "financing" },
  { id: "acc_221101", code: "221101", name: "Binance - Futures position MTM (liability side)", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_221102", code: "221102", name: "Kraken - Futures position MTM (liability side)", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_221103", code: "221103", name: "OKX - Futures position MTM (liability side)", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_221201", code: "221201", name: "Derivative - Underlying mismatch payable", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230201", code: "230201", name: "Network fee liability", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230301", code: "230301", name: "Current tax liabilities", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230401", code: "230401", name: "Accrued interests payable", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230402", code: "230402", name: "Accrued expense", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230501", code: "230501", name: "Salary payable", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230599", code: "230599", name: "Other payable", type: "Liability", isBank: false, cf: "operating" },
  { id: "acc_230601", code: "230601", name: "Gas fee clearing", type: "Liability", isBank: false, cf: "operating" },
  // ---- Equity ----
  { id: "acc_310101", code: "310101", name: "Share capital", type: "Equity", isBank: false, cf: "financing" },
  { id: "acc_310201", code: "310201", name: "Net profit", type: "Equity", isBank: false, cf: "financing" },
  { id: "acc_310202", code: "310202", name: "Retained Earnings", type: "Equity", isBank: false, cf: "financing" },
  // Standard bridging account for migrating an existing ledger in: every
  // account's stated opening balance posts against this instead of a real
  // contra account, since there usually isn't one - same convention
  // QuickBooks/Xero use for their own opening-balance conversion entries.
  { id: "acc_310299", code: "310299", name: "Opening Balance Equity", type: "Equity", isBank: false, cf: "financing" },
  // ---- Income ----
  { id: "acc_410101", code: "410101", name: "Revenue - withdraw fee", type: "Income", isBank: false },
  { id: "acc_410102", code: "410102", name: "Revenue - convert fee", type: "Income", isBank: false },
  { id: "acc_410201", code: "410201", name: "Revenue - trading spread", type: "Income", isBank: false },
  { id: "acc_410301", code: "410301", name: "Revenue - P2P merchant markup fee", type: "Income", isBank: false },
  { id: "acc_410401", code: "410401", name: "Revenue - Earn yield spread", type: "Income", isBank: false },
  { id: "acc_410501", code: "410501", name: "Revenue - BNPL early termination fee", type: "Income", isBank: false },
  { id: "acc_420101", code: "420101", name: "Interest income", type: "Income", isBank: false },
  { id: "acc_420102", code: "420102", name: "Bank interest income", type: "Income", isBank: false },
  { id: "acc_420201", code: "420201", name: "Dividend income", type: "Income", isBank: false },
  { id: "acc_430101", code: "430101", name: "Gains on Exchange Rate", type: "Income", isBank: false },
  { id: "acc_440101", code: "440101", name: "Unrealised gain on asset held (P/L)", type: "Income", isBank: false },
  { id: "acc_440102", code: "440102", name: "Realized gain on asset held", type: "Income", isBank: false },
  { id: "acc_440201", code: "440201", name: "Unrealised gain on derivatives", type: "Income", isBank: false },
  { id: "acc_440202", code: "440202", name: "Realized gain on derivatives", type: "Income", isBank: false },
  // ---- Expenses ----
  { id: "acc_510101", code: "510101", name: "Loss on liquidation shortfall", type: "Expense", isBank: false },
  { id: "acc_520101", code: "520101", name: "Renting server", type: "Expense", isBank: false },
  { id: "acc_520201", code: "520201", name: "Marketing expenses", type: "Expense", isBank: false },
  { id: "acc_520301", code: "520301", name: "Gas fee", type: "Expense", isBank: false },
  { id: "acc_520302", code: "520302", name: "Trading fee", type: "Expense", isBank: false },
  { id: "acc_530101", code: "530101", name: "Interest expense", type: "Expense", isBank: false },
  { id: "acc_530201", code: "530201", name: "Bank Fees", type: "Expense", isBank: false },
  { id: "acc_530202", code: "530202", name: "Bank Charge", type: "Expense", isBank: false },
  { id: "acc_530203", code: "530203", name: "Service charge", type: "Expense", isBank: false },
  { id: "acc_530204", code: "530204", name: "Regulatory fees", type: "Expense", isBank: false },
  { id: "acc_540101", code: "540101", name: "Salary", type: "Expense", isBank: false },
  { id: "acc_540102", code: "540102", name: "Human resources professional services", type: "Expense", isBank: false },
  { id: "acc_540201", code: "540201", name: "Rental", type: "Expense", isBank: false },
  { id: "acc_550101", code: "550101", name: "Loss from property impairment", type: "Expense", isBank: false },
  { id: "acc_560101", code: "560101", name: "Income tax expense", type: "Expense", isBank: false },
  { id: "acc_550102", code: "550102", name: "Loss from disposal of assets", type: "Expense", isBank: false },
  { id: "acc_540301", code: "540301", name: "Audit fee", type: "Expense", isBank: false },
  { id: "acc_570101", code: "570101", name: "Losses on Exchange Rate", type: "Expense", isBank: false },
  { id: "acc_580101", code: "580101", name: "Unrealised loss on asset held (P/L)", type: "Expense", isBank: false },
  { id: "acc_580102", code: "580102", name: "Realized loss on asset held", type: "Expense", isBank: false },
  { id: "acc_580201", code: "580201", name: "Unrealised loss on derivatives", type: "Expense", isBank: false },
  { id: "acc_580202", code: "580202", name: "Realized loss on derivatives", type: "Expense", isBank: false },
  { id: "acc_580301", code: "580301", name: "Fair value adjustment", type: "Expense", isBank: false },
  { id: "acc_590199", code: "590199", name: "Other Exp.", type: "Expense", isBank: false },
];

// Legal entities for multi-entity consolidation - scoped exclusively to
// Money Buddy's own ownership chain (per your correction), not the wider
// group org chart. Money Buddy KH Co., Ltd is owned directly by two
// parents - Nativ Holdings, Inc. and PGVI Capital Advisors Co., Ltd - both
// modeled as top-level entities here since nothing further up their own
// chain is relevant to Money Buddy's books. Ownership % between the two
// parents wasn't specified, so it's left blank (null) rather than guessed;
// fill it in via the Ownership Structure table once known.
//
// Per your earlier call: ownership % is tracked as metadata only - even a
// less-than-100%-owned entity still runs through the same full-
// consolidation + Eliminations model already built (no NCI split, no
// equity-method carve-out) - a deliberate simplification worth revisiting
// if this ever needs to produce audited consolidated financials.
const DEFAULT_ENTITIES = [
  { id: "ent_nativ_holdings", name: "Nativ Holdings, Inc.", jurisdiction: "BVI", parentId: null, ownershipPct: null },
  { id: "ent_pgvi", name: "PGVI Capital Advisors Co., Ltd", jurisdiction: "Cambodia", parentId: null, ownershipPct: null },
  { id: "ent_moneybuddy_kh", name: "Money Buddy KH Co., Ltd", jurisdiction: "Cambodia", parentId: "ent_nativ_holdings", ownershipPct: null, secondParentId: "ent_pgvi", secondOwnershipPct: null },
];

// A minimal, generic starting chart of accounts for any tenant that isn't
// Money Buddy itself - just enough to post a first entry (cash, a
// receivable/payable pair, equity, one revenue and one expense bucket).
// Money Buddy's own 100+ accounts (ACLEDA/ABA/Phillip banks, Bitgo/Binance/
// Kraken/OKX custody, client payables, etc.) are specific to that one real
// business and have no business being the default COA for an unrelated
// company added later via "Manage tenants".
function blankStarterEntity(tenantName) {
  return { id: "ent_self", name: tenantName || "Primary Entity", jurisdiction: "", parentId: null, ownershipPct: null };
}
// Same 6-digit code convention Money Buddy's own COA uses (leading digit =
// type: 1 Asset, 2 Liability, 3 Equity, 4 Income, 5 Expense, followed by a
// 2-digit subgroup and a 2-digit sequence within it) so a new tenant's
// codes look and sort consistently with the rest of the app instead of a
// different ad hoc short-code scheme.
const BLANK_STARTER_ACCOUNTS = [
  { id: "acc_blank_cash", code: "110101", name: "Cash", type: "Asset", isBank: true, cf: "cash", entityId: "ent_self" },
  { id: "acc_blank_ar", code: "120101", name: "Accounts Receivable", type: "Asset", isBank: false, cf: "operating", entityId: "ent_self" },
  { id: "acc_blank_ap", code: "210101", name: "Accounts Payable", type: "Liability", isBank: false, cf: "operating", entityId: "ent_self" },
  { id: "acc_blank_stock", code: "310101", name: "Common Stock", type: "Equity", isBank: false, cf: "financing", entityId: "ent_self" },
  { id: "acc_blank_re", code: "310201", name: "Retained Earnings", type: "Equity", isBank: false, cf: "financing", entityId: "ent_self" },
  { id: "acc_blank_revenue", code: "410101", name: "Revenue", type: "Income", isBank: false, entityId: "ent_self" },
  { id: "acc_blank_opex", code: "510101", name: "Operating Expenses", type: "Expense", isBank: false, entityId: "ent_self" },
];

// Each tenant carries a `seed` profile deciding what it starts from. The
// original "moneybuddy" tenant gets the real, hand-built COA/entities/
// transaction-type registry/bank rules this whole file was built around;
// every other tenant (added later via "Manage tenants") gets the blank
// generic starter above instead - a fresh company shouldn't open onto
// someone else's bank accounts and crypto wallets.
// Label mappings rebuilt from Money Buddy's authoritative Dr/Cr settlement
// sheet. Each label is the full journal entry for an event type as legs
// {accountId, side, pct-of-value}; legs on a wallet/custody account are flagged
// wallet:true and posted by the FIFO cost-basis engine, so only the non-wallet
// (contra) legs are applied to an imported crypto transaction. A label applies
// to a Deposit or Withdrawal when its non-wallet legs net to a full contra
// (+100% credit or -100% debit); the rest (transfers, trades, futures, loans)
// are kept as a faithful reference and flagged in the list.
const DEFAULT_CRYPTO_LABELS = [
  { id: "sl_a1", label: "Client crypto deposit", status: "active", legs: [{ accountId: "acc_113102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "credit", pct: 100 }] },
  // Client withdrawal: the recorded amount is the GROSS debited from the client
  // (net sent on-chain + the withdrawal fee Money Buddy keeps). `withdrawFeeRevenue`
  // tells the engine to carve the flat fee (from the fee schedule) out of the
  // wallet outflow and book it to fee revenue - see the Withdrawal branch.
  { id: "sl_a2", label: "Client crypto withdrawal", status: "active", withdrawFeeRevenue: true, feeAccountId: "acc_410101", feeReceivableAccountId: "acc_140101", legs: [{ accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a3", label: "Wallet-to-wallet internal transfer", status: "active", legs: [{ accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }] },
  { id: "sl_a4", label: "Sweep hot to cold (client)", status: "active", legs: [{ accountId: "acc_113104", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a5_okx", label: "Transfer USDT from Bitgo to OKX spot", status: "active", legs: [{ accountId: "acc_124102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a5_bin", label: "Transfer USDT from Bitgo to Binance spot", status: "active", legs: [{ accountId: "acc_121103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a5_kraken", label: "Transfer USDT from Bitgo to Kraken spot", status: "active", legs: [{ accountId: "acc_123103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a5_kinesis_usdt", label: "Transfer USDT from Bitgo to Kinesis", status: "active", legs: [{ accountId: "acc_122103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a5_kinesis_kau", label: "Transfer KAU from Bitgo to Kinesis", status: "active", legs: [{ accountId: "acc_122104", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a6_okx", label: "Fund OKX margin from OKX spot", status: "active", legs: [{ accountId: "acc_131103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_124102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a6_bin", label: "Fund Binance margin from Binance spot", status: "active", legs: [{ accountId: "acc_131101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_121103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a6_kraken", label: "Fund Kraken margin from Kraken spot", status: "active", legs: [{ accountId: "acc_131102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_123103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_okx_usdt_to_crypto", label: "OKX spot buy — USDT to crypto", status: "active", kind: "trade", legs: [{ accountId: "acc_124103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_124102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_okx_crypto_to_usdt", label: "OKX spot sell — crypto to USDT", status: "active", kind: "trade", legs: [{ accountId: "acc_124102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_124103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_bin_usdt_to_crypto", label: "Binance spot buy — USDT to crypto", status: "active", kind: "trade", legs: [{ accountId: "acc_121102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_121103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_bin_crypto_to_usdt", label: "Binance spot sell — crypto to USDT", status: "active", kind: "trade", legs: [{ accountId: "acc_121103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_121102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_kraken_usdt_to_stock", label: "Kraken spot buy — USDT to stock", status: "active", kind: "trade", legs: [{ accountId: "acc_123104", side: "debit", pct: 100, wallet: true }, { accountId: "acc_123103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_kraken_stock_to_usdt", label: "Kraken spot sell — stock to USDT", status: "active", kind: "trade", legs: [{ accountId: "acc_123103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_123104", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_kinesis_usdt_to_kau", label: "Kinesis spot buy — USDT to KAU", status: "active", kind: "trade", legs: [{ accountId: "acc_122104", side: "debit", pct: 100, wallet: true }, { accountId: "acc_122103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a7_kinesis_kau_to_usdt", label: "Kinesis spot sell — KAU to USDT", status: "active", kind: "trade", legs: [{ accountId: "acc_122103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_122104", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a9_bitgo_usdt_to_crypto", label: "Bitgo spot buy — USDT to crypto", status: "active", kind: "trade", legs: [{ accountId: "acc_112103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a9_bitgo_crypto_to_usdt", label: "Bitgo spot sell — crypto to USDT", status: "active", kind: "trade", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a9_bitgo_usd_to_crypto", label: "Bitgo spot buy — USD to crypto", status: "active", kind: "trade", legs: [{ accountId: "acc_112103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112101", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a9_bitgo_crypto_to_usd", label: "Bitgo spot sell — crypto to USD", status: "active", kind: "trade", legs: [{ accountId: "acc_112101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_a8", label: "Monthly fee collection sweep", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_140101", side: "credit", pct: 100 }] },
  { id: "sl_b1", label: "Allocate to Earn (client lock)", status: "active", legs: [{ accountId: "acc_113103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_b1b", label: "Deploy from Earn to DeFi", status: "active", legs: [{ accountId: "acc_113201", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113103", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_b2a", label: "Daily protocol yield accrual (positive spread)", status: "active", legs: [{ accountId: "acc_140102", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 83.282675 }, { accountId: "acc_410401", side: "credit", pct: 16.717325 }] },
  { id: "sl_b2a_neg", label: "Daily protocol yield accrual (negative spread)", status: "active", legs: [{ accountId: "acc_140102", side: "debit", pct: 79.927007 }, { accountId: "acc_410401", side: "debit", pct: 20.072993 }, { accountId: "acc_210302", side: "credit", pct: 100 }] },
  { id: "sl_b2b", label: "Yield distribution from protocol", status: "active", legs: [{ accountId: "acc_113201", side: "debit", pct: 100, wallet: true }, { accountId: "acc_140102", side: "credit", pct: 100 }] },
  { id: "sl_b2b_y", label: "Yield distribution (Policy Y recovery)", status: "active", legs: [{ accountId: "acc_112101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_140102", side: "credit", pct: 100 }] },
  { id: "sl_b3", label: "Withdraw from Earn to Spendable (Policy Y)", status: "active", legs: [{ accountId: "acc_113103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113201", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113103", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "debit", pct: 0.199005, wallet: true }, { accountId: "acc_112101", side: "credit", pct: 0.199005, wallet: true }] },
  { id: "sl_b4", label: "Extract yield spread revenue", status: "active", legs: [{ accountId: "acc_112101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113201", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_f1", label: "Referral bonus (USDT paid to client)", status: "active", legs: [{ accountId: "acc_520201", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112101", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_g1", label: "P2P order — merchant crypto to escrow", status: "active", legs: [{ accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210401", side: "credit", pct: 100 }] },
  { id: "sl_g2", label: "P2P trade complete — release to customer", status: "active", legs: [{ accountId: "acc_210401", side: "debit", pct: 99.009901 }, { accountId: "acc_210302", side: "credit", pct: 99.009901 }, { accountId: "acc_140101", side: "debit", pct: 0.990099 }, { accountId: "acc_410301", side: "credit", pct: 0.990099 }] },
  { id: "sl_g3", label: "P2P trade cancelled — return to merchant", status: "active", legs: [{ accountId: "acc_210401", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }] },
  { id: "sl_h6_1", label: "Gas fee paid from client hot wallet", status: "active", legs: [{ accountId: "acc_520301", side: "debit", pct: 100 }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_h6_gt", label: "Gas fee paid from gas tank", status: "active", legs: [{ accountId: "acc_520301", side: "debit", pct: 100 }, { accountId: "acc_112106", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_c1_buy_okx", label: "Client buy order (BTC via OKX)", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.497512 }, { accountId: "acc_410102", side: "credit", pct: 0.497512 }] },
  { id: "sl_c1_sell_okx", label: "Client sell order (BTC via OKX)", status: "active", legs: [{ accountId: "acc_112103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.5 }, { accountId: "acc_410102", side: "credit", pct: 0.5 }] },
  { id: "sl_c1_buy_bin", label: "Client buy order (BTC via Binance)", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.497512 }, { accountId: "acc_410102", side: "credit", pct: 0.497512 }] },
  { id: "sl_c1_sell_bin", label: "Client sell order (BTC via Binance)", status: "active", legs: [{ accountId: "acc_112103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.5 }, { accountId: "acc_410102", side: "credit", pct: 0.5 }] },
  { id: "sl_c1_buy_kraken", label: "Client buy order (stock via Kraken)", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.497512 }, { accountId: "acc_410102", side: "credit", pct: 0.497512 }] },
  { id: "sl_c1_sell_kraken", label: "Client sell order (stock via Kraken)", status: "active", legs: [{ accountId: "acc_112103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.5 }, { accountId: "acc_410102", side: "credit", pct: 0.5 }] },
  { id: "sl_c1_buy_kinesis", label: "Client gold buy (immediate delivery)", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112103", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.5 }, { accountId: "acc_410102", side: "credit", pct: 0.5 }] },
  { id: "sl_c1_sell_kinesis", label: "Client gold sell (immediate delivery)", status: "active", legs: [{ accountId: "acc_112103", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_210302", side: "credit", pct: 100 }, { accountId: "acc_140101", side: "debit", pct: 0.502513 }, { accountId: "acc_410102", side: "credit", pct: 0.502513 }] },
  { id: "sl_d1", label: "Client BNPL down payment received", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_d2a", label: "BNPL asset purchased & locked in escrow", status: "active", legs: [{ accountId: "acc_140201", side: "debit", pct: 142.857143 }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210101", side: "credit", pct: 42.857143 }] },
  { id: "sl_d2b", label: "BNPL loan recognition", status: "active", legs: [{ accountId: "acc_140401", side: "debit", pct: 100 }, { accountId: "acc_210102", side: "credit", pct: 100 }] },
  { id: "sl_d3", label: "BNPL daily interest accrual", status: "active", legs: [{ accountId: "acc_140501", side: "debit", pct: 100 }, { accountId: "acc_420101", side: "credit", pct: 100 }] },
  { id: "sl_d4", label: "Client BNPL installment payment", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_113101", side: "credit", pct: 100, wallet: true }, { accountId: "acc_210302", side: "debit", pct: 100 }, { accountId: "acc_140501", side: "credit", pct: 2.912621 }, { accountId: "acc_140401", side: "credit", pct: 97.087379 }] },
  { id: "sl_d5", label: "BNPL final repayment — asset released", status: "active", legs: [{ accountId: "acc_113102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_140201", side: "credit", pct: 100 }, { accountId: "acc_210101", side: "debit", pct: 30 }, { accountId: "acc_210102", side: "debit", pct: 70 }, { accountId: "acc_210302", side: "credit", pct: 100 }] },
  { id: "sl_d6a", label: "Early termination — sell collateral", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_140201", side: "credit", pct: 83.333333 }, { accountId: "acc_210101", side: "credit", pct: 16.666667 }] },
  { id: "sl_d6b", label: "Early termination — settle loan & refund", status: "active", legs: [{ accountId: "acc_210101", side: "debit", pct: 41.666667 }, { accountId: "acc_210102", side: "debit", pct: 58.333333 }, { accountId: "acc_140501", side: "credit", pct: 0.25 }, { accountId: "acc_140401", side: "credit", pct: 50 }, { accountId: "acc_210302", side: "credit", pct: 49.75 }] },
  { id: "sl_d6c", label: "Early termination — deliver residual", status: "active", legs: [{ accountId: "acc_113101", side: "debit", pct: 100, wallet: true }, { accountId: "acc_112102", side: "credit", pct: 100, wallet: true }] },
  { id: "sl_d6_fee", label: "Early termination fee accrual", status: "active", legs: [{ accountId: "acc_140101", side: "debit", pct: 100 }, { accountId: "acc_410501", side: "credit", pct: 100 }] },
  { id: "sl_d7a", label: "Forced liquidation — MTM collateral (loss)", status: "active", legs: [{ accountId: "acc_210101", side: "debit", pct: 100 }, { accountId: "acc_140201", side: "credit", pct: 100 }] },
  { id: "sl_d7b", label: "Forced liquidation — sell collateral", status: "active", legs: [{ accountId: "acc_210201", side: "debit", pct: 100 }, { accountId: "acc_140201", side: "credit", pct: 100 }] },
  { id: "sl_d7c", label: "Forced liquidation — waterfall unwind", status: "active", legs: [{ accountId: "acc_210102", side: "debit", pct: 99.573257 }, { accountId: "acc_510101", side: "debit", pct: 0.426743 }, { accountId: "acc_140401", side: "credit", pct: 99.573257 }, { accountId: "acc_140501", side: "credit", pct: 0.426743 }] },
  { id: "sl_d7d", label: "Forced liquidation — distribute proceeds", status: "active", legs: [{ accountId: "acc_112102", side: "debit", pct: 100, wallet: true }, { accountId: "acc_210201", side: "credit", pct: 100 }] },
];

// Money Buddy's client withdrawal fee schedule: a flat fee, in coin units, per
// token (and network where it differs, e.g. USDT on ERC-20 vs TRC-20). On a
// client withdrawal the fee is carved out of the gross amount and booked to
// fee revenue (410101). Matching is by coin symbol; where a coin has more than
// one network entry the first is used unless the row carries a network.
const DEFAULT_WITHDRAW_FEES = [
  { id: "wf_btc", coin: "BTC", network: "Bitcoin", fee: 0.0012 },
  { id: "wf_eth", coin: "ETH", network: "Ethereum (ERC20)", fee: 0.01 },
  { id: "wf_usdt_erc", coin: "USDT", network: "Ethereum (ERC20)", fee: 10 },
  { id: "wf_usdt_trc", coin: "USDT", network: "Tron (TRC20)", fee: 3 },
  { id: "wf_usdc_erc", coin: "USDC", network: "Ethereum (ERC20)", fee: 10 },
  { id: "wf_usdc_trc", coin: "USDC", network: "Tron (TRC20)", fee: 3 },
  { id: "wf_eurc", coin: "EURC", network: "Ethereum (ERC20)", fee: 10 },
  { id: "wf_paxg", coin: "PAXG", network: "Ethereum (ERC20)", fee: 0.01 },
];
// Flat fee (coin units) for a withdrawal, or 0 if the coin (on that network)
// isn't in the schedule - so revenue is never taken for an unlisted coin. When
// the row carries a network, an exact network match is required (USDT on Tron
// won't borrow the ERC-20 fee). When the row has no network, the fee is used
// only if the coin has a single schedule row (otherwise it's ambiguous -> 0).
function withdrawFeeFor(coinSymbol, withdrawFees, network) {
  const sym = String(coinSymbol || "").toUpperCase();
  const forCoin = (withdrawFees || []).filter((f) => String(f.coin || "").toUpperCase() === sym && Number(f.fee) > 0);
  if (!forCoin.length) return 0;
  if (network) {
    const nk = networkKey(network);
    const byNet = forCoin.find((f) => networkKey(f.network) === nk);
    return byNet ? Number(byNet.fee) || 0 : 0;
  }
  return forCoin.length === 1 ? Number(forCoin[0].fee) || 0 : 0;
}

// Converts a legacy event template (matched on eventType, one or more legs)
// into the multi-leg label model. The label carries the *contra* legs (the
// non-wallet side) as {accountId, side, pct} - the FIFO engine still generates
// the wallet/cost-basis leg, so the template's wallet leg is dropped. Only
// legs based on the transaction amount are kept (a label's pct is a percentage
// of the transaction value); fee/interest legs tied to a separate field, and
// fixed-dollar legs, can't be expressed as a pct of value and are dropped -
// the same information the earlier 2-account conversion already lost, but
// amount-based multi-account splits (e.g. 99.5% / 0.5%) now survive intact.
function isAmountLeg(l) {
  if (l.mode === "fixed") return false;
  const base = l.baseField ?? l.amountField;
  return base === "amount" || base === undefined; // undefined = old implicit "amount"
}
function eventTemplateToLabel(tpl, accounts, walletAccountIds) {
  const pctOf = (l) => (Number.isFinite(l.pct) ? l.pct : 100);
  const resolve = (ref) => (ref && !ref.includes("{") ? (accounts.find((a) => a.name === ref)?.id || "") : "");
  const legs = tpl.legs
    .filter(isAmountLeg)
    .map((l) => ({ accountId: resolve(l.accountRef), side: l.side, pct: pctOf(l) }))
    .filter((l) => l.accountId && !walletAccountIds.has(l.accountId));
  return {
    id: tpl.id,
    label: tpl.label,
    status: tpl.status === "active" ? "active" : "inactive",
    legs,
  };
}
function eventTemplatesToLabels(registry, accounts, walletAccountIds) {
  return registry.map((t) => eventTemplateToLabel(t, accounts, walletAccountIds)).filter((l) => l.legs.length > 0);
}

function seedDataForTenant(seed, tenantName) {
  if (seed === "moneybuddy") {
    const accts = DEFAULT_ACCOUNTS.map((a) => ({ ...a, entityId: a.entityId || "ent_moneybuddy_kh" }));
    return {
      accounts: accts,
      entities: DEFAULT_ENTITIES,
      registry: [],
      rules: DEFAULT_RULES,
      // Labels come from the authoritative settlement sheet (DEFAULT_CRYPTO_LABELS).
      cryptoLabels: DEFAULT_CRYPTO_LABELS,
    };
  }
  return {
    accounts: BLANK_STARTER_ACCOUNTS,
    entities: [blankStarterEntity(tenantName)],
    registry: [],
    rules: [],
    cryptoLabels: [],
  };
}

// Coins - a master reference list of tradable assets, separate from any
// wallet or holding. This is metadata (symbol, chain, category, a market
// rate for defaulting "Per Coin Price"), not a ledger account. Seeded with
// the assets Money Buddy's venues actually deal in.
const DEFAULT_COINS = [
  { id: "coin_btc", symbol: "BTC", name: "Bitcoin", rateSymbol: "BTC", isFiat: false, assetType: "Crypto", chain: "Bitcoin", category: "Layer 1", marketRate: 67000 },
  { id: "coin_eth", symbol: "ETH", name: "Ethereum", rateSymbol: "ETH", isFiat: false, assetType: "Crypto", chain: "Ethereum", category: "Layer 1", marketRate: 3200 },
  { id: "coin_usdt", symbol: "USDT", name: "Tether", rateSymbol: "USDT", isFiat: false, assetType: "Stablecoin", chain: "Multi-chain", category: "Stablecoin", marketRate: 1 },
  { id: "coin_usdc", symbol: "USDC", name: "USD Coin", rateSymbol: "USDC", isFiat: false, assetType: "Stablecoin", chain: "Multi-chain", category: "Stablecoin", marketRate: 1 },
  { id: "coin_bnb", symbol: "BNB", name: "Binance Coin", rateSymbol: "BNB", isFiat: false, assetType: "Crypto", chain: "BNB Chain", category: "Exchange Token", marketRate: 590 },
  { id: "coin_usd", symbol: "USD", name: "US Dollar", rateSymbol: "USD", isFiat: true, assetType: "Fiat", chain: "", category: "Fiat", marketRate: 1 },
  // Added for real custody-platform exports (e.g. Bitgo) that report
  // activity across every chain a wallet touches, not just BTC/ETH/stables.
  { id: "coin_trx", symbol: "TRX", name: "Tron", rateSymbol: "TRX", isFiat: false, assetType: "Crypto", chain: "Tron", category: "Layer 1", marketRate: 0.11 },
  { id: "coin_sol", symbol: "SOL", name: "Solana", rateSymbol: "SOL", isFiat: false, assetType: "Crypto", chain: "Solana", category: "Layer 1", marketRate: 140 },
  { id: "coin_dot", symbol: "DOT", name: "Polkadot", rateSymbol: "DOT", isFiat: false, assetType: "Crypto", chain: "Polkadot", category: "Layer 1", marketRate: 6.8 },
  { id: "coin_near", symbol: "NEAR", name: "NEAR Protocol", rateSymbol: "NEAR", isFiat: false, assetType: "Crypto", chain: "NEAR", category: "Layer 1", marketRate: 5.1 },
  { id: "coin_matic", symbol: "POL", name: "Polygon", rateSymbol: "POL", isFiat: false, assetType: "Crypto", chain: "Polygon", category: "Layer 2", marketRate: 0.7 },
  { id: "coin_inj", symbol: "INJ", name: "Injective", rateSymbol: "INJ", isFiat: false, assetType: "Crypto", chain: "Injective", category: "Layer 1", marketRate: 22 },
  { id: "coin_sui", symbol: "SUI", name: "Sui", rateSymbol: "SUI", isFiat: false, assetType: "Crypto", chain: "Sui", category: "Layer 1", marketRate: 3.8 },
  { id: "coin_bch", symbol: "BCH", name: "Bitcoin Cash", rateSymbol: "BCH", isFiat: false, assetType: "Crypto", chain: "Bitcoin Cash", category: "Layer 1", marketRate: 450 },
  { id: "coin_weth", symbol: "WETH", name: "Wrapped Ether", rateSymbol: "ETH", isFiat: false, assetType: "Crypto", chain: "Multi-chain", category: "Wrapped Asset", marketRate: 3200 },
];

// Wallets are custody locations, distinct from the ledger account they map
// to (same relationship as "bank" is to "cash account" on the fiat side).
// Rather than inventing a parallel account list, every wallet references an
// existing crypto Asset account - the account stays the single source of
// truth for balances, the wallet layer just adds custody metadata on top.
// Seeded automatically from the custody/venue accounts already in the real
// COA (codes 11x/12x/13x), with type/venue/blockchain guessed from the name
// - all editable afterward, this is just a reasonable starting point.
function guessWalletMeta(name) {
  const n = name.toLowerCase();
  let venue = "";
  if (n.includes("bitgo")) venue = "Bitgo";
  else if (n.includes("binance")) venue = "Binance";
  else if (n.includes("kraken")) venue = "Kraken";
  else if (n.includes("okx")) venue = "OKX";
  else if (n.includes("kinesis")) venue = "Kinesis";
  else if (n.includes("defi")) venue = "DeFi Protocol";

  let walletType = "Other";
  if (n.includes("hot wallet")) walletType = "Hot Wallet";
  else if (n.includes("cold wallet")) walletType = "Cold Wallet";
  else if (n.includes("gas wallet")) walletType = "Gas Wallet";
  else if (n.includes("earn")) walletType = "Earn / Staking";
  else if (n.includes("defi pool")) walletType = "DeFi Pool";
  else if (n.includes("margin")) walletType = "Exchange Margin";
  else if (n.includes("futures")) walletType = "Exchange Futures";
  else if (n.includes("spot")) walletType = "Exchange Spot";

  const blockchain = venue === "Bitgo" || n.includes("btc") ? "Bitcoin" : venue ? "Multi-chain" : "";
  return { venue, walletType, blockchain };
}

// Only custody/venue accounts (11x/12x/13x) become wallets - receivables,
// escrow, and other non-custody Asset accounts (14x/15x) don't represent an
// actual on-chain or exchange balance, so they're left out. Futures position
// MTM accounts are excluded too: they only track the changing value of a
// derivative position (unrealized P&L), not a wallet holding a coin balance,
// so they shouldn't carry cost-basis lots.
function isFuturesMtmAccount(a) {
  return /mtm|futures position/i.test(a.name || "");
}
function deriveDefaultWallets(accounts) {
  return accounts
    .filter((a) => a.type === "Asset" && !a.isBank && /^1[123]/.test(a.code) && !isFuturesMtmAccount(a))
    .map((a) => {
      const { venue, walletType, blockchain } = guessWalletMeta(a.name);
      return {
        id: uid("wal"), accountId: a.id, name: a.name, address: "",
        walletType, venue, blockchain, complianceStatus: "Verified",
      };
    });
}

// Bank-feed rules - free-text CSV description -> account. Only the fiat
// operating accounts (ACLEDA/ABA/Phillip) go through this path; venue and
// custody activity is posted via Transaction Types instead.
const DEFAULT_RULES = [
  { id: uid("rule"), pattern: "AWS", accountId: "acc_520101" },
  { id: uid("rule"), pattern: "HOSTING", accountId: "acc_520101" },
  { id: uid("rule"), pattern: "SERC", accountId: "acc_530204" },
  { id: uid("rule"), pattern: "REGULATORY", accountId: "acc_530204" },
  { id: uid("rule"), pattern: "AUDIT", accountId: "acc_540301" },
  { id: uid("rule"), pattern: "PAYROLL", accountId: "acc_540101" },
  { id: uid("rule"), pattern: "RENTAL", accountId: "acc_540201" },
  { id: uid("rule"), pattern: "MARKETING", accountId: "acc_520201" },
  { id: uid("rule"), pattern: "ADS", accountId: "acc_520201" },
  { id: uid("rule"), pattern: "SERVICE CHARGE", accountId: "acc_530203" },
  { id: uid("rule"), pattern: "BANK CHARGE", accountId: "acc_530202" },
  { id: uid("rule"), pattern: "BANK INTEREST", accountId: "acc_420102" },
  { id: uid("rule"), pattern: "CAPITAL INJECTION", accountId: "acc_310101" },
];

const SAMPLE_CSV = `Date,Description,Amount
2026-06-01,AWS Hosting Invoice - June,-180.00
2026-06-03,SERC Regulatory Fee Q2,-450.00
2026-06-05,Office Rental - July,-2200.00
2026-06-07,Payroll - June,-8500.00
2026-06-10,KPMG Audit Fee,-3000.00
2026-06-12,ABA Bank Charge,-15.00
2026-06-14,Facebook Ads - Marketing,-620.00
2026-06-16,Bank Interest Credit,45.20
2026-06-18,Shareholder Capital Injection,50000.00
2026-06-20,Unidentified Wire - Ref 88213,-275.00
2026-06-22,Unidentified Incoming Wire,1200.00`;

// One wallet's worth of activity, same idea as SAMPLE_CSV above. LedgerAccount
// is looked up by code (Deposit/Withdrawal) or ToWallet by name (Transfer) -
// leave either blank and the row still imports, it just lands in Drafts
// needing that one field picked by hand, same as an unmatched bank row.
// Counterparty is optional and is where a raw exchange/wallet export's own
// "To/From/Address" column goes - row 3 shows it doing real work: no
// ToWallet given, but "Bitgo cold wallet - Company #Crypto" matches one of
// this app's own Wallets by name, so it's resolved and filled in
// automatically (see resolveCounterparty). Row 2's counterparty doesn't
// match any wallet - it's a real external client, so it's left for a human
// to pick the Ledger Account, same as before.
const SAMPLE_CRYPTO_CSV = `Date,Type,Coin,Quantity,Price,FeeQuantity,FeePerCoinPrice,ToWallet,LedgerAccount,Counterparty,Reference,TxHash
2026-05-01,Deposit,BTC,1,58000,,,,310101,,In-kind capital contribution,0xabc123
2026-05-10,Deposit,BTC,0.4,61000,,,,210302,client-7f3a,Client custody deposit,0xdef456
2026-05-15,Transfer,BTC,0.5,63000,0.001,63000,,,Bitgo cold wallet - Company #Crypto,Routine hot-to-cold sweep,0xghi789
2026-05-20,Withdrawal,BTC,0.3,65000,0.0005,65000,,140301,,Converted to fiat for payout,0xjkl012
2026-06-01,Withdrawal,BTC,0.1,66000,,,,,,Unmatched wire out,0xmno345`;

// A real custody-platform export (Bitgo's own schema): a full ISO
// timestamp, "Amount" meaning quantity (not a dollar figure - Bitgo never
// tracks USD value), a single same-asset "Fee" quantity, "Transaction ID"
// instead of TxHash, and no Price column at all - the coin's own reference
// market rate fills that gap (see parseCryptoCsvRow). Both addresses here
// are real external parties, not one of this app's own Wallets, so both
// rows still need a Ledger Account picked by hand in Drafts - exactly what
// should happen for money moving to/from someone outside the company's own
// custody. Add one of your own wallet's real addresses in the Wallets
// screen and its rows would resolve automatically instead.
const SAMPLE_BITGO_CSV = `Date,Transaction ID,Type,Asset,Amount,Fee,Address
2026-06-15T10:30:00Z,a1b2c3d4e5f6...,deposit,BTC,0.50000000,0.00001000,3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy
2026-06-16T14:20:00Z,f6e5d4c3b2a1...,withdrawal,BTC,0.10000000,0.00001500,1BoatSLRHtKNngkdXEeobR76b53LETtpyT`;

const money = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- pure accounting logic ----------

function applyRules(description, rules, fallbackExpenseId, amount) {
  const desc = (description || "").toUpperCase();
  for (const r of rules) {
    if (desc.includes(r.pattern.toUpperCase())) {
      return { accountId: r.accountId, matched: true };
    }
  }
  // Outflows fall back to "Other Exp."; inflows have no generic bucket in the
  // real COA on purpose - every credit needs an explicit human decision.
  return { accountId: amount < 0 ? fallbackExpenseId : "", matched: false };
}

// The bank account is always one side; direction of cash flow picks which side.
// Most transactions are one category (a "split" of one), but a transaction
// can carry tx.splits = [{ accountId, amount }, ...] whose amounts sum to the
// full transaction amount - each split gets its own leg, bank stays a single leg.
function journalLinesFor(tx) {
  const amt = Math.abs(tx.amount);
  const splits = tx.splits && tx.splits.length ? tx.splits : [{ accountId: tx.mappedAccountId, amount: amt }];
  const lines = [];
  if (tx.amount < 0) {
    splits.forEach((s) => lines.push({ accountId: s.accountId, debit: s.amount, credit: 0 }));
    lines.push({ accountId: tx.bankAccountId, debit: 0, credit: amt });
  } else {
    lines.push({ accountId: tx.bankAccountId, debit: amt, credit: 0 });
    splits.forEach((s) => lines.push({ accountId: s.accountId, debit: 0, credit: s.amount }));
  }
  return lines;
}

// ---------- crypto transactions (FIFO cost-basis engine) ----------
// Deposit / Withdrawal / Transfer only - Trade requires matching one coin
// sold to another bought, both drawing on cost-basis lots at once, which is
// deliberately out of scope until there's solid reference evidence for how
// it should behave.
const CRYPTO_TX_TYPES = ["Deposit", "Withdrawal", "Transfer", "Fee", "Trade"];
const CRYPTO_TX_TYPES_DISABLED = [];

function coinValue(qty, price) {
  const q = Number(qty), p = Number(price);
  return Number.isFinite(q) && Number.isFinite(p) ? q * p : NaN;
}

// Walks crypto transactions in date order, maintaining a set of "cost
// layers" (lots) per wallet+coin. Deposits create a lot at the price paid;
// Withdrawals consume lots oldest-first and realize gain/loss (proceeds vs.
// cost of exactly what left the wallet - the wallet account is relieved at
// cost, never at the disposal's market price, so no gain/loss gets
// fabricated on the balance sheet side). Transfers also consume FIFO from
// the source wallet but *re-create* the consumed lots in the destination
// wallet at their original cost - moving custody isn't a disposal, so it
// never generates gain/loss on its own.
//
// Fees are assumed to be paid from the same wallet/coin as the main leg
// (flagged simplification). The fee's own consumed cost basis is trued up
// against its stated USD value via the same realized gain/loss accounts,
// since paying a fee in appreciated crypto is itself a small disposal.
//
// Never fabricates cost basis: if a wallet doesn't have enough recorded
// lots to cover a disposal, that transaction is left as an error
// (shortfall) rather than guessed at.
function computeCryptoLedger(txs, wallets, accounts, coins) {
  const gasFeeAccountId = accounts.find((a) => a.code === "520301")?.id;
  const tradingFeeAccountId = accounts.find((a) => a.code === "520302")?.id;
  const realizedGainAccountId = accounts.find((a) => a.code === "440102")?.id;
  const realizedLossAccountId = accounts.find((a) => a.code === "580102")?.id;

  const lots = new Map(); // `${walletId}|${coinId}` -> [{ id, unitCost, remaining, acquiredDate }]
  const linesByTx = new Map();
  const errors = new Map();
  let lotSeq = 0;

  const key = (walletId, coinId) => `${walletId}|${coinId}`;
  const getLots = (walletId, coinId) => {
    const k = key(walletId, coinId);
    if (!lots.has(k)) lots.set(k, []);
    return lots.get(k);
  };
  const addLot = (walletId, coinId, qty, unitCost, date) => {
    if (qty > 1e-9) getLots(walletId, coinId).push({ id: `lot_${++lotSeq}`, unitCost, remaining: qty, acquiredDate: date });
  };
  // Checks availability before mutating anything, so a failed (shortfall)
  // attempt never partially drains a wallet's recorded lots.
  const consumeFifo = (walletId, coinId, qty) => {
    if (qty <= 1e-9) return { consumed: [], costBasis: 0 };
    const arr = getLots(walletId, coinId).filter((l) => l.remaining > 1e-9);
    const available = arr.reduce((s, l) => s + l.remaining, 0);
    if (qty - available > 1e-6) return null;
    let need = qty, costBasis = 0;
    const consumed = [];
    for (const lot of arr) {
      if (need <= 1e-9) break;
      const take = Math.min(lot.remaining, need);
      lot.remaining -= take;
      costBasis += take * lot.unitCost;
      consumed.push({ lotId: lot.id, quantity: take, unitCost: lot.unitCost });
      need -= take;
    }
    return { consumed, costBasis };
  };
  // The realized gain/loss leg is the plug that makes a disposal entry
  // balance (proceeds debited vs. cost credited). It must be included whenever
  // it's nonzero - dropping even sub-cent amounts leaves each entry unbalanced
  // by that residual, and across hundreds of transactions those accumulate
  // into a visible trial-balance imbalance. Only a true zero (within float
  // dust) is omitted, since then the entry already balances on its own.
  const gainLossLegs = (diff) => {
    if (Math.abs(diff) < 1e-9) return [];
    return diff > 0
      ? [{ side: "credit", accountId: realizedGainAccountId, amount: diff, label: "Realized gain" }]
      : [{ side: "debit", accountId: realizedLossAccountId, amount: -diff, label: "Realized loss" }];
  };
  // Deposit/Withdrawal's contra side can be one account (ledgerAccountId) or,
  // from the Needs Review split editor, several (ledgerSplits). Resolves to
  // a list of {accountId, amount} that must sum to `value`, or null if
  // unresolved/unbalanced.
  const resolveLedgerSplits = (t, value) => {
    const splits = t.ledgerSplits && t.ledgerSplits.length
      ? t.ledgerSplits
      : (t.ledgerAccountId ? [{ accountId: t.ledgerAccountId, amount: value }] : null);
    if (!splits || !splits.every((s) => s.accountId && Number.isFinite(s.amount) && s.amount > 0)) return null;
    const total = splits.reduce((s, x) => s + x.amount, 0);
    if (Math.abs(total - value) > 0.005) return null;
    return splits;
  };
  // Generalized contra resolver. `direction` is the side the contra must net
  // to ("credit" for a deposit, "debit" for a withdrawal). A multi-leg label
  // supplies `ledgerLegs` ([{accountId, side, amount}]) that can sit on both
  // sides (e.g. a fee's debit-expense / credit-payable pair) as long as they
  // net to `value` on `direction`; the wallet + gain/loss legs the engine adds
  // then balance the entry. Falls back to the single-side ledgerAccountId /
  // ledgerSplits path (all legs on `direction`) for everything else.
  const resolveContra = (t, value, direction) => {
    let legs;
    if (t.ledgerLegs && t.ledgerLegs.length) {
      legs = t.ledgerLegs;
    } else {
      const splits = resolveLedgerSplits(t, value);
      if (!splits) return null;
      legs = splits.map((s) => ({ accountId: s.accountId, side: direction, amount: s.amount }));
    }
    if (!legs.every((l) => l.accountId && (l.side === "debit" || l.side === "credit") && Number.isFinite(l.amount) && l.amount > 0)) return null;
    const net = legs.reduce((s, l) => s + (l.side === direction ? l.amount : -l.amount), 0);
    if (Math.abs(net - value) > 0.005) return null;
    return legs;
  };

  // FIFO order is by date, but transactions only carry a date (no time), so
  // same-date rows are ordered by economic sequence: inflows (Deposits) first,
  // then Transfers (which both receive and send), then outflows (Withdrawals) -
  // otherwise a withdrawal that happens to sort earlier by id would be
  // processed before the very deposits that fund it and wrongly report "not
  // enough cost basis." Ties beyond that fall back to id for stability.
  const typeRank = (t) => (t.type === "Deposit" ? 0 : t.type === "Transfer" ? 1 : t.type === "Trade" ? 2 : t.type === "Withdrawal" ? 3 : 4);
  const sorted = txs.slice().sort((a, b) =>
    a.date.localeCompare(b.date) || typeRank(a) - typeRank(b) || String(a.id).localeCompare(String(b.id)));

  // USD value is always quantity x price. Crypto amounts are often tiny, so it's
  // carried to 8 decimals rather than cents - a sub-cent transfer (e.g. 0.000001
  // of a coin) still has a real, nonzero value and must post, not round to $0.
  const round8 = (x) => (Number.isFinite(x) ? Math.round(x * 1e8) / 1e8 : x);
  for (const t of sorted) {
    const wallet = wallets.find((w) => w.id === t.walletId);
    const toWallet = wallets.find((w) => w.id === t.toWalletId);
    const value = round8(coinValue(t.quantity, t.perCoinPrice));
    const feeValue = round8(coinValue(t.feeQuantity, t.feePerCoinPrice));
    const hasFee = Number.isFinite(feeValue) && feeValue > 0;

    // A full-entry label (e.g. gas fee + company top-up) posts its complete,
    // self-balancing journal verbatim - no FIFO, no gain/loss. The legs were
    // resolved to this transaction's value when the label was applied.
    if (t.fullEntryLegs && t.fullEntryLegs.length) {
      const dr = t.fullEntryLegs.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
      const cr = t.fullEntryLegs.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
      if (t.fullEntryLegs.every((l) => l.accountId && (l.side === "debit" || l.side === "credit") && l.amount > 0) && Math.abs(dr - cr) < 5e-9) {
        linesByTx.set(t.id, t.fullEntryLegs);
      } else {
        errors.set(t.id, "This gas-fee (full-entry) label's legs don't balance.");
      }
      continue;
    }
    // Dust: a real price is known but the quantity is so tiny the value rounds
    // to $0 even at 8 decimals - nothing meaningful to post. Flag it clearly so
    // it can be deleted, rather than failing with a misleading "missing price".
    if (t.type !== "Transfer" && Number(t.quantity) > 0 && Number(t.perCoinPrice) > 0 && value === 0) {
      const sym = coins.find((c) => c.id === t.coinId)?.symbol || "units";
      errors.set(t.id, `Negligible dust: ${t.quantity} ${sym} is worth under $0.00000001, so there's nothing to post. Delete this row.`);
      continue;
    }

    if (t.type === "Deposit") {
      if (!wallet || !Number.isFinite(value) || value <= 0) {
        errors.set(t.id, "Missing wallet or quantity/price.");
        continue;
      }
      const contra = resolveContra(t, value, "credit");
      if (!contra) { errors.set(t.id, "Missing ledger account, or contra legs don't net to the deposit value."); continue; }
      const netQty = t.quantity - (hasFee ? t.feeQuantity : 0);
      if (netQty <= 0) { errors.set(t.id, "Fee quantity can't exceed the deposited quantity."); continue; }
      addLot(t.walletId, t.coinId, netQty, t.perCoinPrice, t.date);
      const legs = [{ side: "debit", accountId: wallet.accountId, amount: value, label: "Wallet (received)" }];
      contra.forEach((c) => legs.push({ side: c.side, accountId: c.accountId, amount: c.amount, label: "Ledger account" }));
      if (hasFee) {
        legs.push({ side: "debit", accountId: gasFeeAccountId, amount: feeValue, label: "Fee expense" });
        legs.push({ side: "credit", accountId: wallet.accountId, amount: feeValue, label: "Fee (from wallet)" });
      }
      linesByTx.set(t.id, legs);
    }

    else if (t.type === "Withdrawal") {
      if (!wallet || !Number.isFinite(value) || value <= 0) {
        errors.set(t.id, "Missing wallet or quantity/price.");
        continue;
      }
      const contra = resolveContra(t, value, "debit");
      if (!contra) { errors.set(t.id, "Missing ledger account, or contra legs don't net to the withdrawal value."); continue; }
      // Client withdrawal fee carve-out (receivable model). Recorded quantity is
      // the GROSS debited from the client (net sent on-chain + the flat fee). The
      // fee isn't taken from the crypto and isn't reduced from custody now - it's
      // recognized as revenue against Client fee receivable, and the monthly
      // sweep later collects it (Dr custody payable / Cr fee receivable). So at
      // withdrawal only the NET leaves the wallet and custody payable falls by
      // the NET value; the fee posts Dr fee receivable / Cr fee revenue.
      if (Number(t.withdrawFeeUnits) > 0 && t.withdrawFeeAccountId && t.withdrawFeeReceivableAccountId) {
        const feeUnits = Number(t.withdrawFeeUnits);
        const netQty = round8(t.quantity - feeUnits);
        if (!(netQty > 0)) { errors.set(t.id, `Withdrawal fee (${feeUnits}) can't be greater than or equal to the withdrawal amount (${t.quantity}).`); continue; }
        const custodyAcct = contra.find((c) => c.side === "debit")?.accountId;
        if (!custodyAcct) { errors.set(t.id, "Client withdrawal label needs a debit (client custody payable) leg."); continue; }
        const feeResult = consumeFifo(t.walletId, t.coinId, netQty);
        if (!feeResult) {
          const avail = getLots(t.walletId, t.coinId).reduce((s, l) => s + l.remaining, 0);
          const sym = coins.find((c) => c.id === t.coinId)?.symbol || "units";
          errors.set(t.id, `Not enough recorded cost basis: need ${netQty} ${sym} (net of fee), but only ${Math.round(avail * 1e8) / 1e8} ${sym} is available in ${wallet.name} on or before ${t.date}.`);
          continue;
        }
        const netValue = round8(coinValue(netQty, t.perCoinPrice));
        const feeVal = round8(coinValue(feeUnits, t.perCoinPrice));
        const legs = [
          { side: "debit", accountId: custodyAcct, amount: netValue, label: "Client custody payable (net)" },
          { side: "credit", accountId: wallet.accountId, amount: feeResult.costBasis, label: "Wallet (net, at cost)" },
          ...gainLossLegs(netValue - feeResult.costBasis),
          { side: "debit", accountId: t.withdrawFeeReceivableAccountId, amount: feeVal, label: "Client fee receivable" },
          { side: "credit", accountId: t.withdrawFeeAccountId, amount: feeVal, label: "Withdrawal fee revenue" },
        ];
        linesByTx.set(t.id, legs);
        continue;
      }
      const totalOut = t.quantity + (hasFee ? t.feeQuantity : 0);
      const result = consumeFifo(t.walletId, t.coinId, totalOut);
      if (!result) {
        // Report the actual shortfall - lots only build up from deposits/
        // transfers-in dated on or before this row, so common causes are a
        // withdrawal dated earlier than the deposit that funds it, a wrong
        // wallet, or funding deposits still sitting unresolved in Needs review.
        const avail = getLots(t.walletId, t.coinId).reduce((s, l) => s + l.remaining, 0);
        const sym = coins.find((c) => c.id === t.coinId)?.symbol || "units";
        errors.set(t.id, `Not enough recorded cost basis: need ${totalOut} ${sym}, but only ${Math.round(avail * 1e8) / 1e8} ${sym} is available in ${wallet.name} on or before ${t.date}. Cost basis is per-wallet - check the withdrawal is on the wallet that holds the ${sym} (or record the transfer that moved it), and that its funding deposits are posted.`);
        continue;
      }
      const feeShare = hasFee ? t.feeQuantity / totalOut : 0;
      const feeCostBasis = result.costBasis * feeShare;
      const withdrawalCostBasis = result.costBasis - feeCostBasis;
      const legs = [];
      contra.forEach((c) => legs.push({ side: c.side, accountId: c.accountId, amount: c.amount, label: "Ledger account (proceeds)" }));
      legs.push({ side: "credit", accountId: wallet.accountId, amount: withdrawalCostBasis, label: "Wallet (at cost)" });
      legs.push(...gainLossLegs(value - withdrawalCostBasis));
      if (hasFee) {
        legs.push({ side: "debit", accountId: gasFeeAccountId, amount: feeValue, label: "Fee expense" });
        legs.push({ side: "credit", accountId: wallet.accountId, amount: feeCostBasis, label: "Fee (at cost)" });
        legs.push(...gainLossLegs(feeValue - feeCostBasis).map((l) => ({ ...l, label: l.label + " (fee)" })));
      }
      linesByTx.set(t.id, legs);
    }

    else if (t.type === "Transfer") {
      if (!wallet || !toWallet || !Number.isFinite(value) || value <= 0) {
        errors.set(t.id, "Missing from/to wallet or quantity/price.");
        continue;
      }
      const totalOut = t.quantity + (hasFee ? t.feeQuantity : 0);
      const result = consumeFifo(t.walletId, t.coinId, totalOut);
      if (!result) {
        // Report the actual shortfall - lots only build up from deposits/
        // transfers-in dated on or before this row, so common causes are a
        // withdrawal dated earlier than the deposit that funds it, a wrong
        // wallet, or funding deposits still sitting unresolved in Needs review.
        const avail = getLots(t.walletId, t.coinId).reduce((s, l) => s + l.remaining, 0);
        const sym = coins.find((c) => c.id === t.coinId)?.symbol || "units";
        errors.set(t.id, `Not enough recorded cost basis: need ${totalOut} ${sym}, but only ${Math.round(avail * 1e8) / 1e8} ${sym} is available in ${wallet.name} on or before ${t.date}. Cost basis is per-wallet - check the withdrawal is on the wallet that holds the ${sym} (or record the transfer that moved it), and that its funding deposits are posted.`);
        continue;
      }
      const feeShare = hasFee ? t.feeQuantity / totalOut : 0;
      const feeCostBasis = result.costBasis * feeShare;
      const moveCostBasis = result.costBasis - feeCostBasis;
      const keepFrac = t.quantity / totalOut;
      result.consumed.forEach((c) => addLot(t.toWalletId, t.coinId, c.quantity * keepFrac, c.unitCost, t.date));
      const legs = [
        { side: "debit", accountId: toWallet.accountId, amount: moveCostBasis, label: "To wallet (at cost)" },
        { side: "credit", accountId: wallet.accountId, amount: moveCostBasis, label: "From wallet (at cost)" },
      ];
      if (hasFee) {
        legs.push({ side: "debit", accountId: gasFeeAccountId, amount: feeValue, label: "Fee expense" });
        legs.push({ side: "credit", accountId: wallet.accountId, amount: feeCostBasis, label: "Fee (at cost)" });
        legs.push(...gainLossLegs(feeValue - feeCostBasis).map((l) => ({ ...l, label: l.label + " (fee)" })));
      }
      linesByTx.set(t.id, legs);
    }

    else if (t.type === "Fee") {
      // A fee disposes crypto out of a wallet to an expense/fee account. Like a
      // withdrawal, its contra (which expense - gas, exchange fee, ...) comes
      // from a label mapping or a picked account, so the existing "Gas fee
      // paid from ..." labels handle it. Dr the fee account, Cr the wallet at
      // FIFO cost, with the difference a realized gain/loss on disposal.
      if (!wallet || !Number.isFinite(value) || value <= 0) {
        errors.set(t.id, "Missing wallet or quantity/price.");
        continue;
      }
      const contra = resolveContra(t, value, "debit");
      if (!contra) { errors.set(t.id, "Missing fee account - apply a Gas fee label (or pick an expense account) for this fee."); continue; }
      const result = consumeFifo(t.walletId, t.coinId, t.quantity);
      if (!result) {
        const avail = getLots(t.walletId, t.coinId).reduce((s, l) => s + l.remaining, 0);
        const sym = coins.find((c) => c.id === t.coinId)?.symbol || "units";
        errors.set(t.id, `Not enough recorded cost basis for this fee: need ${t.quantity} ${sym}, but only ${Math.round(avail * 1e8) / 1e8} ${sym} is available in ${wallet.name} on or before ${t.date}.`);
        continue;
      }
      const legs = [];
      contra.forEach((c) => legs.push({ side: c.side, accountId: c.accountId, amount: c.amount, label: "Fee account" }));
      legs.push({ side: "credit", accountId: wallet.accountId, amount: result.costBasis, label: "Wallet (at cost)" });
      legs.push(...gainLossLegs(value - result.costBasis));
      linesByTx.set(t.id, legs);
    }

    else if (t.type === "Trade") {
      // A spot trade swaps one coin for another within a venue: it disposes the
      // "sold" coin (FIFO cost basis + realized gain/loss) and acquires the
      // "bought" coin as a new lot at cost. The bought/sold sides are stored as
      // acquired (coinId/quantity/perCoinPrice/walletId) and disposed
      // (disposedCoinId/disposedQuantity/disposedPrice/disposedWalletId). The
      // spread between what's given up and what's received is the Trading fee.
      // A fiat leg (USD) is cash - no cost-basis lot on that side.
      const disWallet = wallets.find((w) => w.id === t.disposedWalletId);
      const acqCoin = coins.find((c) => c.id === t.coinId);
      const disCoin = coins.find((c) => c.id === t.disposedCoinId);
      const acqValue = round8(coinValue(t.quantity, t.perCoinPrice));
      const disValue = round8(coinValue(t.disposedQuantity, t.disposedPrice));
      if (!wallet || !disWallet || !acqCoin || !disCoin || !(acqValue > 0) || !(disValue > 0)) {
        errors.set(t.id, "Trade needs both wallets, both coins, and nonzero quantities/prices.");
        continue;
      }
      const feeAcct = t.feeAccountId || tradingFeeAccountId;
      const legs = [];
      // dispose the sold coin
      if (disCoin.isFiat) {
        legs.push({ side: "credit", accountId: disWallet.accountId, amount: disValue, label: "Sold (cash)" });
      } else {
        const sold = consumeFifo(t.disposedWalletId, t.disposedCoinId, t.disposedQuantity);
        if (!sold) {
          const avail = getLots(t.disposedWalletId, t.disposedCoinId).reduce((s, l) => s + l.remaining, 0);
          errors.set(t.id, `Not enough recorded cost basis to trade away ${t.disposedQuantity} ${disCoin.symbol}: only ${round8(avail)} ${disCoin.symbol} available in ${disWallet.name} on or before ${t.date}.`);
          continue;
        }
        legs.push({ side: "credit", accountId: disWallet.accountId, amount: sold.costBasis, label: "Sold (at cost)" });
        legs.push(...gainLossLegs(disValue - sold.costBasis));
      }
      // acquire the bought coin at cost = its value (a new lot, unless it's cash)
      if (!acqCoin.isFiat) addLot(t.walletId, t.coinId, t.quantity, t.perCoinPrice, t.date);
      legs.push({ side: "debit", accountId: wallet.accountId, amount: acqValue, label: acqCoin.isFiat ? "Bought (cash)" : "Bought (at cost)" });
      // the spread given-up minus received is the trading fee
      const fee = round8(disValue - acqValue);
      if (Math.abs(fee) >= 5e-9) {
        legs.push(fee > 0
          ? { side: "debit", accountId: feeAcct, amount: fee, label: "Trading fee" }
          : { side: "credit", accountId: feeAcct, amount: -fee, label: "Trading fee rebate" });
      }
      linesByTx.set(t.id, legs);
    }
  }

  const remainingLayers = [];
  for (const [k, arr] of lots.entries()) {
    const [walletId, coinId] = k.split("|");
    arr.forEach((l) => {
      if (l.remaining > 1e-9) remainingLayers.push({ ...l, walletId, coinId });
    });
  }
  remainingLayers.sort((a, b) => a.acquiredDate.localeCompare(b.acquiredDate));

  return { linesByTx, errors, remainingLayers };
}

// Asset Roll Forward - per-coin movement of holdings across a period, the way
// Cryptio's roll-forward report works. Only *posted* transactions count (it's
// a view of the actual books). Beginning and ending positions come straight
// from the same FIFO engine the ledger uses - run it on everything before the
// period start for the opening position, and on everything through the period
// end for the closing position, then read each run's remaining cost-basis
// lots. Deposits/withdrawals/fees within the period are summed directly for
// the movement columns. Transfers move units between wallets within the same
// coin, so at the coin level their principal nets to zero (only their fee
// burns units) - which is why the units reconciliation below holds:
//   beginning + deposits - withdrawals - fees = ending
// USD columns intentionally do NOT tie (cost basis vs. transaction-date price
// is exactly the realized/unrealized P&L), so only units are reconciled.
function computeAssetRollForward(txs, wallets, accounts, coins, start, end) {
  const posted = txs.filter((t) => t.posted);
  const before = posted.filter((t) => t.date < start);
  const upToEnd = posted.filter((t) => t.date <= end);
  const inPeriod = posted.filter((t) => t.date >= start && t.date <= end);

  const aggLots = (layers) => {
    const m = new Map();
    layers.forEach((l) => {
      const cur = m.get(l.coinId) || { units: 0, cost: 0 };
      cur.units += l.remaining;
      cur.cost += l.remaining * l.unitCost;
      m.set(l.coinId, cur);
    });
    return m;
  };
  const beginMap = aggLots(computeCryptoLedger(before, wallets, accounts, coins).remainingLayers);
  const endMap = aggLots(computeCryptoLedger(upToEnd, wallets, accounts, coins).remainingLayers);

  const flow = new Map();
  const bump = (coinId, patch) => {
    const cur = flow.get(coinId) || { depUnits: 0, depUsd: 0, wdUnits: 0, wdUsd: 0, feeUnits: 0, feeUsd: 0 };
    for (const k in patch) cur[k] += patch[k];
    flow.set(coinId, cur);
  };
  inPeriod.forEach((t) => {
    const val = coinValue(t.quantity, t.perCoinPrice) || 0;
    const feeVal = coinValue(t.feeQuantity, t.feePerCoinPrice);
    const hasFee = Number.isFinite(feeVal) && feeVal > 0;
    if (t.type === "Deposit") bump(t.coinId, { depUnits: t.quantity, depUsd: val });
    else if (t.type === "Withdrawal") bump(t.coinId, { wdUnits: t.quantity, wdUsd: val });
    else if (t.type === "Fee") bump(t.coinId, { feeUnits: t.quantity, feeUsd: val });
    else if (t.type === "Trade") {
      // A trade brings in the acquired coin and sends out the disposed coin.
      bump(t.coinId, { depUnits: t.quantity, depUsd: val });
      bump(t.disposedCoinId, { wdUnits: t.disposedQuantity, wdUsd: coinValue(t.disposedQuantity, t.disposedPrice) || 0 });
    }
    // Transfer principal nets to zero at coin level; only its fee is counted.
    if (hasFee) bump(t.coinId, { feeUnits: t.feeQuantity, feeUsd: feeVal });
  });

  const coinIds = new Set([...beginMap.keys(), ...endMap.keys(), ...flow.keys()]);
  const rows = [];
  coinIds.forEach((coinId) => {
    const b = beginMap.get(coinId) || { units: 0, cost: 0 };
    const e = endMap.get(coinId) || { units: 0, cost: 0 };
    const f = flow.get(coinId) || { depUnits: 0, depUsd: 0, wdUnits: 0, wdUsd: 0, feeUnits: 0, feeUsd: 0 };
    const expectedEndUnits = b.units + f.depUnits - f.wdUnits - f.feeUnits;
    const tie = Math.abs(expectedEndUnits - e.units) < 1e-6;
    const coin = coins.find((c) => c.id === coinId);
    rows.push({
      coinId, symbol: coin?.symbol || "?",
      beginUnits: b.units, beginUsd: b.cost,
      depUnits: f.depUnits, depUsd: f.depUsd,
      wdUnits: f.wdUnits, wdUsd: f.wdUsd,
      feeUnits: f.feeUnits, feeUsd: f.feeUsd,
      endUnits: e.units, endUsd: e.cost,
      tie,
    });
  });
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
}

// The two income/expense accounts a revaluation writes its unrealized P&L to.
// Money Buddy's COA ships 440101 (Unrealised gain) / 580101 (Unrealised
// loss); for any other COA, fall back to an Income/Expense account whose name
// says "unrealised/unrealized". Returns undefined ids if neither is found -
// the Revaluation screen then disables booking and explains why.
function resolveUnrealizedAccounts(accounts) {
  const gain = accounts.find((a) => a.code === "440101")
    || accounts.find((a) => a.type === "Income" && /unreali[sz]/i.test(a.name));
  const loss = accounts.find((a) => a.code === "580101")
    || accounts.find((a) => a.type === "Expense" && /unreali[sz]/i.test(a.name));
  return { gainAccountId: gain?.id, lossAccountId: loss?.id };
}

// Period-end revaluation (mark-to-market). Values each wallet+coin holding as
// of a date at cost basis (FIFO remaining lots) vs. a mark price, and books
// the *incremental* unrealized adjustment needed to move the carrying value
// to market: adjustment = (market - cost) - alreadyBookedUnrealized. Because
// the target is recomputed as market-minus-cost every time, this composes
// correctly across multiple revaluations and across disposals - when units
// are sold (FIFO relieves them at cost) or fully gone, the next revaluation
// reverses whatever unrealized was previously sitting on them, so nothing is
// double-counted over an asset's full lifecycle (realized gain is booked once
// by the FIFO engine at disposal; unrealized is booked then unwound).
// `markPrices` is a per-coin override map; anything absent falls back to the
// coin's own reference market rate. Only prior revaluations dated strictly
// before `asOfDate` count as "already booked" (bookings are kept sequential).
function computeRevaluation(cryptoTxs, wallets, accounts, coins, revaluations, asOfDate, markPrices = {}) {
  const upToDate = cryptoTxs.filter((t) => t.posted && t.date <= asOfDate);
  const layers = computeCryptoLedger(upToDate, wallets, accounts, coins).remainingLayers;

  const holdings = new Map(); // walletId|coinId -> { units, cost }
  layers.forEach((l) => {
    const k = `${l.walletId}|${l.coinId}`;
    const cur = holdings.get(k) || { units: 0, cost: 0 };
    cur.units += l.remaining;
    cur.cost += l.remaining * l.unitCost;
    holdings.set(k, cur);
  });

  const priorBooked = new Map(); // walletId|coinId -> cumulative adjustment
  revaluations.filter((r) => r.date < asOfDate).forEach((r) =>
    r.lines.forEach((ln) => {
      const k = `${ln.walletId}|${ln.coinId}`;
      priorBooked.set(k, (priorBooked.get(k) || 0) + ln.adjustment);
    })
  );

  const keys = new Set([...holdings.keys(), ...priorBooked.keys()]);
  const lines = [];
  keys.forEach((k) => {
    const [walletId, coinId] = k.split("|");
    const h = holdings.get(k) || { units: 0, cost: 0 };
    const coin = coins.find((c) => c.id === coinId);
    const markPrice = markPrices[coinId] !== undefined && markPrices[coinId] !== ""
      ? Number(markPrices[coinId])
      : (coin?.marketRate ?? 0);
    const marketValue = h.units * markPrice;
    const targetUnrealized = marketValue - h.cost;
    const prior = priorBooked.get(k) || 0;
    const adjustment = targetUnrealized - prior;
    lines.push({
      walletId, coinId,
      symbol: coin?.symbol || "?",
      units: h.units, costBasis: h.cost, markPrice, marketValue,
      priorUnrealized: prior, targetUnrealized, adjustment,
    });
  });
  lines.sort((a, b) => a.symbol.localeCompare(b.symbol) || String(a.walletId).localeCompare(String(b.walletId)));
  return lines;
}

// Journal lines for one booked revaluation record - a write-up debits the
// wallet asset account and credits Unrealised gain; a write-down credits the
// wallet and debits Unrealised loss. Balanced per line by construction.
function revaluationJournalLines(reval, wallets, accounts) {
  const { gainAccountId, lossAccountId } = resolveUnrealizedAccounts(accounts);
  const lines = [];
  reval.lines.forEach((ln, i) => {
    if (Math.abs(ln.adjustment) < 0.005) return;
    const walletAccountId = wallets.find((w) => w.id === ln.walletId)?.accountId;
    const pnlAccountId = ln.adjustment > 0 ? gainAccountId : lossAccountId;
    if (!walletAccountId || !pnlAccountId) return; // COA missing the target - skip rather than post a one-sided entry
    const amt = Math.abs(ln.adjustment);
    const desc = `Revaluation ${ln.symbol} - unrealized ${ln.adjustment > 0 ? "gain" : "loss"}`;
    if (ln.adjustment > 0) {
      lines.push({ id: `${reval.id}_${i}_a`, entryId: reval.id, date: reval.date, description: desc, accountId: walletAccountId, debit: amt, credit: 0 });
      lines.push({ id: `${reval.id}_${i}_b`, entryId: reval.id, date: reval.date, description: desc, accountId: pnlAccountId, debit: 0, credit: amt });
    } else {
      lines.push({ id: `${reval.id}_${i}_a`, entryId: reval.id, date: reval.date, description: desc, accountId: pnlAccountId, debit: amt, credit: 0 });
      lines.push({ id: `${reval.id}_${i}_b`, entryId: reval.id, date: reval.date, description: desc, accountId: walletAccountId, debit: 0, credit: amt });
    }
  });
  return lines;
}

// Same idea as SAMPLE_CSV on the bank side - a realistic, internally
// consistent batch that "Build Journals" can post end to end: two coins,
// all three transaction types, some with fees and some without. Looks up
// wallets/coins/accounts by name/symbol/code so it still works if the
// underlying ids change, and simply produces fewer rows if the exact
// wallet/coin/account it wants isn't present (never guesses a substitute).
function makeSampleCryptoTxs(wallets, coins, accounts) {
  const wallet = (name) => wallets.find((w) => w.name === name);
  const coin = (symbol) => coins.find((c) => c.symbol === symbol);
  const account = (code) => accounts.find((a) => a.code === code);

  const hot = wallet("Bitgo hot wallet - Company #Crypto");
  const cold = wallet("Bitgo cold wallet - Company #Crypto");
  const binance = wallet("Binance spot - Company #Crypto");
  const btc = coin("BTC");
  const eth = coin("ETH");
  const shareCapital = account("310101");
  const custodyPayable = account("210302");
  const cashClearing = account("140301");

  const candidates = [
    hot && btc && shareCapital && {
      type: "Deposit", date: "2026-05-01", coinId: btc.id, walletId: hot.id,
      quantity: 1, perCoinPrice: 58000, ledgerAccountId: shareCapital.id,
      reference: "In-kind capital contribution", notes: "Founder BTC contribution",
    },
    binance && eth && shareCapital && {
      type: "Deposit", date: "2026-05-05", coinId: eth.id, walletId: binance.id,
      quantity: 10, perCoinPrice: 2900, ledgerAccountId: shareCapital.id,
      reference: "In-kind capital contribution",
    },
    hot && btc && custodyPayable && {
      type: "Deposit", date: "2026-05-10", coinId: btc.id, walletId: hot.id,
      quantity: 0.4, perCoinPrice: 61000, ledgerAccountId: custodyPayable.id,
      reference: "Client custody deposit",
    },
    hot && cold && btc && {
      type: "Transfer", date: "2026-05-15", coinId: btc.id, walletId: hot.id, toWalletId: cold.id,
      quantity: 0.5, perCoinPrice: 63000, feeQuantity: 0.001, feePerCoinPrice: 63000,
      reference: "Routine hot-to-cold sweep",
    },
    hot && btc && cashClearing && {
      type: "Withdrawal", date: "2026-05-20", coinId: btc.id, walletId: hot.id,
      quantity: 0.3, perCoinPrice: 65000, ledgerAccountId: cashClearing.id,
      feeQuantity: 0.0005, feePerCoinPrice: 65000,
      reference: "Converted to fiat for payout",
    },
    binance && eth && cashClearing && {
      type: "Withdrawal", date: "2026-05-25", coinId: eth.id, walletId: binance.id,
      quantity: 4, perCoinPrice: 3100, ledgerAccountId: cashClearing.id,
      feeQuantity: 0.02, feePerCoinPrice: 3100,
      reference: "Converted to fiat for payout",
    },
  ];
  return candidates.filter(Boolean);
}

function cryptoLegsCheck(legs) {
  const debit = legs.reduce((s, l) => s + (l.side === "debit" ? l.amount : 0), 0);
  const credit = legs.reduce((s, l) => s + (l.side === "credit" ? l.amount : 0), 0);
  return { debit, credit, balanced: legs.length > 0 && Math.abs(debit - credit) < 0.005 };
}

// ---------- crypto CSV import ----------
// Same job as the bank-feed importer: turn one wallet's transaction export
// into drafts. Unlike a bank CSV, every row already says what it *is*
// (Deposit/Withdrawal/Transfer with a coin, quantity, and price) - what's
// often still missing is the contra side, exactly like a bank row that
// hasn't been categorized yet. A row missing its Ledger Account (or, for a
// Transfer, its destination wallet) still imports as a draft; it just shows
// up needing that one field, fixable inline in the Drafts list rather than
// forcing a re-import.
// A raw export (Bitgo, Binance, OKX, Kraken, ...) never uses this app's own
// vocabulary, and it often gives a counterparty (an address, or another
// account label) instead of - or alongside - an explicit ToWallet/
// LedgerAccount. Two things make that usable automatically:
//  - normalizeNativeType/RAW_TYPE_ALIASES translate whatever that source
//    calls a deposit/withdrawal/transfer into this app's exact vocabulary,
//    so "Receive"/"Send"/"Sweep" etc. import the same as "Deposit"/
//    "Withdrawal"/"Transfer" would.
//  - resolveCounterparty checks that address/label against this app's own
//    Wallets (by address, name, or a loose contains-match - a source often
//    labels its own sub-accounts rather than giving a raw address). A match
//    means "this is really an internal transfer" and auto-fills ToWallet
//    when the CSV didn't already give one explicitly. No match means a real
//    external party (a client, a vendor, an unknown address) - resolved to
//    "external:<label>" and never guessed at further; it still needs a
//    human to pick the Ledger Account once, same as any unmatched row.
// Some custody exports (Bitgo's own account-level CSV included) tag the
// asset with its chain, "chain:token" - e.g. "polygon:usdt" is USDT riding
// on Polygon, "trx:usdt" is USDT riding on Tron. Only the token half matters
// for which Coin this resolves to; a bare code with no colon ("trx", "btc")
// is that chain's own native asset. A few chains' native assets are coded by
// Bitgo as the full chain name rather than the market ticker - "polygon" for
// MATIC, "injective" for INJ - translated here to the ticker this app's
// Coins list actually uses. NFT transfer codes ("erc1155:...", "erc721:...")
// intentionally fall through unresolved - this app has no NFT accounting, so
// those rows skip like any other unrecognized asset rather than being
// guessed at.
// POL is the 1:1 successor to MATIC (Polygon's native token, renamed 2024-09-04),
// so both the old ticker and the chain name canonicalize to POL - one continuous
// asset with unbroken cost basis across the rename.
const CHAIN_NAME_TO_TICKER = { POLYGON: "POL", MATIC: "POL", INJECTIVE: "INJ" };
function resolveCryptoAssetSymbol(raw) {
  const s = (raw || "").trim();
  if (!s || s.toLowerCase() === "null") return ""; // a literal "NULL" asset cell is empty, not a coin named NULL
  const parts = s.split(":");
  const token = parts.length > 1 ? parts[1] : parts[0];
  const symbol = token.toUpperCase();
  return CHAIN_NAME_TO_TICKER[symbol] || symbol;
}

// The network an asset cell implies. BitGo encodes the chain as a prefix on the
// ASSET column: no prefix = ERC-20/Ethereum (e.g. "usdc"), "trx:usdt" = Tron,
// "polygon:usdt" = Polygon. Returns a canonical key ("eth"/"tron"/"polygon"/…)
// or "" when there's no prefix (the caller then infers it from the coin type).
function resolveAssetNetwork(raw) {
  const s = (raw || "").trim();
  if (!s || s.toLowerCase() === "null") return "";
  const parts = s.split(":");
  if (parts.length > 1) return networkKey(parts[0]);
  return "";
}
// Normalizes any network label/prefix (schedule text or asset prefix) to a
// canonical key so a fee row's "Tron (TRC20)" matches an asset's "trx" prefix.
function networkKey(net) {
  const s = String(net || "").toLowerCase().trim();
  if (!s) return "";
  if (s.includes("trc") || s.includes("tron") || s === "trx") return "tron";
  if (s.includes("polygon") || s.includes("matic") || s === "pol") return "polygon";
  if (s.includes("erc") || s.includes("ethereum") || s === "eth" || s === "ether") return "eth";
  if (s.includes("bitcoin") || s === "btc") return "bitcoin";
  if (s.includes("avalanche") || s.includes("avax")) return "avalanche";
  return s;
}

// Pulls whatever a row calls its own wallet, whether that's a label
// ("Production Bitcoin Hot Wallet") or an external id - used both to
// resolve a row automatically and, when it can't be, to show the human-
// readable label a "map this wallet" prompt should display.
function rawSourceWalletLabel(row) {
  return (row.WALLET_LABEL || row.WalletLabel || row.walletLabel || row.Wallet || row.wallet || "").trim();
}
function rawSourceWalletExternalId(row) {
  return (row.WALLET_ID || row.WalletId || row.walletId || "").trim();
}

// A multi-wallet account-level export (Bitgo's own "all activity" CSV) lists
// every wallet's transactions in one file, distinguished by a wallet label/id
// column rather than the caller picking one destination wallet up front. A
// source's own wallet name essentially never matches this app's own Wallet
// name exactly ("Production Bitcoin Hot Wallet" vs. "Bitgo hot wallet -
// Company #Crypto") - so beyond the exact-match/address check this also
// checks `walletLabelRules`, a small "teach once" table the importer lets a
// human build by mapping an unresolved label to one of this app's Wallets;
// every future row with that same label then routes automatically, the same
// pattern bank rules and crypto ledger-account rules already use elsewhere.
function resolveSourceWallet(row, wallets, walletLabelRules = []) {
  const label = rawSourceWalletLabel(row);
  const externalId = rawSourceWalletExternalId(row);
  if (label) {
    const byName = wallets.find((w) => w.name.toLowerCase() === label.toLowerCase());
    if (byName) return byName;
    const rule = walletLabelRules.find((r) => r.label.toLowerCase() === label.toLowerCase());
    if (rule) {
      const ruleWallet = wallets.find((w) => w.id === rule.walletId);
      if (ruleWallet) return ruleWallet;
    }
  }
  if (externalId) {
    const byAddress = wallets.find((w) => w.address && w.address.trim().toLowerCase() === externalId.toLowerCase());
    if (byAddress) return byAddress;
  }
  return undefined;
}

// A single BitGo wallet holds both a coin and its stablecoins (ETH + USDT,
// SOL + USDC, ...), but the chart of accounts keeps stablecoin and non-
// stablecoin custody in separate wallets - named identically apart from a
// "#Stablecoin" vs "#Crypto" tag. Once a row's source wallet is resolved, this
// re-points it to its sibling when the coin's asset type doesn't match the
// wallet's tag: a USDT/USDC row landing on a "#Crypto" wallet moves to the
// "#Stablecoin" sibling, and vice versa. If no such sibling exists (a wallet
// without the tag, or no matching pair), the original wallet is kept - so this
// only ever helps and never strands a row.
function assetRoutedWallet(resolved, coin, wallets) {
  if (!resolved || !coin || coin.assetType === "Fiat") return resolved;
  const wantStable = coin.assetType === "Stablecoin";
  const name = resolved.name || "";
  const hasStable = /#\s*stablecoin/i.test(name);
  const hasCrypto = /#\s*crypto/i.test(name);
  let target = null;
  if (wantStable && hasCrypto && !hasStable) target = name.replace(/#\s*crypto/i, "#Stablecoin");
  else if (!wantStable && hasStable && !hasCrypto) target = name.replace(/#\s*stablecoin/i, "#Crypto");
  if (!target) return resolved;
  const sibling = wallets.find((w) => w.name.toLowerCase() === target.toLowerCase());
  return sibling || resolved;
}

// For a trade, given the base (crypto) wallet, find the venue's wallet that
// holds the quote currency: the #Stablecoin sibling for USDT/USDC, or the
// venue's #USD account for a fiat quote. Tries a same-name tag swap first, then
// falls back to a wallet sharing the base wallet's venue word (e.g. "Bitgo")
// that carries the right tag - the COA's USD accounts aren't named identically
// to the crypto wallets, so the venue-word fallback is what usually matches.
function tradeQuoteWallet(baseWallet, quoteCoin, wallets) {
  if (!baseWallet || !quoteCoin) return baseWallet;
  if (quoteCoin.assetType === "Stablecoin") return assetRoutedWallet(baseWallet, quoteCoin, wallets);
  if (!quoteCoin.isFiat && quoteCoin.assetType !== "Fiat") return baseWallet; // crypto-for-crypto: same venue crypto wallet
  const name = baseWallet.name || "";
  const swap = name.replace(/#\s*(crypto|stablecoin)/i, "#USD");
  const exact = wallets.find((w) => w.name.toLowerCase() === swap.toLowerCase());
  if (exact) return exact;
  const venueWord = (name.split(/[\s-]+/)[0] || "").toLowerCase();
  const byVenue = wallets.find((w) => /#\s*usd\b/i.test(w.name) && w.name.toLowerCase().includes(venueWord));
  return byVenue || wallets.find((w) => /#\s*usd\b/i.test(w.name)) || baseWallet;
}

// Some exports (Bitgo's own "address transfer detail" CSV included) give
// every leg of a transaction its own row sharing one transaction id -
// typically a Withdrawal row and a separate standalone Fee row, rather than
// this app's expected shape of one row per transaction with the fee as its
// own column. Grouped by that shared id, a Fee row (or several - some
// transactions report more than one) gets folded into whichever Withdrawal
// row shares its id, as that row's fee - fees only ever accompany an
// outbound leg (you don't pay a network fee to receive), so a Fee row with
// no Withdrawal sibling, or no id at all, has nowhere to attach and is left
// untouched to fall through the normal per-row parse, where it skips as an
// unsupported "Fee" type exactly as it would have before this step existed.
// A row with no id of its own (most exports - one row already is one
// transaction) passes through completely untouched.
function rawRowGroupKey(row) {
  return (
    row.TxHash || row.txHash || row.Hash || row.hash ||
    row["Transaction ID"] || row["TransactionId"] || row["Transaction Id"] || row.TxId || row.txid ||
    row.TX_ID || row.tx_id || ""
  ).trim();
}
function mergeCryptoFeeRows(rows) {
  const groups = new Map();
  const ungrouped = [];
  rows.forEach((row) => {
    const key = rawRowGroupKey(row);
    if (!key) { ungrouped.push(row); return; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const result = [...ungrouped];
  for (const groupRows of groups.values()) {
    const isFeeRow = (r) => normalizeNativeType(r.Type || r.type || r.TX_TYPE || r.tx_type || "") === "fee";
    const feeRows = groupRows.filter(isFeeRow);
    const mainRows = groupRows.filter((r) => !isFeeRow(r));
    if (feeRows.length === 0 || mainRows.length === 0) {
      result.push(...groupRows); // nothing to merge - pass everything through as-is
      continue;
    }
    const withdrawalIdx = mainRows.findIndex((r) => {
      const raw = (r.Type || r.type || r.TX_TYPE || r.tx_type || "").trim();
      return CRYPTO_TX_TYPES.includes(raw) ? raw === "Withdrawal" : normalizeNativeType(raw) === "withdrawal";
    });
    if (withdrawalIdx === -1) {
      result.push(...groupRows); // no outbound leg to attach a fee to
      continue;
    }
    // Several fee rows for one transaction (e.g. a network fee plus a
    // service fee) are summed into one FeeQuantity, priced off the first
    // fee row that actually has its own price.
    const feeQty = feeRows.reduce((s, r) => {
      const q = parseFloat(r.AMOUNT ?? r.Amount ?? r.amount ?? r.Quantity ?? r.quantity);
      return s + (Number.isFinite(q) ? Math.abs(q) : 0);
    }, 0);
    const feePriceRow = feeRows.find((r) => Number.isFinite(parseFloat(r.USD_PRICE ?? r.Price ?? r.price)));
    const feePriceRaw = feePriceRow ? parseFloat(feePriceRow.USD_PRICE ?? feePriceRow.Price ?? feePriceRow.price) : undefined;
    mainRows[withdrawalIdx] = {
      ...mainRows[withdrawalIdx],
      __mergedFeeQuantity: feeQty,
      __mergedFeePrice: feePriceRaw,
    };
    result.push(...mainRows);
  }
  return result;
}

function parseCryptoCsvRow(row, walletId, coins, accounts, wallets, walletLabelRules = []) {
  const rawType = (row.Type || row.type || row.TX_TYPE || row.tx_type || "").trim();
  const type = CRYPTO_TX_TYPES.includes(rawType)
    ? rawType
    : { deposit: "Deposit", withdrawal: "Withdrawal", transfer: "Transfer", fee: "Fee" }[normalizeNativeType(rawType)];
  if (!type || !CRYPTO_TX_TYPES.includes(type)) return null;
  // Custody platforms (Bitgo included) export a full ISO timestamp
  // ("2026-06-15T10:30:00Z", or Bitgo's own account-level "DATETIME" column)
  // - trimmed to just the date part, since that's all the rest of this app
  // (and FIFO date-ordering) works with.
  const dateRaw = (row.Date || row.date || row.DATETIME || row.datetime || row.DATE || "").trim();
  const date = dateRaw.toLowerCase() === "null" ? "" : dateRaw.slice(0, 10); // a literal "NULL" date is empty, so the row is skipped rather than dated "NULL"
  const rawAsset = row.Coin || row.coin || row.Asset || row.asset || row.ASSET || "";
  const coinSymbol = resolveCryptoAssetSymbol(rawAsset);
  const coin = coins.find((c) => c.symbol === coinSymbol);
  // Network the row is on, for network-specific withdrawal fees. Prefer the
  // asset prefix (BitGo: "trx:usdt", "polygon:usdt"); with no prefix a token
  // defaults to ERC-20 while a native coin's network is left implicit.
  const network = resolveAssetNetwork(rawAsset) || (coin && coin.assetType === "Stablecoin" ? "eth" : "");
  // Bitgo (and most pure custody platforms) only ever report a quantity of
  // the asset itself - "Amount" - never a USD price, since they don't track
  // fiat valuation at all. Quantity is read from whichever the source
  // calls it; if there's no separate price column, this falls back to the
  // coin's own reference market rate as a starting estimate - it's today's
  // rate, not necessarily the rate on the transaction's own date, so it's
  // worth double-checking/correcting in Drafts for anything cost-basis-
  // sensitive, same as the "Get Rate" shortcut already does for manual entry.
  // Some exports sign the amount by direction (negative for a Withdrawal) -
  // the Type field already carries that direction, so quantity is always
  // stored as a magnitude.
  const quantityRaw = parseFloat(row.Quantity ?? row.quantity ?? row.Amount ?? row.amount ?? row.AMOUNT);
  const quantity = Number.isFinite(quantityRaw) ? Math.abs(quantityRaw) : quantityRaw;
  // Some exports (like Bitgo's address-transfer-detail CSV) do carry a real
  // historical price - "USD_PRICE" - which is a better starting point than
  // today's market rate and is preferred when present.
  const priceRaw = parseFloat(row.Price ?? row.price ?? row.Rate ?? row.rate ?? row.UnitPrice ?? row.unitPrice ?? row.USD_PRICE ?? row.usd_price);
  const perCoinPrice = Number.isFinite(priceRaw) ? priceRaw : coin?.marketRate;
  // Same idea for the fee: a single "Fee" column (Bitgo's convention) is a
  // quantity of the same asset, paid at the same time - so it's priced at
  // the same perCoinPrice unless the row gives its own fee price.
  // `__mergedFeeQuantity`/`__mergedFeePrice` take priority when present -
  // mergeCryptoFeeRows only sets them once, so they're an unambiguous signal
  // this row already absorbed a separate Fee row's amount.
  const feeQuantityRawSigned = row.__mergedFeeQuantity !== undefined
    ? row.__mergedFeeQuantity
    : parseFloat(row.FeeQuantity ?? row.feeQuantity ?? row.Fee ?? row.fee ?? row.FEE);
  const feeQuantityRaw = Number.isFinite(feeQuantityRawSigned) ? Math.abs(feeQuantityRawSigned) : feeQuantityRawSigned;
  const feePerCoinPriceRaw = row.__mergedFeePrice !== undefined
    ? row.__mergedFeePrice
    : parseFloat(row.FeePerCoinPrice ?? row.feePerCoinPrice);
  const feePerCoinPrice = Number.isFinite(feePerCoinPriceRaw) ? feePerCoinPriceRaw : perCoinPrice;
  // A row with no recognizable date/coin/quantity/price isn't a transaction
  // at all - skip it entirely rather than creating an empty draft. A zero
  // (or negative) principal quantity is skipped too: these are the fee-only
  // legs some exports emit (a network fee was paid but nothing moved), which
  // can never post - they'd only clutter Needs review forever.
  if (!date || !coin || !Number.isFinite(quantity) || !(quantity > 0) || !Number.isFinite(perCoinPrice)) return null;
  // Dust: a quantity so tiny its USD value rounds to zero even at 8 decimals
  // (e.g. 1e-18 of an 18-decimal token = a single base unit) can never post -
  // its ledger legs would all round to $0. When a real price is known, skip it
  // as negligible rather than parking un-postable dust in Needs review. Rows
  // with no price yet (rate 0) aren't dust - those are a "set the rate" case.
  if (perCoinPrice > 0 && Math.round(quantity * perCoinPrice * 1e8) / 1e8 === 0) return null;

  // A source sometimes literally writes "null"/"NULL" for an empty address
  // field rather than leaving the cell blank - treat that as no counterparty.
  const addressLabelRaw = (row.ADDRESS_LABEL || "").trim();
  const addressLabel = addressLabelRaw.toLowerCase() === "null" ? "" : addressLabelRaw;
  const counterpartyLabelRaw = (
    row.Counterparty || row.counterparty || addressLabel ||
    row.Address || row.address || row.ADDRESS ||
    row.To || row.to || row.From || row.from || row.Destination || row.destination || ""
  ).trim();
  const counterpartyLabel = counterpartyLabelRaw.toLowerCase() === "null" ? "" : counterpartyLabelRaw;
  const counterparty = counterpartyLabel ? resolveCounterparty(counterpartyLabel, wallets) : undefined;

  // Multi-wallet account-level exports carry their own wallet per row - use
  // it when it matches one of this app's Wallets, otherwise fall back to
  // whichever single wallet the user picked in the importer.
  const sourceWallet = resolveSourceWallet(row, wallets, walletLabelRules);
  // Auto-route stablecoins vs non-stablecoins to the matching custody wallet
  // when a "#Stablecoin"/"#Crypto" sibling exists, so one mixed BitGo export
  // splits USDT/USDC from the rest without any per-asset mapping.
  const baseWallet = sourceWallet || wallets.find((w) => w.id === walletId);
  const routedWallet = assetRoutedWallet(baseWallet, coin, wallets);
  const resolvedWalletId = routedWallet?.id || sourceWallet?.id || walletId;

  const notesRaw = (row.Notes || row.notes || row.COMMENTS || row.comments || "").trim();

  const tx = {
    type, date, coinId: coin.id, walletId: resolvedWalletId,
    quantity, perCoinPrice,
    ...(network ? { network } : {}),
    feeQuantity: Number.isFinite(feeQuantityRaw) ? feeQuantityRaw : undefined,
    feePerCoinPrice: Number.isFinite(feeQuantityRaw) ? feePerCoinPrice : undefined,
    reference: (row.Reference || row.reference || "").trim(),
    txHash: (
      row.TxHash || row.txHash || row.Hash || row.hash ||
      row["Transaction ID"] || row["TransactionId"] || row["Transaction Id"] || row.TxId || row.txid ||
      row.TX_ID || row.tx_id || ""
    ).trim(),
    // A source sometimes literally writes the string "NULL" for an empty
    // field rather than leaving the cell blank - treat that as no note.
    notes: notesRaw.toUpperCase() === "NULL" ? "" : notesRaw,
    counterparty, // "self:<wallet name>" | "external:<label>" | undefined - context + rule key, never persisted as a ledger fact on its own
    autoRoutedWallet: resolvedWalletId !== walletId, // routed by name/rule or by stablecoin/crypto asset type - summary count only, not a persisted ledger fact
  };
  if (type === "Transfer") {
    const toWalletName = (row.ToWallet || row.toWallet || "").trim();
    let toWallet = toWalletName ? wallets.find((w) => w.name === toWalletName) : undefined;
    // No explicit ToWallet column, but the counterparty resolved to one of
    // our own wallets - that's exactly what ToWallet means, so use it.
    if (!toWallet && counterparty?.startsWith("self:")) {
      toWallet = wallets.find((w) => w.name === counterparty.slice(5));
    }
    tx.toWalletId = toWallet?.id; // left undefined if unresolved - fixable inline
  } else {
    const acctRef = (row.LedgerAccount || row.ledgerAccount || "").trim();
    const acct = accounts.find((a) => a.code === acctRef || a.name === acctRef);
    tx.ledgerAccountId = acct?.id; // left undefined if unresolved - fixable inline
  }
  return tx;
}

// A "remembered" rule for crypto: since CSV rows don't have free-text
// description the way a bank line does, the natural match key is
// (transaction type, coin) - e.g. "BTC deposits always go to Share
// capital" - optionally narrowed further by counterparty (e.g. "USDT
// deposits from an external party go to Client custody payable, but USDT
// deposits from our own OKX wallet go to Share capital"). A rule with no
// counterparty saved is a wildcard - it still matches rows that do have
// one, so existing simple rules keep working exactly as before; a rule
// with a counterparty only matches that specific counterparty and is
// checked first, since it's the more specific rule. Applied only when a
// row didn't already resolve a ledger account on its own (Transfer's
// ToWallet is never rule-matched - it's a specific destination, not a
// category).
// Returns the matched rule object (not just an account) so the caller can
// apply either a single ledger account or a label (a multi-account contra
// split). A counterparty-specific rule wins over a wildcard.
function applyCryptoRule(tx, rules, ctx) {
  if (tx.type === "Transfer" || tx.ledgerAccountId || (tx.ledgerSplits && tx.ledgerSplits.length)) return undefined;
  // Filter-condition rules (auto-mapping) are user-defined for a whole filtered
  // set, so they're the most explicit and take precedence.
  const cond = rules.find((r) => Array.isArray(r.conditions) && r.conditions.length && r.labelId && matchesCryptoFilter(tx, r.conditions, ctx));
  if (cond) return cond;
  const specific = tx.counterparty && rules.find((r) => r.type === tx.type && r.coinId === tx.coinId && r.counterparty === tx.counterparty);
  if (specific) return specific;
  return rules.find((r) => r.type === tx.type && r.coinId === tx.coinId && !r.counterparty && !r.conditions);
}

// The patch that maps a transaction onto a label without posting - the same
// resolution the importer and bulk "Label & post" use, so auto-mapping a
// filtered set behaves identically. Returns null when the label can't apply yet
// (no value) or doesn't fit the row's direction.
function labelPatchFor(t, label, wallets, coins) {
  if (!label) return null;
  const coin = coins.find((c) => c.id === t.coinId);
  const value = coinValue(t.quantity, t.perCoinPrice);
  if (labelIsFullEntry(label)) {
    const feLegs = resolveFullEntryLegs(label, value);
    return feLegs ? { fullEntryLegs: feLegs, matchedLabelId: label.id } : null;
  }
  if (labelIsTransfer(label)) {
    const dest = labelTransferDestWallet(label, wallets, t.walletId, coin);
    if (!dest || dest.id === t.walletId) return null;
    return { type: "Transfer", toWalletId: dest.id, ledgerLegs: undefined, ledgerAccountId: null, ledgerSplits: null, matchedLabelId: label.id };
  }
  const legs = resolveLabelLegs(label, t.type, value);
  if (!legs) return null;
  const lw = labelPostWallet(label, wallets, coin);
  return { ledgerLegs: legs, ledgerAccountId: null, ledgerSplits: null, matchedLabelId: label.id, ...(lw ? { walletId: lw.id } : {}) };
}

// A label can carry the full journal entry (from the settlement sheet),
// including a wallet leg flagged wallet:true. The FIFO engine posts the wallet
// side from cost basis, so only the *non-wallet* legs are the contra applied to
// a transaction. Their net (credit % minus debit %) gives the direction: +100
// is a deposit contra, -100 a withdrawal contra. A plain one-account label is
// the single-leg case.
function labelContraLegs(label) {
  return (label?.legs || []).filter((l) => !l.wallet);
}
function labelNetPct(label) {
  return labelContraLegs(label).reduce((s, l) => s + (l.side === "credit" ? (Number(l.pct) || 0) : -(Number(l.pct) || 0)), 0);
}
function labelDirection(label) {
  const contra = labelContraLegs(label);
  if (contra.length === 0) return null;
  const net = labelNetPct(label);
  if (Math.abs(net - 100) < 0.01) return "Deposit";
  if (Math.abs(net + 100) < 0.01) return "Withdrawal";
  return null; // doesn't net to a full contra - not applicable until fixed
}
// Expands a label's contra (non-wallet) legs into the ledgerLegs the engine
// posts for a transaction of this type and value: each leg's pct becomes a
// cents amount, with the rounding residual absorbed by the largest leg on the
// net side so the contra nets to the value exactly. Returns null if the label's
// direction doesn't match the transaction, or a leg is unusable.
function resolveLabelLegs(label, txType, value) {
  if (!label || !(value > 0)) return null;
  const contra = labelContraLegs(label);
  if (contra.length === 0) return null;
  if (contra.some((l) => !l.accountId || (l.side !== "debit" && l.side !== "credit"))) return null;
  // A Fee is a crypto outflow like a withdrawal, so withdrawal-direction labels
  // (Dr expense / Cr wallet, e.g. the Gas fee labels) apply to it.
  const effectiveType = txType === "Fee" ? "Withdrawal" : txType;
  if (labelDirection(label) !== effectiveType) return null;
  const direction = effectiveType === "Deposit" ? "credit" : "debit";
  // Amounts are carried to 8 decimals (not cents) so a sub-cent value doesn't
  // round a leg to zero and make an otherwise-valid label look inapplicable.
  const r8 = (x) => Math.round(x * 1e8) / 1e8;
  const val = r8(value);
  const legs = contra.map((l) => ({ accountId: l.accountId, side: l.side, amount: r8((Number(l.pct) || 0) / 100 * val) }));
  const rawNet = legs.reduce((s, l) => s + (l.side === direction ? l.amount : -l.amount), 0);
  const residual = r8(val - rawNet);
  if (Math.abs(residual) >= 5e-9) {
    let idx = -1;
    legs.forEach((l, i) => { if (l.side === direction && (idx === -1 || l.amount > legs[idx].amount)) idx = i; });
    if (idx >= 0) legs[idx].amount = r8(legs[idx].amount + residual);
  }
  if (legs.some((l) => !(l.amount > 0))) return null;
  return legs;
}

// A "transfer label" carries no contra (non-wallet) leg - just two or more
// wallet legs (Dr = destination/receiving, Cr = source/sending). It represents
// an internal move of crypto between two of the company's own wallets. There's
// no P&L or liability change, so it isn't posted as a deposit/withdrawal contra;
// instead, applying it turns the transaction into a Transfer and the FIFO engine
// carries the cost basis from the source wallet to the destination wallet.
function labelIsTransfer(label) {
  if (!label || !Array.isArray(label.legs)) return false;
  if (labelIsTrade(label)) return false; // a trade swaps two coins - not a same-coin transfer
  if (labelContraLegs(label).length > 0) return false;
  const walletLegs = label.legs.filter((l) => l.wallet && l.accountId);
  return walletLegs.length >= 2 && walletLegs.some((l) => l.side === "debit");
}
// A "trade label" is a venue spot swap between two different coins (a #Crypto
// wallet and a #Stablecoin/#USD wallet) - Dr the acquired-side wallet, Cr the
// disposed-side wallet. It's flagged explicitly (kind: "trade") because from
// the accounts alone it's indistinguishable from a same-coin transfer. The CSV
// exports fold any execution fee into the price (cost basis), so there's no
// separate fee leg; the engine derives a fee only if the price shows a spread.
function labelIsTrade(label) {
  return !!label && label.kind === "trade";
}
// A "full-entry" label carries a complete, self-balancing journal entry (its
// debit legs sum to its credit legs) that a transaction posts verbatim, scaled
// to the transaction's value - no FIFO cost basis or gain/loss. It's used for
// compound entries the single-wallet mechanics can't express, e.g. a gas fee
// paid from the client wallet AND its simultaneous company top-up: Cr client
// wallet (gas out) / Dr Gas fee / Dr client wallet (top-up) / Cr Gas fee
// clearing. `appliesTo` names the transaction type it's offered for.
function labelIsFullEntry(label) {
  return !!label && label.fullEntry === true;
}
function resolveFullEntryLegs(label, value) {
  if (!labelIsFullEntry(label) || !(value > 0)) return null;
  const legs = (label.legs || []).map((l) => ({
    accountId: l.accountId, side: l.side,
    amount: Math.round((Number(l.pct) || 0) / 100 * value * 1e8) / 1e8,
    label: "Full entry",
  }));
  if (legs.some((l) => !l.accountId || (l.side !== "debit" && l.side !== "credit") || !(l.amount > 0))) return null;
  const dr = legs.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
  const cr = legs.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
  if (Math.abs(dr - cr) >= 5e-9) return null; // must self-balance
  return legs;
}
// Applying a trade label determines how a Trade posts: the Dr wallet leg is the
// acquired-side wallet, the Cr wallet leg is the disposed-side wallet, and any
// non-wallet leg names the fee account. The engine then supplies the mechanism
// (dispose at FIFO cost, acquire at cost, realized gain/loss, fee). Returns the
// patch to apply to the Trade transaction, or null if it isn't a trade label.
function labelTradeApply(label, wallets) {
  if (!labelIsTrade(label)) return null;
  const wl = (label.legs || []).filter((l) => l.wallet && l.accountId);
  const drLeg = wl.find((l) => l.side === "debit");
  const crLeg = wl.find((l) => l.side === "credit");
  const acquired = drLeg && wallets.find((w) => w.accountId === drLeg.accountId);
  const disposed = crLeg && wallets.find((w) => w.accountId === crLeg.accountId);
  if (!acquired || !disposed) return null;
  const feeLeg = (label.legs || []).find((l) => !l.wallet && l.accountId);
  return { walletId: acquired.id, disposedWalletId: disposed.id, feeAccountId: feeLeg ? feeLeg.accountId : undefined };
}
// Resolves which wallet a transfer label should move the crypto *to*. The
// transaction already sits on one wallet (its source); the destination is the
// label's other wallet leg. Preference: the wallet leg whose account isn't the
// transaction's own wallet, else the debit (receiving) leg. Returns the wallet
// object, or undefined if this isn't a transfer label / the wallet is missing.
function labelTransferDestWallet(label, wallets, txWalletId, coin) {
  if (!labelIsTransfer(label)) return undefined;
  const walletLegs = label.legs.filter((l) => l.wallet && l.accountId);
  const txAcct = wallets.find((w) => w.id === txWalletId)?.accountId;
  const otherLeg = walletLegs.find((l) => l.accountId !== txAcct)
    || walletLegs.find((l) => l.side === "debit");
  const dest = otherLeg ? wallets.find((w) => w.accountId === otherLeg.accountId) : undefined;
  // Route to the coin's #Stablecoin/#Crypto sibling so one sweep label serves
  // both (the tx's own wallet is already the matching sibling from import).
  return dest && coin ? assetRoutedWallet(dest, coin, wallets) : dest;
}

// A deposit/withdrawal label carries exactly one wallet leg (the custody
// account the coin lands in or leaves, e.g. "Bitgo hot wallet - for Client").
// That leg - not the wallet picked at import - is the accounting truth, so
// applying such a label re-points the transaction onto that wallet (posting +
// FIFO both follow). Returns the wallet, or undefined when the label has no
// single wallet leg (transfers/reference labels) or the wallet is missing.
function labelWalletLegWallet(label, wallets) {
  if (!label || !Array.isArray(label.legs)) return undefined;
  const walletLegs = label.legs.filter((l) => l.wallet && l.accountId);
  if (walletLegs.length !== 1) return undefined;
  return wallets.find((w) => w.accountId === walletLegs[0].accountId);
}
// The wallet a label actually posts to, once the coin's asset type is taken
// into account: a single label ("Client crypto deposit") points at one custody
// wallet, but its #Stablecoin/#Crypto sibling is auto-selected from the coin -
// so one label serves both USDT/USDC and other crypto, no stablecoin-vs-crypto
// duplicate needed.
function labelPostWallet(label, wallets, coin) {
  const w = labelWalletLegWallet(label, wallets);
  return w ? assetRoutedWallet(w, coin, wallets) : w;
}

// Cryptio-style transaction filter: a set of AND conditions over a crypto
// transaction. Each condition is { field, value }; an empty value matches
// everything (so a half-filled condition row doesn't hide the whole list).
// `search` matches loosely across counterparty / reference / tx hash / coin
// symbol / wallet name.
// Where a crypto transaction came from, so Needs Review can be filtered by
// origin when a Bitgo client-custody CSV and gas-tank syncs are mixed together.
const CRYPTO_SOURCES = [
  { value: "client", label: "Bitgo · Client wallet" },
  { value: "gastank", label: "Bitgo · Gas tank" },
  { value: "kraken", label: "Kraken" },
  { value: "manual", label: "Manual entry" },
];
function cryptoSourceLabel(src) {
  return CRYPTO_SOURCES.find((s) => s.value === src)?.label || (src || "Manual entry");
}

function matchesCryptoFilter(tx, conditions, ctx) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => {
    const v = c.value;
    if (v === undefined || v === null || v === "") return true;
    switch (c.field) {
      case "type": return tx.type === v;
      case "coin": return tx.coinId === v;
      case "wallet": return tx.walletId === v || tx.toWalletId === v;
      case "label": return (tx.matchedLabelId || "") === v;
      case "source": return (tx.source || "manual") === v;
      case "dateFrom": return tx.date >= v;
      case "dateTo": return tx.date <= v;
      case "search": {
        const q = String(v).toLowerCase();
        const coinSym = (ctx?.coins.find((x) => x.id === tx.coinId)?.symbol || "");
        const walletNm = (ctx?.wallets.find((x) => x.id === tx.walletId)?.name || "");
        return [tx.counterparty, tx.reference, tx.txHash, coinSym, walletNm]
          .filter(Boolean).some((s) => String(s).toLowerCase().includes(q));
      }
      default: return true;
    }
  });
}

// Normalizes a stored crypto label to the multi-leg model, migrating older
// saved shapes so nothing breaks: legs that already carry a side pass through;
// a Debit/Credit-account record becomes credit/debit legs; the oldest
// percentage-split records (legs with a pct but no side) are treated as credit
// contra legs (they were deposit splits).
function normalizeCryptoLabel(l) {
  if (Array.isArray(l.legs) && l.legs.length && l.legs[0].side) return l;
  const legs = [];
  if (Array.isArray(l.legs) && l.legs.length) {
    // old { accountId, pct }[] split -> credit legs
    l.legs.forEach((leg) => { if (leg.accountId) legs.push({ accountId: leg.accountId, side: "credit", pct: Number(leg.pct) || 0 }); });
  } else {
    if (l.creditAccountId) legs.push({ accountId: l.creditAccountId, side: "credit", pct: 100 });
    if (l.debitAccountId && !l.creditAccountId) legs.push({ accountId: l.debitAccountId, side: "debit", pct: 100 });
  }
  return { id: l.id, label: l.label, status: l.status || "active", legs, ...(l.kind ? { kind: l.kind } : {}) };
}

// One-time migrations for saved labels that predate a structural change. The
// client-withdrawal fee moved from a hardcoded percentage leg to the flat fee
// schedule, so any old sl_a2 (lacking the withdrawFeeRevenue flag) is reset to
// the current default: clean Dr client-payable / Cr wallet, with the fee applied
// automatically from the schedule.
function migrateCryptoLabels(labels) {
  const defA2 = DEFAULT_CRYPTO_LABELS.find((l) => l.id === "sl_a2");
  // Reset any client-withdrawal label that predates the fee-receivable model
  // (old percentage legs, or the first flat-fee version without the receivable
  // account) to the current default.
  return labels.map((l) => (l.id === "sl_a2" && !l.feeReceivableAccountId && defA2 ? { ...defA2 } : l));
}

// A placeholder Coin for an asset that appears in an import but isn't in the
// master list yet. Rather than skip those rows, the importer creates the coin
// on the fly (market rate left at 0 for the user to fill in on the Coins tab)
// so the transaction still lands in the ledger. The row's own price column
// (e.g. Bitgo's USD_PRICE) drives valuation regardless of this default.
function makeCoinForSymbol(symbol) {
  return {
    id: uid("coin"), symbol, name: symbol, rateSymbol: symbol,
    isFiat: false, assetType: "Crypto", chain: "", category: "", marketRate: 0,
  };
}

// Bitgo trades/fills export: each row is a partial fill; fills of one order
// share CLIENT_ORDER_ID. This aggregates fills into one Trade per order (sum
// base & quote quantities, VWAP price), maps buy/sell + base/quote, and routes
// the base to the venue crypto wallet and the quote to its #USD / #Stablecoin
// wallet. Each Trade is stored as acquired (coinId/quantity/perCoinPrice/
// walletId) + disposed (disposedCoinId/disposedQuantity/disposedPrice/
// disposedWalletId); the engine's Trade branch posts the swap + realized gain.
function isTradeFillsCsv(fields) {
  const f = (fields || []).map((x) => (x || "").toUpperCase());
  return f.includes("TRADE_PRODUCT") && f.includes("ORDER_SIDE") && f.includes("EXECUTED_BASE_QUANTITY");
}
function importTradeFills(rows, walletId, wallets, coins, existingTxs, cryptoLabels = []) {
  const workingCoins = [...coins];
  const newCoins = [];
  const ensureCoin = (sym) => {
    const symbol = resolveCryptoAssetSymbol(sym);
    if (!symbol) return undefined;
    let coin = workingCoins.find((c) => c.symbol === symbol);
    if (!coin) { coin = makeCoinForSymbol(symbol); workingCoins.push(coin); newCoins.push(coin); }
    return coin;
  };
  // Dedup is at the individual fill (FILL_ID) - a genuinely identical row - not
  // the order. Sharing a CLIENT_ORDER_ID just means fills of the same order and
  // is not a duplicate; that id is only used to group fills. Any fill already
  // imported (recorded in a trade's fillIds) is dropped, so re-importing an
  // order that has since gained new fills keeps the new ones instead of skipping
  // the whole order.
  let added = 0, dupes = 0, skipped = 0, autoRouted = 0;
  const importedFillIds = new Set();
  existingTxs.forEach((t) => (t.fillIds || []).forEach((id) => importedFillIds.add(id)));
  // group not-yet-imported fills by order
  const orders = new Map();
  rows.forEach((r) => {
    const fid = (r.FILL_ID || "").trim();
    if (fid && importedFillIds.has(fid)) { dupes++; return; } // this exact fill was already imported
    if (fid) importedFillIds.add(fid); // guard against the same fill appearing twice in one file
    const key = (r.CLIENT_ORDER_ID || fid || "").trim();
    if (!key) return;
    if (!orders.has(key)) orders.set(key, []);
    orders.get(key).push(r);
  });
  const next = [];
  for (const fills of orders.values()) {
    const first = fills[0];
    const side = (first.ORDER_SIDE || "").trim().toLowerCase();
    const baseSym = (first.EXECUTED_BASE_CURRENCY || "").trim();
    const quoteSym = (first.EXECUTED_QUOTE_CURRENCY || "").trim();
    const baseQty = fills.reduce((s, r) => s + (parseFloat(r.EXECUTED_BASE_QUANTITY) || 0), 0);
    const quoteQty = fills.reduce((s, r) => s + (parseFloat(r.EXECUTED_QUOTE_QUANTITY) || 0), 0);
    const date = fills.map((r) => (r.FILL_DATETIME || r.FILL_CREATION_DATE || "").trim().slice(0, 10)).filter(Boolean).sort()[0];
    if (!date || !baseSym || !quoteSym || !(baseQty > 0) || !(quoteQty > 0) || (side !== "buy" && side !== "sell")) { skipped++; continue; }
    const baseCoin = ensureCoin(baseSym), quoteCoin = ensureCoin(quoteSym);
    if (!baseCoin || !quoteCoin) { skipped++; continue; }
    const execPrice = quoteQty / baseQty;               // VWAP, quote per base
    const quoteRate = quoteCoin.isFiat ? 1 : (quoteCoin.marketRate || 1); // USDT/USDC ~ 1
    // The base of a spot trade is the crypto being bought/sold, so it belongs in
    // a #Crypto wallet. Route from the fallback, but if that isn't a crypto
    // wallet (e.g. the fallback is a USD account), land on a Company #Crypto
    // wallet so the quote wallet can then be found as its venue sibling.
    let baseWallet = assetRoutedWallet(wallets.find((w) => w.id === walletId), baseCoin, wallets);
    const baseIsCrypto = !baseCoin.isFiat && baseCoin.assetType !== "Stablecoin";
    if (baseIsCrypto) {
      // Venue spot trades are company activity, so default the crypto side to a
      // Company #Crypto wallet - not a client custody one - if the fallback
      // isn't already a company crypto wallet. (Editable per row before posting.)
      const nm = (baseWallet && baseWallet.name) || "";
      if (!/#\s*crypto/i.test(nm) || /client/i.test(nm)) {
        baseWallet = wallets.find((w) => /#\s*crypto/i.test(w.name) && /company/i.test(w.name) && !/client/i.test(w.name)) || baseWallet;
      }
    }
    const quoteWallet = tradeQuoteWallet(baseWallet, quoteCoin, wallets);
    const routed = baseWallet && baseWallet.id !== walletId;
    // buy: acquire base, dispose quote; sell: acquire quote, dispose base
    const tx = side === "buy"
      ? { type: "Trade", date, side,
          coinId: baseCoin.id, quantity: baseQty, perCoinPrice: execPrice, walletId: (baseWallet || {}).id,
          disposedCoinId: quoteCoin.id, disposedQuantity: quoteQty, disposedPrice: quoteRate, disposedWalletId: (quoteWallet || {}).id }
      : { type: "Trade", date, side,
          coinId: quoteCoin.id, quantity: quoteQty, perCoinPrice: quoteRate, walletId: (quoteWallet || {}).id,
          disposedCoinId: baseCoin.id, disposedQuantity: baseQty, disposedPrice: execPrice, disposedWalletId: (baseWallet || {}).id };
    tx.reference = (first.CLIENT_ORDER_ID || "").trim();
    tx.txHash = (first.SETTLEMENT_ID || first.FILL_ID || "").trim();
    tx.fillCount = fills.length;
    // The label mapping is the source of truth for how a trade posts: find the
    // trade label whose acquired/disposed venue wallets match this trade, apply
    // it (so the label determines the wallets), and record it. The engine then
    // supplies the FIFO cost basis, realized gain/loss, and any fee.
    const tl = cryptoLabels.find((l) => {
      if (!labelIsTrade(l)) return false;
      const p = labelTradeApply(l, wallets);
      return p && p.walletId === tx.walletId && p.disposedWalletId === tx.disposedWalletId;
    });
    if (tl) { const p = labelTradeApply(tl, wallets); Object.assign(tx, p); tx.matchedLabelId = tl.id; tx.matchedByRule = true; }
    // The exact fills this trade aggregates - the dedup identity for re-imports.
    tx.fillIds = fills.map((r) => (r.FILL_ID || "").trim()).filter(Boolean);
    const hash = `Trade|${[...tx.fillIds].sort().join(",")}`;
    if (routed) autoRouted++;
    next.push({ ...tx, hash });
    added++;
  }
  return { added, dupes, skipped, autoRouted, newCoins, txs: next };
}

// Bitgo "address-transfer-detail" export: each on-chain transaction is recorded
// once per wallet address it touches, so an internal consolidation shows up as a
// Deposit to one address AND a Withdrawal from another (net zero), and a real
// inflow can appear as two Deposit legs plus a Withdrawal under one TX_ID. Taken
// row-by-row this double-counts (and dedup then collapses the wrong legs). So we
// aggregate by TX_ID + ASSET and net the legs: the transaction becomes a single
// Deposit or Withdrawal of the net amount (internal, net-zero moves drop out).
// Fee rows are deliberately IGNORED: in this export a Fee has a NULL running
// balance - it's a non-balance-affecting annotation whose amount is already
// inside the matching Withdrawal (a Tron gas fee, for example, is logged as both
// a Fee and a Withdrawal of the same TRX). Counting fees separately would
// double-count the outflow and drive holdings negative. The gas therefore rides
// inside the withdrawal (a pure-gas transfer imports as a small Withdrawal the
// user can label "Gas fee ...").
function isBitgoAddressTransferCsv(fields) {
  const f = (fields || []).map((x) => (x || "").trim().toUpperCase());
  return f.includes("TX_ID") && f.includes("ASSET") && f.includes("TX_TYPE") && f.includes("AMOUNT") && f.includes("TOTAL_BALANCE");
}
function aggregateBitgoAddressTransferRows(rows) {
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
  // Balance-aware fee handling: a Fee row whose TOTAL_BALANCE is NULL/blank is a
  // non-balance-affecting annotation - the gas is already inside the wallet's own
  // withdrawal, so it's ignored. A Fee row that carries a real balance is an
  // actual native-token outflow (a BitGo gas-tank spend lives on its own gas-tank
  // wallet), so it's kept and posted as a Fee. Grouping by wallet keeps the gas
  // tank separate from the transacting wallet.
  const balReal = (v) => { const b = String(v ?? "").trim(); return b !== "" && b.toUpperCase() !== "NULL" && Number.isFinite(parseFloat(b)); };
  const groups = new Map(); // TX_ID|ASSET|WALLET -> aggregate
  rows.forEach((r) => {
    const txid = String(r.TX_ID ?? r.tx_id ?? "").trim();
    const asset = String(r.ASSET ?? r.asset ?? "").trim();
    if (!txid || !asset) return;
    const wl = String(r.WALLET_LABEL ?? "").trim();
    const key = txid + "|" + asset + "|" + wl;
    let g = groups.get(key);
    if (!g) { g = { txid, asset, dep: 0, wd: 0, feeReal: 0, date: "", price: "", wallet: wl, walletId: "", cp: "" }; groups.set(key, g); }
    const type = normalizeNativeType(r.TX_TYPE ?? r.tx_type ?? "");
    const amt = num(r.AMOUNT ?? r.amount);
    if (type === "deposit") g.dep += Math.abs(amt);
    else if (type === "withdrawal") g.wd += Math.abs(amt);
    else if (type === "fee" && balReal(r.TOTAL_BALANCE)) g.feeReal += Math.abs(amt); // real gas-tank spend, not an annotation
    if (!g.date) g.date = String(r.DATE ?? r.DATETIME ?? "").trim();
    if (!g.price && (r.USD_PRICE ?? r.usd_price)) g.price = String(r.USD_PRICE ?? r.usd_price).trim();
    if (!g.walletId) g.walletId = String(r.WALLET_ID ?? "").trim();
    const lab = String(r.ADDRESS_LABEL ?? "").trim();
    if (!g.cp && lab && lab.toLowerCase() !== "null") g.cp = lab;
  });
  const out = [];
  const EPS = 1e-12;
  for (const g of groups.values()) {
    const base = { DATETIME: g.date, ASSET: g.asset, USD_PRICE: g.price, WALLET_LABEL: g.wallet, WALLET_ID: g.walletId, ADDRESS_LABEL: g.cp, TX_ID: g.txid };
    const net = g.dep - g.wd;
    if (net > EPS) out.push({ ...base, TX_TYPE: "Deposit", AMOUNT: String(net) });
    else if (net < -EPS) out.push({ ...base, TX_TYPE: "Withdrawal", AMOUNT: String(Math.abs(net)) });
    // net ~ 0 -> internal consolidation, nothing to post
    if (g.feeReal > EPS) out.push({ ...base, TX_TYPE: "Fee", AMOUNT: String(g.feeReal) }); // real gas-tank / balance-affecting fee
  }
  return out;
}

// An Avalanche C-Chain (EVM) export: a raw on-chain list that includes outgoing
// transfers, contract creations, and NFT (erc1155) rows. Per the desired
// treatment, ONLY incoming value is recognized - a row with a positive
// ValueIn(NativeToken) becomes a Deposit of the native token (AVAX), and an
// incoming fungible-token transfer (a TokenSymbol with a positive TokenAmount)
// becomes a Deposit of that token; everything else (ValueOut, contract-created,
// NFTs, zero-value method calls) is dropped.
function isAvalancheEvmCsv(fields) {
  const f = (fields || []).map((x) => (x || "").trim());
  return f.includes("ChainName") && f.includes("NativeToken") && f.includes("TxHash") &&
    f.some((x) => /^ValueIn\(NativeToken\)/i.test(x));
}
function normalizeAvalancheEvmRows(rows, wallets) {
  const num = (v) => parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  const walletByAddr = (a) => a && wallets.find((w) => w.address && w.address.trim().toLowerCase() === a);
  const addr = (r, k) => String(r[k] ?? "").trim().toLowerCase();
  // Identify our address (wallet-address match, else most frequent) so a
  // gas-tank export - keyed by one of our addresses - can be recognized.
  const counts = {};
  rows.forEach((r) => { const f = addr(r, "From"), t = addr(r, "To"); if (f) counts[f] = (counts[f] || 0) + 1; if (t) counts[t] = (counts[t] || 0) + 1; });
  let ours = Object.keys(counts).find((a) => walletByAddr(a));
  if (!ours) ours = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const nativeSymOf = (r) => String(r.NativeToken ?? "").trim();
  const DUST = 1e-6;
  // Gas-tank detection: our address actively spends native gas (From == ours,
  // TxFee > 0) and isn't primarily a deposit-collection wallet. Then outgoing
  // native (ValueOut + TxFee) is a gas/network cost (Fee), spam token/NFT rows
  // are ignored, and native top-ins are Deposits (cost basis). A normal wallet
  // (real deposits in) keeps the incoming-only behavior.
  let realIn = 0, realOut = 0;
  rows.forEach((r) => {
    const vin = num(r["ValueIn(NativeToken)"]), vout = num(r["ValueOut(NativeToken)"]), fee = num(r["TxFee(NativeToken)"]);
    if (addr(r, "To") === ours && Number.isFinite(vin) && vin >= DUST) realIn++;
    if (addr(r, "From") === ours && ((Number.isFinite(vout) && vout >= DUST) || (Number.isFinite(fee) && fee >= DUST))) realOut++;
  });
  const gasTank = realOut >= 1 && realOut >= realIn;
  const out = [];
  rows.forEach((r) => {
    const date = String(r.Date ?? "").trim().slice(0, 10);
    const nativeSym = nativeSymOf(r);
    const nativePrice = num(r["NativeTokenHistoricPrice(USD)"]);
    const valueIn = num(r["ValueIn(NativeToken)"]);
    const valueOut = num(r["ValueOut(NativeToken)"]);
    const fee = num(r["TxFee(NativeToken)"]);
    const from = addr(r, "From"), to = addr(r, "To");
    if (gasTank) {
      // Only native AVAX matters for a gas tank; ignore ERC-20/1155 (airdrop spam).
      if (to === ours && Number.isFinite(valueIn) && valueIn > 0) {
        out.push({ Date: date, Type: "Deposit", Coin: nativeSym, Quantity: String(valueIn), Price: Number.isFinite(nativePrice) ? String(nativePrice) : "", Counterparty: String(r.FromName ?? "").trim() || (r.From ?? ""), TxHash: r.TxHash ?? "", WALLET_ID: to });
      } else if (from === ours) {
        const spent = (Number.isFinite(valueOut) ? valueOut : 0) + (Number.isFinite(fee) ? fee : 0);
        if (spent > 0) out.push({ Date: date, Type: "Fee", Coin: nativeSym, Quantity: String(spent), Price: Number.isFinite(nativePrice) ? String(nativePrice) : "", Counterparty: String(r.ToName ?? "").trim() || (r.To ?? ""), TxHash: r.TxHash ?? "", WALLET_ID: from });
      }
      return;
    }
    // Normal wallet: incoming deposits only (native or token).
    const tokenSym = String(r.TokenSymbol ?? "").trim();
    const tokenAmt = num(r.TokenAmount);
    let coin, qty, price;
    if (Number.isFinite(valueIn) && valueIn > 0) { coin = nativeSym; qty = valueIn; price = Number.isFinite(nativePrice) ? nativePrice : ""; }
    else if (tokenSym && Number.isFinite(tokenAmt) && tokenAmt > 0) { coin = tokenSym; qty = tokenAmt; price = ""; }
    else return; // not an incoming deposit - ignored
    out.push({
      Date: date,
      Type: "Deposit", Coin: coin, Quantity: String(qty), Price: price === "" ? "" : String(price),
      Counterparty: String(r.FromName ?? "").trim() || (r.From ?? ""),
      TxHash: r.TxHash ?? "",
      WALLET_ID: to,
    });
  });
  return out;
}

/// A Polygonscan-style native-transactions export: keyed by Transaction Hash,
// with separate Value_IN(<SYM>) / Value_OUT(<SYM>) / TxnFee(<SYM>) columns and a
// per-row Historical $Price/<SYM>. The native ticker is embedded in the column
// names (POL, and older exports MATIC - unified to POL downstream). Same
// gas-tank treatment as the Avalanche export: our address's native spend
// (Value_OUT + TxnFee) is a Fee, native top-ins are Deposits.
function polygonscanNativeSym(fields) {
  const m = (fields || []).map((x) => String(x || "").trim()).find((x) => /^Value_IN\(/i.test(x));
  const mm = m && m.match(/^Value_IN\(([^)]+)\)/i);
  return mm ? mm[1].trim() : "";
}
function isPolygonscanCsv(fields) {
  const f = (fields || []).map((x) => String(x || "").replace(/^﻿/, "").trim());
  const has = (re) => f.some((x) => re.test(x));
  return f.some((x) => /transaction hash/i.test(x)) && has(/^Value_IN\(/i) && has(/^TxnFee\(/i);
}
function normalizePolygonscanRows(rows, wallets, fields) {
  const num = (v) => parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  const walletByAddr = (a) => a && wallets.find((w) => w.address && w.address.trim().toLowerCase() === a);
  const sym = polygonscanNativeSym(fields) || "POL";
  const get = (r, key) => r[key] ?? r["﻿" + key] ?? "";
  const addr = (r, k) => String(get(r, k)).trim().toLowerCase();
  const vIn = (r) => num(get(r, `Value_IN(${sym})`));
  const vOut = (r) => num(get(r, `Value_OUT(${sym})`));
  const txFee = (r) => num(get(r, `TxnFee(${sym})`));
  const priceOf = (r) => { const p = num(get(r, `Historical $Price/${sym}`)); return Number.isFinite(p) && p > 0 ? String(p) : ""; };
  const ok = (r) => { const e = String(get(r, "ErrCode")).trim(), st = String(get(r, "Status")).trim().toLowerCase(); return !e && (!st || st === "success"); };
  const counts = {};
  rows.forEach((r) => { const f = addr(r, "From"), t = addr(r, "To"); if (f) counts[f] = (counts[f] || 0) + 1; if (t) counts[t] = (counts[t] || 0) + 1; });
  let ours = Object.keys(counts).find((a) => walletByAddr(a));
  if (!ours) ours = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const DUST = 1e-6;
  let realIn = 0, realOut = 0;
  rows.forEach((r) => {
    if (!ok(r)) return;
    if (addr(r, "To") === ours && vIn(r) >= DUST) realIn++;
    if (addr(r, "From") === ours && (vOut(r) >= DUST || txFee(r) >= DUST)) realOut++;
  });
  const gasTank = realOut >= 1 && realOut >= realIn;
  const out = [];
  rows.forEach((r) => {
    if (!ok(r)) return;
    const date = String(get(r, "DateTime (UTC)") || get(r, "DateTime")).trim().slice(0, 10);
    const from = addr(r, "From"), to = addr(r, "To");
    const hash = get(r, "Transaction Hash");
    if (gasTank) {
      if (to === ours && vIn(r) > 0) {
        out.push({ Date: date, Type: "Deposit", Coin: sym, Quantity: String(vIn(r)), Price: priceOf(r), Counterparty: get(r, "From"), TxHash: hash, WALLET_ID: to });
      } else if (from === ours) {
        const spent = vOut(r) + txFee(r);
        if (spent > 0) out.push({ Date: date, Type: "Fee", Coin: sym, Quantity: String(spent), Price: priceOf(r), Counterparty: get(r, "To"), TxHash: hash, WALLET_ID: from });
      }
      return;
    }
    // Normal wallet: incoming native deposits only.
    if (to === ours && vIn(r) > 0) {
      out.push({ Date: date, Type: "Deposit", Coin: sym, Quantity: String(vIn(r)), Price: priceOf(r), Counterparty: get(r, "From"), TxHash: hash, WALLET_ID: to });
    }
  });
  return out;
}

// A Tron (TronScan) transaction export: on-chain transfers keyed by Txn Hash,
// with From/To Tron addresses and a Token Symbol/Amount. There are no nametags,
// so "our" wallet is the address that appears in the most rows (or a wallet
// whose address matches). Per the desired treatment, only incoming transfers
// (To == our address) are imported, as Deposits; outgoing and failed rows drop.
function isTronCsv(fields) {
  const f = (fields || []).map((x) => (x || "").trim());
  return f.includes("Txn Hash") && f.includes("Token Symbol") && f.includes("Method ID") && f.includes("Transaction Type");
}
function normalizeTronRows(rows, wallets) {
  const walletByAddr = (a) => a && wallets.find((w) => w.address && w.address.trim().toLowerCase() === a);
  const counts = {};
  rows.forEach((r) => {
    const f = String(r.From ?? "").trim().toLowerCase(), t = String(r.To ?? "").trim().toLowerCase();
    if (f) counts[f] = (counts[f] || 0) + 1;
    if (t) counts[t] = (counts[t] || 0) + 1;
  });
  let ours = Object.keys(counts).find((a) => walletByAddr(a));
  if (!ours) ours = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ok = (r) => {
    const result = String(r.Result ?? "").trim().toUpperCase();
    const status = String(r.Status ?? "").trim().toUpperCase();
    return !((result && result !== "SUCCESS") || (status && status !== "CONFIRMED"));
  };
  const amtOf = (r) => parseFloat(String(r.Amount ?? "").replace(/,/g, ""));
  const symOf = (r) => String(r["Token Symbol"] ?? "").trim();
  const DUST = 0.01; // TRX below this is activation/notification dust, not a real deposit
  // Detect a gas-tank export: our address sends real TRX out and receives no
  // real TRX deposits (a fee wallet is funded elsewhere and only spends). In
  // that case outgoing TRX is a gas/network cost (Fee), not a withdrawal, and
  // spam TRC-10 airdrops are ignored. A normal client-deposit wallet (real TRX
  // coming in) keeps the incoming-only behavior so its outflows - already
  // captured in the custody export - aren't double-counted.
  let realIn = 0, realOut = 0;
  rows.forEach((r) => {
    if (!ok(r) || symOf(r).toUpperCase() !== "TRX") return;
    const amt = amtOf(r); if (!(amt >= DUST)) return;
    const to = String(r.To ?? "").trim().toLowerCase(), from = String(r.From ?? "").trim().toLowerCase();
    if (to === ours) realIn++; else if (from === ours) realOut++;
  });
  const gasTank = realOut >= 1 && realOut >= realIn;
  const out = [];
  rows.forEach((r) => {
    if (!ok(r)) return;
    const to = String(r.To ?? "").trim().toLowerCase(), from = String(r.From ?? "").trim().toLowerCase();
    const amt = amtOf(r);
    const sym = symOf(r);
    const date = String(r["Time (UTC)"] ?? "").trim().slice(0, 10);
    const hash = r["Txn Hash"] ?? "";
    if (gasTank) {
      if (sym.toUpperCase() !== "TRX") return; // ignore spam TRC-10 tokens (e.g. airdrops)
      if (!(amt > 0)) return;
      if (to === ours) { // TRX top-up into the gas tank -> cost basis
        out.push({ DATETIME: date, Type: "Deposit", Coin: "TRX", Quantity: String(amt), Price: "", Counterparty: String(r.From ?? "").trim(), TxHash: hash, WALLET_ID: to });
      } else if (from === ours) { // TRX spent by the gas tank -> gas/network fee
        out.push({ DATETIME: date, Type: "Fee", Coin: "TRX", Quantity: String(amt), Price: "", Counterparty: String(r.To ?? "").trim(), TxHash: hash, WALLET_ID: from });
      }
      return;
    }
    // Normal wallet: only incoming (deposits into our wallet).
    if (to !== ours) return;
    if (!(amt > 0)) return;
    out.push({ DATETIME: date, Type: "Deposit", Coin: sym, Quantity: String(amt), Price: "", Counterparty: String(r.From ?? "").trim(), TxHash: hash, WALLET_ID: to });
  });
  return out;
}

// A block-explorer (Etherscan/BscScan-style) transaction export: an on-chain
// list keyed by Transaction Hash, with From/To addresses (+ optional nametags),
// the value as "0.033 ETH" (amount and symbol together), a "Value (USD)" column,
// and the network "Txn Fee". Direction (deposit vs withdrawal) is decided by
// which side is one of our wallets - by address if the wallet's address is set,
// otherwise the untagged side is treated as ours (an exchange counterparty
// carries a nametag like "Binance 17"; our own address usually doesn't).
function isExplorerCsv(fields) {
  const f = (fields || []).map((x) => (x || "").replace(/^﻿/, "").trim().toLowerCase());
  return f.includes("transaction hash") && f.includes("amount") && f.some((x) => x.startsWith("value (usd)"));
}
function normalizeExplorerRows(rows, wallets) {
  const get = (r, key) => r[key] ?? r["﻿" + key] ?? "";
  const walletByAddr = (a) => a && wallets.find((w) => w.address && w.address.trim().toLowerCase() === a);
  // Determine which address is ours: a wallet-address match wins; otherwise the
  // most-frequent address across the file (an exchange/gas-tank export is keyed
  // by one of our addresses, so it recurs on every row). This lets the direction
  // logic work even when nametags are absent (as in a BitGo gas-tank export).
  const counts = {};
  rows.forEach((r) => {
    const f = String(get(r, "From")).trim().toLowerCase(), t = String(get(r, "To")).trim().toLowerCase();
    if (f) counts[f] = (counts[f] || 0) + 1;
    if (t) counts[t] = (counts[t] || 0) + 1;
  });
  let freqOurs = Object.keys(counts).find((a) => walletByAddr(a));
  if (!freqOurs) freqOurs = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const out = [];
  rows.forEach((r) => {
    const status = String(get(r, "Status")).trim().toLowerCase();
    if (status && status !== "success") return; // drop failed/pending on-chain txs
    const amountRaw = String(get(r, "Amount")).replace(/,/g, "").trim();
    const m = amountRaw.match(/^([\d.]+)\s*([A-Za-z0-9]+)?/);
    const qty = m ? m[1] : amountRaw;
    const sym = m && m[2] ? m[2] : "";
    const q = parseFloat(qty);
    const valUsd = parseFloat(String(get(r, "Value (USD)")).replace(/[$,\s]/g, ""));
    const price = (Number.isFinite(valUsd) && valUsd > 0 && q > 0) ? valUsd / q : "";
    const date = String(get(r, "DateTime (UTC)") || get(r, "DateTime")).trim().slice(0, 10);
    const from = String(get(r, "From")).trim().toLowerCase();
    const to = String(get(r, "To")).trim().toLowerCase();
    const fromTag = String(get(r, "From_Nametag")).trim();
    const toTag = String(get(r, "To_Nametag")).trim();
    const feeRaw = String(get(r, "Txn Fee")).replace(/,/g, "").trim();
    const feeN = parseFloat(feeRaw);
    const txh = get(r, "Transaction Hash");
    // Resolve ownership: address match > nametag heuristic > most-frequent address.
    let ourSide = null; // "to" (incoming) or "from" (outgoing)
    if (walletByAddr(to)) ourSide = "to";
    else if (walletByAddr(from)) ourSide = "from";
    else if (!toTag && fromTag) ourSide = "to";
    else if (!fromTag && toTag) ourSide = "from";
    else if (to === freqOurs) ourSide = "to";
    else if (from === freqOurs) ourSide = "from";
    else ourSide = "to"; // default: treat as incoming
    if (ourSide === "to") {
      if (q > 0) out.push({ Date: date, Type: "Deposit", Coin: sym, Quantity: qty, Price: price === "" ? "" : String(price), Fee: "", Counterparty: fromTag || get(r, "From"), TxHash: txh, WALLET_ID: to });
      // incoming with 0 value = contract call we received nothing from; skip
    } else {
      // Outgoing from our address. With a dedicated gas tank, principal sends and
      // gas live in separate exports, so we don't double-book gas here:
      //  - a real principal transfer (qty>0) -> Withdrawal (no separate gas leg)
      //  - a pure gas op (qty==0, fee>0, e.g. a gas-tank Flush/Send Multi Sig) ->
      //    a Fee of the native gas spent, charged to this (gas-tank) wallet.
      if (q > 0) {
        out.push({ Date: date, Type: "Withdrawal", Coin: sym, Quantity: qty, Price: price === "" ? "" : String(price), Fee: "", Counterparty: toTag || get(r, "To"), TxHash: txh, WALLET_ID: from });
      } else if (sym && feeN > 0) {
        out.push({ Date: date, Type: "Fee", Coin: sym, Quantity: feeRaw, Price: "", Fee: "", Counterparty: toTag || get(r, "To"), TxHash: txh, WALLET_ID: from });
      }
    }
  });
  return out;
}

function importCryptoCsv(text, walletId, wallets, coins, accounts, existingTxs, rules = [], walletLabelRules = [], cryptoLabels = []) {
  const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  // A Bitgo trades/fills export is a different shape - route it to the trade
  // aggregator, which produces Trade transactions instead of deposits/withdrawals.
  if (isTradeFillsCsv(parsed.meta?.fields)) {
    return importTradeFills(parsed.data, walletId, wallets, coins, existingTxs, cryptoLabels);
  }
  // Fees are kept as their own transactions (not merged into the withdrawal):
  // a source's separate "Fee" rows import as standalone Fee entries, and any
  // inline fee column is split off into its own Fee transaction below.
  // A block-explorer export (Etherscan-style: Transaction Hash / From / To /
  // Amount "0.033 ETH" / Value (USD) / Txn Fee) is first normalized into the
  // standard row shape so the rest of the pipeline handles it unchanged.
  const rows = isBitgoAddressTransferCsv(parsed.meta?.fields) ? aggregateBitgoAddressTransferRows(parsed.data)
    : isAvalancheEvmCsv(parsed.meta?.fields) ? normalizeAvalancheEvmRows(parsed.data, wallets)
    : isPolygonscanCsv(parsed.meta?.fields) ? normalizePolygonscanRows(parsed.data, wallets, parsed.meta?.fields)
    : isTronCsv(parsed.meta?.fields) ? normalizeTronRows(parsed.data, wallets)
    : isExplorerCsv(parsed.meta?.fields) ? normalizeExplorerRows(parsed.data, wallets)
    : parsed.data;
  return buildCryptoTxsFromRows(rows, walletId, wallets, coins, accounts, existingTxs, rules, walletLabelRules, cryptoLabels);
}

// The shared back half of the import pipeline: takes already-normalized rows
// ({Date, Type, Coin, Quantity, Price, Fee?, Counterparty?, TxHash?, WALLET_ID?})
// and turns them into transaction records - auto-creating coins, de-duping by a
// content hash, applying remembered rules/labels, routing wallets, and splitting
// inline fees. Both CSV import (importCryptoCsv) and live on-chain fetch (the gas
// tank sync) feed their rows through here so the two paths behave identically.
function buildCryptoTxsFromRows(rows, walletId, wallets, coins, accounts, existingTxs, rules = [], walletLabelRules = [], cryptoLabels = []) {
  // Auto-create a Coin for any asset in the file that isn't in the master
  // list yet, so no row is skipped merely for referencing an unknown asset.
  const workingCoins = [...coins];
  const newCoins = [];
  rows.forEach((row) => {
    const symbol = resolveCryptoAssetSymbol(row.Coin || row.coin || row.Asset || row.asset || row.ASSET || "");
    if (!symbol || workingCoins.some((c) => c.symbol === symbol)) return;
    const coin = makeCoinForSymbol(symbol);
    workingCoins.push(coin);
    newCoins.push(coin);
  });
  const existingHashes = new Set(existingTxs.map((t) => t.hash).filter(Boolean));
  let added = 0, dupes = 0, skipped = 0, autoRouted = 0;
  const next = [];
  rows.forEach((row) => {
    const tx = parseCryptoCsvRow(row, walletId, workingCoins, accounts, wallets, walletLabelRules);
    if (!tx) { skipped++; return; }
    const hash = `${tx.date}|${tx.type}|${tx.walletId}|${tx.coinId}|${tx.quantity}|${tx.perCoinPrice}|${tx.txHash || ""}`;
    if (existingHashes.has(hash)) { dupes++; return; }
    existingHashes.add(hash);
    const rule = applyCryptoRule(tx, rules, { coins: workingCoins, wallets });
    if (rule) {
      if (rule.labelId) {
        const label = cryptoLabels.find((l) => l.id === rule.labelId && l.status !== "inactive");
        const coin = workingCoins.find((c) => c.id === tx.coinId);
        if (labelIsFullEntry(label)) {
          const feLegs = resolveFullEntryLegs(label, coinValue(tx.quantity, tx.perCoinPrice));
          if (feLegs) { tx.fullEntryLegs = feLegs; tx.matchedLabelId = rule.labelId; tx.matchedByRule = true; }
          const { autoRoutedWallet, ...clean } = tx; if (autoRoutedWallet) autoRouted++; next.push({ ...clean, hash }); added++; return;
        }
        const destWallet = labelTransferDestWallet(label, wallets, tx.walletId, coin);
        if (destWallet && destWallet.id !== tx.walletId) {
          // internal transfer between company wallets - re-type the row and let
          // the FIFO engine move the cost basis (no contra posted).
          tx.type = "Transfer"; tx.toWalletId = destWallet.id;
          tx.matchedLabelId = rule.labelId; tx.matchedByRule = true;
        } else {
          const legs = resolveLabelLegs(label, tx.type, coinValue(tx.quantity, tx.perCoinPrice));
          if (legs) {
            tx.ledgerLegs = legs; tx.matchedLabelId = rule.labelId; tx.matchedByRule = true;
            // The label's wallet leg is the accounting wallet (auto-routed to the
            // coin's stablecoin/crypto sibling) - re-point the row onto it.
            const lw = labelPostWallet(label, wallets, coin);
            if (lw) tx.walletId = lw.id;
          }
        }
      } else if (rule.ledgerAccountId) {
        tx.ledgerAccountId = rule.ledgerAccountId; tx.matchedByRule = true;
      }
    }
    // `autoRoutedWallet` is only a summary signal for the importer - never
    // part of the transaction record itself.
    const { autoRoutedWallet, ...cleanTx } = tx;
    if (autoRoutedWallet) autoRouted++;
    // Split an inline fee (a Fee column on the same row) into its own Fee
    // transaction, so every fee is a separate entry regardless of source shape.
    const feeQ = cleanTx.feeQuantity;
    if (Number.isFinite(feeQ) && feeQ > 0) {
      const feePrice = Number.isFinite(cleanTx.feePerCoinPrice) ? cleanTx.feePerCoinPrice : cleanTx.perCoinPrice;
      const feeTx = {
        type: "Fee", date: cleanTx.date, coinId: cleanTx.coinId, walletId: cleanTx.walletId,
        quantity: feeQ, perCoinPrice: feePrice,
        reference: cleanTx.reference, txHash: cleanTx.txHash, notes: cleanTx.notes, counterparty: cleanTx.counterparty,
      };
      const feeHash = `${feeTx.date}|Fee|${feeTx.walletId}|${feeTx.coinId}|${feeTx.quantity}|${feeTx.perCoinPrice}|${feeTx.txHash || ""}`;
      if (!existingHashes.has(feeHash)) { existingHashes.add(feeHash); next.push({ ...feeTx, hash: feeHash }); added++; }
      delete cleanTx.feeQuantity; delete cleanTx.feePerCoinPrice;
    }
    next.push({ ...cleanTx, hash });
    added++;
  });
  return { added, dupes, skipped, autoRouted, newCoins, txs: next };
}

// ---------- gas-tank on-chain fetch ----------
//
// A gas tank is a dedicated fee wallet on one chain. Rather than exporting a CSV
// from each block explorer, the app can pull an address's native-coin activity
// straight from the explorer's API and feed it through the same gas-tank rules
// the CSV importers use: native coin received = a top-up (Deposit / cost basis),
// native coin sent (transfer value + gas) = a gas cost (Fee). Token/NFT spam is
// ignored because only native transfers are requested.

// EVM chains reachable through the unified Etherscan V2 multichain API - one API
// key, one base URL (https://api.etherscan.io/v2/api), the network chosen by a
// `chainid` query parameter. Each entry's `sym` is the chain's native coin.
// `provider` picks the explorer API: "etherscan" = the unified Etherscan V2
// endpoint (needs the user's key), "routescan" = Routescan's Etherscan-format
// endpoint (free, keyless). Etherscan's free plan doesn't cover Avalanche
// C-Chain, so that chain is fetched from Routescan instead.
const EVM_GAS_CHAINS = {
  eth: { chainId: 1, sym: "ETH", label: "Ethereum", provider: "etherscan" },
  polygon: { chainId: 137, sym: "POL", label: "Polygon", provider: "etherscan" },
  avalanche: { chainId: 43114, sym: "AVAX", label: "Avalanche C-Chain", provider: "routescan" },
};
const GAS_TANK_CHAINS = {
  ...EVM_GAS_CHAINS,
  tron: { chainId: "tron", sym: "TRX", label: "Tron", provider: "tronscan" },
};

// The four BitGo gas tanks, pre-registered so they don't have to be re-added.
// All post to the company gas wallet (112106), resolved at sync time - so no
// walletId is stored here. Stable ids keep them consistent across reloads.
const DEFAULT_GAS_TANKS = [
  { id: "gtank_eth", name: "ETH gas tank", chain: "eth", address: "0xa244c3D8a460cCC02891Eac831457Cf5D4791454", cursor: 0, lastSyncedAt: 0 },
  { id: "gtank_trx", name: "TRX gas tank", chain: "tron", address: "TNijQXE1VG2jMghcdwpbfhYHxSFxmmhZzx", cursor: 0, lastSyncedAt: 0 },
  { id: "gtank_avax", name: "AVAXC gas tank", chain: "avalanche", address: "0xFC78DE37dB2f7EcA8E7F14ec0EB1285b825A0077", cursor: 0, lastSyncedAt: 0 },
  { id: "gtank_pol", name: "POL gas tank", chain: "polygon", address: "0x4c20038845f3B0c4DCf72CD76984E4EB57ca31c1", cursor: 0, lastSyncedAt: 0 },
];

// Map free-typed chain text (key, native symbol, label, or a common alias) to a
// canonical GAS_TANK_CHAINS key. Returns "" if nothing matches.
const GAS_CHAIN_ALIASES = {
  eth: "eth", ethereum: "eth", ether: "eth",
  pol: "polygon", polygon: "polygon", matic: "polygon",
  avax: "avalanche", avaxc: "avalanche", avalanche: "avalanche", "avalanche c-chain": "avalanche", "c-chain": "avalanche",
  trx: "tron", tron: "tron",
};
function resolveGasChainKey(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return "";
  if (GAS_TANK_CHAINS[s]) return s;
  for (const [key, cfg] of Object.entries(GAS_TANK_CHAINS)) {
    if (s === cfg.sym.toLowerCase() || s === cfg.label.toLowerCase()) return key;
  }
  if (GAS_CHAIN_ALIASES[s]) return GAS_CHAIN_ALIASES[s];
  for (const [key, cfg] of Object.entries(GAS_TANK_CHAINS)) {
    if (cfg.label.toLowerCase().includes(s)) return key;
  }
  return "";
}

// wei/sun (or any base unit) -> whole-coin float via BigInt, so an 18-decimal
// value never loses precision to Number before the divide.
function baseUnitsToFloat(raw, decimals) {
  try {
    const s = String(raw ?? "0").trim();
    if (!s || !/^\d+$/.test(s)) { const f = parseFloat(s); return Number.isFinite(f) ? f / Math.pow(10, decimals) : 0; }
    const big = BigInt(s);
    const div = BigInt("1" + "0".repeat(decimals));
    const whole = big / div, frac = big % div;
    return Number(whole) + Number(frac) / Math.pow(10, decimals);
  } catch { return 0; }
}

// Pure transform: Etherscan V2 txlist (external) + txlistinternal rows for one
// gas-tank address into normalized import rows. External sends carry gas (a real
// native outflow, charged even when the tx reverted); internal transfers don't
// (their gas was paid by the parent tx). Returns { rows, lastBlock }.
function evmTxsToGasTankRows(externalTxs, internalTxs, address, sym) {
  const ours = String(address || "").trim().toLowerCase();
  const rows = [];
  let lastBlock = 0;
  const dateOf = (ts) => { const n = Number(ts); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : ""; };
  (externalTxs || []).forEach((t) => {
    const from = String(t.from || "").toLowerCase(), to = String(t.to || "").toLowerCase();
    const bn = parseInt(t.blockNumber, 10); if (Number.isFinite(bn)) lastBlock = Math.max(lastBlock, bn);
    const value = baseUnitsToFloat(t.value, 18);
    const failed = String(t.isError) === "1" || String(t.txreceipt_status) === "0";
    const gasUsed = t.gasUsed ?? t.gas, gasPrice = t.gasPrice;
    let fee = 0;
    try { fee = baseUnitsToFloat((BigInt(String(gasUsed || "0")) * BigInt(String(gasPrice || "0"))).toString(), 18); } catch { fee = 0; }
    const date = dateOf(t.timeStamp);
    if (!date) return;
    if (to === ours && !failed && value > 0) {
      rows.push({ Date: date, Type: "Deposit", Coin: sym, Quantity: String(value), Price: "", Counterparty: t.from || "", TxHash: t.hash || "" });
    } else if (from === ours) {
      const spent = (failed ? 0 : value) + fee;
      if (spent > 0) rows.push({ Date: date, Type: "Fee", Coin: sym, Quantity: String(spent), Price: "", Counterparty: t.to || "", TxHash: t.hash || "" });
    }
  });
  // Internal transfers (contract-driven) only matter here as inbound top-ups.
  (internalTxs || []).forEach((t) => {
    const to = String(t.to || "").toLowerCase();
    const bn = parseInt(t.blockNumber, 10); if (Number.isFinite(bn)) lastBlock = Math.max(lastBlock, bn);
    const value = baseUnitsToFloat(t.value, 18);
    const failed = String(t.isError) === "1";
    const date = dateOf(t.timeStamp);
    if (date && to === ours && !failed && value > 0) {
      rows.push({ Date: date, Type: "Deposit", Coin: sym, Quantity: String(value), Price: "", Counterparty: t.from || "", TxHash: (t.hash || t.transactionHash || "") + "#int" });
    }
  });
  return { rows, lastBlock };
}

// Pure transform: TronScan transfer records for one gas-tank address into rows.
// Only native TRX moves (tokenName "trx"/"_") count; TRC-10/20 are ignored as
// spam. TRX in = Deposit, TRX out = Fee (the tank's spend). Returns { rows,
// lastTimestamp } where timestamps are ms since epoch.
function tronTransfersToGasTankRows(transfers, address) {
  const ours = String(address || "").trim();
  const rows = [];
  let lastTs = 0;
  (transfers || []).forEach((t) => {
    const token = String(t.tokenName ?? t.tokenAbbr ?? "").trim().toLowerCase();
    const isTrx = token === "trx" || token === "_" || token === "";
    if (!isTrx) return; // skip TRC-10/20 spam
    const from = String(t.transferFromAddress ?? t.ownerAddress ?? t.from ?? "").trim();
    const to = String(t.transferToAddress ?? t.toAddress ?? t.to ?? "").trim();
    const ts = Number(t.timestamp ?? t.block_timestamp ?? 0);
    if (Number.isFinite(ts) && ts > 0) lastTs = Math.max(lastTs, ts);
    const amt = baseUnitsToFloat(t.amount ?? t.value ?? "0", 6); // SUN -> TRX
    if (!(amt > 0)) return;
    const date = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : "";
    if (!date) return;
    const hash = t.transactionHash ?? t.hash ?? t.txID ?? "";
    if (to === ours) rows.push({ Date: date, Type: "Deposit", Coin: "TRX", Quantity: String(amt), Price: "", Counterparty: from, TxHash: hash });
    else if (from === ours) rows.push({ Date: date, Type: "Fee", Coin: "TRX", Quantity: String(amt), Price: "", Counterparty: to, TxHash: hash });
  });
  return { rows, lastTimestamp: lastTs };
}

// Live fetch wrappers (browser only). They call the explorer HTTP APIs and hand
// the raw arrays to the pure transforms above. All network/permission failures
// surface as a thrown Error with a human-readable message the UI shows verbatim.
async function fetchEvmGasTankRows(chainCfg, address, apiKey, startBlock = 0) {
  const key = (apiKey || "").trim();
  const routescan = chainCfg.provider === "routescan";
  // Routescan carries the chain in the path and needs no key; Etherscan V2 uses
  // a chainid param and requires the key.
  const base = routescan
    ? `https://api.routescan.io/v2/network/mainnet/evm/${chainCfg.chainId}/etherscan/api`
    : "https://api.etherscan.io/v2/api";
  const providerName = routescan ? "Routescan" : "Etherscan";
  if (!routescan && !key) throw new Error("An Etherscan API key is required for this chain. Add one in the gas-tank settings.");
  const common = [
    `address=${encodeURIComponent(address)}`,
    `startblock=${startBlock || 0}`, `endblock=99999999`, `page=1`, `offset=10000`, `sort=asc`,
    routescan ? "" : `chainid=${chainCfg.chainId}`,
    key ? `apikey=${encodeURIComponent(key)}` : "",
  ].filter(Boolean).join("&");
  const pull = async (action) => {
    let res;
    try { res = await fetch(`${base}?module=account&action=${action}&${common}`); }
    catch (e) { throw new Error(`Couldn't reach ${providerName} (${e.message}). This can be a network or CORS block - if it persists, fall back to CSV import.`); }
    if (!res.ok) throw new Error(`${providerName} returned HTTP ${res.status}.`);
    const json = await res.json();
    // status "0" with "No transactions found" is a normal empty result.
    if (String(json.status) === "0" && !/no transactions found/i.test(String(json.message || json.result || ""))) {
      throw new Error(`${providerName}: ${json.message || "request failed"}${typeof json.result === "string" ? " - " + json.result : ""}`);
    }
    return Array.isArray(json.result) ? json.result : [];
  };
  const ext = await pull("txlist");
  // Internal transfers are a bonus (inbound top-ups only); don't fail the whole
  // sync if a provider doesn't serve them.
  let intl = [];
  try { intl = await pull("txlistinternal"); } catch { intl = []; }
  return evmTxsToGasTankRows(ext, intl, address, chainCfg.sym);
}
async function fetchTronGasTankRows(address, apiKey, startTimestamp = 0) {
  const limit = 50;
  let start = 0, all = [], guard = 0;
  const headers = (apiKey || "").trim() ? { "TRON-PRO-API-KEY": apiKey.trim() } : {};
  while (guard++ < 40) {
    let url = `https://apilist.tronscanapi.com/api/transfer?sort=-timestamp&count=true&limit=${limit}&start=${start}&address=${encodeURIComponent(address)}`;
    if (startTimestamp > 0) url += `&start_timestamp=${startTimestamp + 1}`;
    let res;
    try { res = await fetch(url, { headers }); }
    catch (e) { throw new Error(`Couldn't reach TronScan (${e.message}). This can be a network or CORS block - if it persists, fall back to CSV import.`); }
    if (!res.ok) throw new Error(`TronScan returned HTTP ${res.status}.`);
    const json = await res.json();
    const batch = Array.isArray(json.data) ? json.data : [];
    all = all.concat(batch);
    if (batch.length < limit) break;
    start += limit;
  }
  return tronTransfersToGasTankRows(all, address);
}
// Dispatch a single gas tank to the right chain fetcher. Returns { rows, cursor }
// where cursor is the new lastBlock (EVM) or lastTimestamp (Tron) to store.
async function fetchGasTankRows(tank, keys) {
  const cfg = GAS_TANK_CHAINS[tank.chain];
  if (!cfg) throw new Error(`Unknown chain "${tank.chain}".`);
  if (!String(tank.address || "").trim()) throw new Error("This gas tank has no address set.");
  if (tank.chain === "tron") {
    const { rows, lastTimestamp } = await fetchTronGasTankRows(tank.address.trim(), keys?.tronscan, tank.cursor || 0);
    return { rows, cursor: Math.max(tank.cursor || 0, lastTimestamp) };
  }
  const { rows, lastBlock } = await fetchEvmGasTankRows(cfg, tank.address.trim(), keys?.etherscan, tank.cursor ? tank.cursor + 1 : 0);
  return { rows, cursor: Math.max(tank.cursor || 0, lastBlock) };
}

// ---------- Kraken (via a signing proxy) ----------
//
// Kraken's private API needs HMAC-signed requests with the secret key, which
// can't live in the browser, so calls go through the user's own signing proxy
// (see kraken-proxy-worker.js). Here we transform Kraken's TradesHistory and
// Ledgers responses into the app's Trade transactions and Deposit/Withdrawal
// rows, then feed them through the same import pipeline.

// Kraken asset codes -> app symbols (legacy X/Z prefixes; .S/.F staking suffixes
// collapse to the base; everything else passes through).
const KRAKEN_ASSETS = { XXBT: "BTC", XBT: "BTC", XETH: "ETH", XXRP: "XRP", XLTC: "LTC", XXDG: "DOGE", XDG: "DOGE", XXLM: "XLM", XETC: "ETC", XZEC: "ZEC", XREP: "REP", XMLN: "MLN", XXMR: "XMR", ZUSD: "USD", ZEUR: "EUR", ZGBP: "GBP", ZCAD: "CAD", ZJPY: "JPY", ZAUD: "AUD" };
function krakenAsset(code) {
  const c = String(code || "").trim().toUpperCase();
  if (KRAKEN_ASSETS[c]) return KRAKEN_ASSETS[c];
  const base = c.replace(/\.(S|F|M|P|B)$/, "");
  return KRAKEN_ASSETS[base] || resolveCryptoAssetSymbol(base) || base;
}
// Kraken concatenates base+quote in a pair; split by trying known quote codes.
const KRAKEN_QUOTES = ["ZUSD", "ZEUR", "ZGBP", "ZCAD", "ZJPY", "ZAUD", "USDT", "USDC", "DAI", "XXBT", "XBT", "XETH", "USD", "EUR", "GBP"];
function parseKrakenPair(pair) {
  const p = String(pair || "").trim().toUpperCase();
  for (const q of [...KRAKEN_QUOTES].sort((a, b) => b.length - a.length)) {
    if (p.length > q.length && p.endsWith(q)) return { base: krakenAsset(p.slice(0, p.length - q.length)), quote: krakenAsset(q) };
  }
  return null;
}
// Kraken TradesHistory result.trades -> fill rows in importTradeFills' shape, so
// the existing trade importer builds the Trade transactions (fee folded into the
// quote: paid on a buy, netted on a sell).
function krakenTradesToFillRows(trades) {
  const rows = [];
  Object.entries(trades || {}).forEach(([txid, t]) => {
    const parsed = parseKrakenPair(t.pair);
    if (!parsed) return;
    const side = String(t.type || "").toLowerCase();
    const vol = parseFloat(t.vol) || 0, cost = parseFloat(t.cost) || 0, fee = parseFloat(t.fee) || 0;
    if (!(vol > 0) || !(cost > 0) || (side !== "buy" && side !== "sell")) return;
    const quoteQty = side === "buy" ? cost + fee : Math.max(cost - fee, 0);
    rows.push({
      FILL_ID: txid, CLIENT_ORDER_ID: t.ordertxid || txid, ORDER_SIDE: side,
      EXECUTED_BASE_CURRENCY: parsed.base, EXECUTED_QUOTE_CURRENCY: parsed.quote,
      EXECUTED_BASE_QUANTITY: String(vol), EXECUTED_QUOTE_QUANTITY: String(quoteQty),
      FILL_DATETIME: new Date((Number(t.time) || 0) * 1000).toISOString(),
      SETTLEMENT_ID: t.ordertxid || txid,
    });
  });
  return rows;
}
// Kraken Ledgers result.ledger -> Deposit/Withdrawal rows. Trade and fee ledger
// lines are skipped (trades come from TradesHistory, so they'd double-count).
function krakenLedgersToRows(ledger) {
  const out = [];
  Object.entries(ledger || {}).forEach(([lid, e]) => {
    const type = String(e.type || "").toLowerCase();
    if (type !== "deposit" && type !== "withdrawal") return;
    const amt = Math.abs(parseFloat(e.amount) || 0);
    if (!(amt > 0)) return;
    out.push({
      Date: new Date((Number(e.time) || 0) * 1000).toISOString().slice(0, 10),
      Type: type === "deposit" ? "Deposit" : "Withdrawal",
      Coin: krakenAsset(e.asset), Quantity: String(amt), Price: "",
      TxHash: e.refid || lid, Counterparty: "Kraken",
    });
  });
  return out;
}
// Call a Kraken private endpoint through the proxy (POST { method, params }).
async function fetchKrakenProxy(proxyUrl, token, method, params) {
  let res;
  try {
    res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ method, params: params || {} }),
    });
  } catch (e) { throw new Error(`Couldn't reach the Kraken proxy (${e.message}).`); }
  if (!res.ok) throw new Error(`Kraken proxy returned HTTP ${res.status}.`);
  const j = await res.json();
  if (typeof j.error === "string" && j.error) throw new Error(j.error);
  if (Array.isArray(j.error) && j.error.length) throw new Error(j.error.join("; "));
  return j.result || {};
}
// Page through a Kraken history endpoint (offset-based) until all rows are in.
async function fetchKrakenAll(proxyUrl, token, method, key) {
  let ofs = 0, all = {}, guard = 0;
  while (guard++ < 60) {
    const result = await fetchKrakenProxy(proxyUrl, token, method, { ofs });
    const batch = result[key] || {};
    const n = Object.keys(batch).length;
    Object.assign(all, batch);
    ofs += n;
    if (n === 0 || ofs >= (Number(result.count) || 0)) break;
  }
  return all;
}

// ---------- live market rates (CoinGecko) ----------
//
// CoinMarketCap blocks all browser requests (no CORS, to keep its API key off
// the front end), so live rates come from CoinGecko's keyless public API, which
// is CORS-enabled and needs no key. Coins are matched to CoinGecko by a curated
// symbol->id map; a coin may also carry its own `coingeckoId` to override. Any
// coin we can't map or price is left untouched and reported back so its rate
// can stay manual.
const COINGECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", WETH: "ethereum", USDT: "tether", USDC: "usd-coin",
  BNB: "binancecoin", TRX: "tron", SOL: "solana", DOT: "polkadot", NEAR: "near",
  POL: "polygon-ecosystem-token", MATIC: "polygon-ecosystem-token", INJ: "injective-protocol",
  SUI: "sui", BCH: "bitcoin-cash", AVAX: "avalanche-2", ADA: "cardano", XRP: "ripple",
  LTC: "litecoin", LINK: "chainlink", ATOM: "cosmos", ARB: "arbitrum", OP: "optimism",
  APT: "aptos", DOGE: "dogecoin", SHIB: "shiba-inu", DAI: "dai", USD: "",
};
function coinGeckoIdFor(coin) {
  if (!coin || coin.isFiat) return "";
  return (coin.coingeckoId || COINGECKO_IDS[(coin.rateSymbol || coin.symbol || "").toUpperCase()] || "").trim();
}
// Pure: given coins and a { geckoId: usdPrice } map, produce the rate updates
// ({id, symbol, rate}) and the symbols that couldn't be matched/priced.
function applyGeckoPrices(coins, priceById) {
  const updates = [], skipped = [];
  coins.forEach((c) => {
    if (c.isFiat) return;
    const id = coinGeckoIdFor(c);
    const price = id ? priceById[id] : undefined;
    if (Number.isFinite(price) && price > 0) updates.push({ id: c.id, symbol: c.symbol, rate: price });
    else skipped.push(c.symbol);
  });
  return { updates, skipped };
}
// Live fetch (browser only): batches every mappable coin into one CoinGecko call.
async function fetchLiveCoinRates(coins, cgKey) {
  const cryptoCoins = coins.filter((c) => !c.isFiat);
  const priceById = {};
  // One batched CoinGecko call when a key is available (covers everything).
  if (cgKey) {
    const ids = [...new Set(cryptoCoins.map(coinGeckoIdFor).filter(Boolean))];
    if (ids.length) {
      try {
        const j = await cgFetch(`/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`, cgKey);
        Object.entries(j || {}).forEach(([id, v]) => { if (v && Number.isFinite(v.usd)) priceById[id] = v.usd; });
      } catch { /* fall through to the keyless Coinbase per-coin path */ }
    }
  }
  const updates = [], skipped = [];
  for (const c of cryptoCoins) {
    const id = coinGeckoIdFor(c);
    let price = id ? priceById[id] : undefined;
    if (!(price > 0)) price = await fetchCoinbaseCurrentPrice(c.symbol); // keyless fallback (major coins)
    if (price > 0) updates.push({ id: c.id, symbol: c.symbol, rate: price });
    else skipped.push(c.symbol);
  }
  return { updates, skipped };
}

// Block-explorer txlists give a native amount but no USD price, so gas-tank rows
// are priced from a market source: the historical daily price for each row's
// date (accurate for cost basis), current price as a fallback. Two sources:
//   1. CoinGecko - comprehensive (covers TRX etc.), but the keyless endpoint is
//      blocked for automated traffic, so it's only used when an API key is set.
//   2. Coinbase - keyless and reliable, but only lists major coins (AVAX, ETH,
//      POL, BTC... not TRX).
// Priority: CoinGecko (if key) -> Coinbase -> none.

// Coinbase spot product uses the plain ticker; a couple need remapping.
const COINBASE_SYMBOL = { WETH: "ETH", POL: "POL", MATIC: "POL" };
function coinbaseSym(symbol) { return COINBASE_SYMBOL[(symbol || "").toUpperCase()] || (symbol || "").toUpperCase(); }

async function cgFetch(path, key) {
  // Free "Demo" keys work on the public host via the x_cg_demo_api_key param
  // (a query param, not a header, to avoid a CORS preflight).
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.coingecko.com/api/v3${path}${key ? `${sep}x_cg_demo_api_key=${encodeURIComponent(key)}` : ""}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error("ratelimit");
  if (!res.ok) return null;
  return res.json();
}
async function fetchCoinGeckoCurrentPrice(symbol, key) {
  const id = COINGECKO_IDS[(symbol || "").toUpperCase()];
  if (!id || !key) return 0;
  try { const j = await cgFetch(`/simple/price?ids=${id}&vs_currencies=usd`, key); return Number(j?.[id]?.usd) || 0; }
  catch { return 0; }
}
async function fetchCoinGeckoHistoricalPrice(symbol, isoDate, key) {
  const id = COINGECKO_IDS[(symbol || "").toUpperCase()];
  if (!id || !key || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "")) return null;
  const [y, m, d] = isoDate.split("-");
  const j = await cgFetch(`/coins/${id}/history?date=${d}-${m}-${y}&localization=false`, key);
  const p = j?.market_data?.current_price?.usd;
  return Number.isFinite(p) ? p : null;
}
async function fetchCoinbaseCurrentPrice(symbol) {
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${coinbaseSym(symbol)}-USD/spot`);
    if (!res.ok) return 0;
    const j = await res.json();
    return Number(j?.data?.amount) || 0;
  } catch { return 0; }
}
async function fetchCoinbaseHistoricalPrice(symbol, isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "")) return null;
  try {
    const res = await fetch(`https://api.exchange.coinbase.com/products/${coinbaseSym(symbol)}-USD/candles?granularity=86400&start=${isoDate}T00:00:00Z&end=${isoDate}T23:59:59Z`);
    if (!res.ok) return null;
    const arr = await res.json();
    // [[time, low, high, open, close, volume], ...] - use the close.
    if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) { const c = Number(arr[0][4]); return Number.isFinite(c) ? c : null; }
    return null;
  } catch { return null; }
}
// Unified price getters: CoinGecko (with key) first, then Coinbase.
async function fetchGasCurrentPrice(symbol, cgKey) {
  const cg = await fetchCoinGeckoCurrentPrice(symbol, cgKey);
  if (cg > 0) return cg;
  return await fetchCoinbaseCurrentPrice(symbol);
}
async function fetchGasHistoricalPrice(symbol, isoDate, cgKey) {
  if (cgKey) { const cg = await fetchCoinGeckoHistoricalPrice(symbol, isoDate, cgKey); if (cg != null) return cg; }
  return await fetchCoinbaseHistoricalPrice(symbol, isoDate);
}
// Stamp a USD Price onto each row by its date (historical, cached across the run;
// current-price fallback). `cache` is keyed `${symbol}|${date}`. Returns the
// current price seen (so the caller can seed a new coin's market rate).
async function stampGasTankRowPrices(rows, symbol, cache, cgKey) {
  if (!symbol || !rows.length) return 0;
  const dates = [...new Set(rows.map((r) => r.Date).filter(Boolean))];
  let current = null, historyOff = false, lastPrice = 0;
  const getCurrent = async () => { if (current === null) current = await fetchGasCurrentPrice(symbol, cgKey); return current; };
  for (const date of dates) {
    const ck = `${symbol}|${date}`;
    if (cache[ck] === undefined) {
      let price = null;
      if (!historyOff) {
        try { price = await fetchGasHistoricalPrice(symbol, date, cgKey); }
        catch { historyOff = true; } // rate-limited: stop hitting history, use current for the rest
      }
      if (price == null) price = await getCurrent();
      cache[ck] = price || 0;
    }
    if (cache[ck] > 0) lastPrice = cache[ck];
  }
  rows.forEach((r) => { const p = cache[`${symbol}|${r.Date}`]; if (p > 0) r.Price = String(p); });
  return (current && current > 0) ? current : lastPrice;
}

// Distinct wallet labels this CSV mentions that don't already resolve - not
// an exact match against this app's own Wallets, and not already covered by
// a saved walletLabelRule. Surfaced by the importer as a one-time "map this
// wallet" prompt so a source's own naming (which essentially never matches
// this app's Wallet names verbatim) only has to be taught once per label.
function findUnresolvedWalletLabels(text, wallets, walletLabelRules = []) {
  if (!text.trim()) return [];
  let parsed;
  try {
    parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  } catch {
    return [];
  }
  const seen = new Set();
  const unresolved = [];
  parsed.data.forEach((row) => {
    const label = rawSourceWalletLabel(row);
    if (!label || seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    const byName = wallets.some((w) => w.name.toLowerCase() === label.toLowerCase());
    const byRule = walletLabelRules.some((r) => r.label.toLowerCase() === label.toLowerCase());
    if (!byName && !byRule) unresolved.push(label);
  });
  return unresolved.sort();
}

// True if the pasted file has any row that won't route to a wallet on its own -
// i.e. rows that will actually fall back to the manually selected "Import into
// wallet". A row routes if resolveSourceWallet finds it (exact name / saved
// rule / address) or if the user has mapped its label in the in-progress
// labelMap. A row with no wallet label at all (a single-wallet export) always
// needs the fallback. When this is false, every row auto-routes and the
// fallback selector is dead weight, so the UI hides it.
function importNeedsFallbackWallet(text, wallets, walletLabelRules = [], labelMap = {}) {
  if (!text.trim()) return false;
  let parsed;
  try {
    parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  } catch {
    return false;
  }
  return parsed.data.some((row) => {
    if (resolveSourceWallet(row, wallets, walletLabelRules)) return false;
    const label = rawSourceWalletLabel(row);
    if (label && labelMap[label]) return false; // mapped in the prompt (a "skip"/"" doesn't count)
    return true;
  });
}

function useJournal(transactions) {
  return useMemo(() => {
    const lines = [];
    transactions.filter((t) => t.posted).forEach((t) => {
      journalLinesFor(t).forEach((l, i) =>
        lines.push({ id: `${t.id}_${i}`, entryId: t.id, transactionId: t.id, date: t.date, description: t.description, ...l })
      );
    });
    return lines;
  }, [transactions]);
}

function balanceFor(accountId, journal, accounts) {
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return 0;
  const debit = journal.filter((j) => j.accountId === accountId).reduce((s, j) => s + j.debit, 0);
  const credit = journal.filter((j) => j.accountId === accountId).reduce((s, j) => s + j.credit, 0);
  return NORMAL_BALANCE[acc.type] === "debit" ? debit - credit : credit - debit;
}

// Diagnostic for "why is the trial balance out of balance?" - a correct
// journal is just a pile of individually-balanced entries, so a total
// imbalance means some entry's own debits and credits don't net to zero.
// Groups every journal line by the source entry that produced it (entryId)
// and returns the ones whose debits and credits differ by more than a cent,
// worst first, so the culprit is named rather than guessed at.
function findUnbalancedEntries(journal) {
  const groups = new Map();
  journal.forEach((j) => {
    const k = j.entryId || j.id;
    const g = groups.get(k) || { key: k, date: j.date, description: j.description, debit: 0, credit: 0 };
    g.debit += j.debit;
    g.credit += j.credit;
    groups.set(k, g);
  });
  const bad = [];
  groups.forEach((g) => {
    const delta = g.debit - g.credit;
    if (Math.abs(delta) > 0.005) bad.push({ ...g, delta });
  });
  bad.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return bad;
}

// ---------- raw exchange/wallet CSV auto-match ----------
// A CSV pulled straight off Bitgo, Binance, OKX, Kraken, etc. never carries
// our internal eventType codes (e.g. "A1-stable") - it only has whatever
// that source calls its own columns (its own "type" vocabulary, an asset,
// an amount, maybe a counterparty address). The approach below mirrors what
// crypto-accounting platforms (Bitwave, Cryptio, Gilded, Lukka) actually do
// under the hood, adapted to this app's existing pieces:
//
//   1. Translate the source's native type string into a small shared
//      vocabulary (deposit/withdrawal/transfer/trade-buy/trade-sell/fee/
//      reward) via a per-venue alias table - every connector speaks
//      differently, but "what kind of thing is this" only has a handful of
//      real answers.
//   2. Classify the asset (stablecoin / crypto / fiat) from the Coins list -
//      a free signal, already in the app, that several templates split on
//      (A1-stable vs A1-crypto).
//   3. Resolve the counterparty - the highest-leverage signal. Anything on
//      the other side of the transaction that matches one of *our own*
//      Wallets (by address, or by name/venue if the export just labels its
//      own accounts rather than giving raw addresses) is "self:<wallet
//      name>" - internal movement. Anything that doesn't match is
//      "external:<whatever the row said>" - a real client/vendor/unknown
//      party, which should never be auto-guessed.
//   4. Combine venue + kind + asset class + counterparty into one
//      deterministic signature string and use it as the event's own
//      eventType. This is the trick that means no new matching engine is
//      needed at all: it's still just an eventType, so the *existing*
//      Transaction Types registry, Needs Mapping queue, and TemplateBuilder
//      handle it unchanged. The first CSV row with a brand new signature
//      lands in Needs Mapping same as any other unrecognized event, with
//      every one of these derived fields visible for context. The moment a
//      human maps that signature to a template once, it's a normal active
//      template - every future row with the identical signature auto-posts,
//      with zero extra "rules" table to build or maintain. Teach once,
//      apply forever - and if a signature was mapped wrong, the same
//      balance-check every other template goes through still catches it.
const RAW_TYPE_ALIASES = {
  deposit: ["deposit", "receive", "received", "funding", "credit", "fund"],
  withdrawal: ["withdrawal", "withdraw", "send", "sent", "debit"],
  transfer: ["transfer", "internal transfer", "move", "sweep", "rebalance"],
  "trade-buy": ["buy", "trade buy", "convert buy", "purchase"],
  "trade-sell": ["sell", "trade sell", "convert sell"],
  fee: ["fee", "network fee", "gas fee", "commission", "gas"],
  reward: ["reward", "staking reward", "interest", "yield", "earn", "distribution"],
};
function normalizeNativeType(raw) {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  for (const [kind, aliases] of Object.entries(RAW_TYPE_ALIASES)) {
    if (aliases.some((a) => s === a || s.includes(a))) return kind;
  }
  return s.replace(/\s+/g, "-");
}

// Tries, in order: exact address match against a Wallet's own address,
// exact name match, then a loose "one contains the other" match (covers a
// source that labels its own sub-accounts by name rather than address).
// Anything left over is external - and stays external rather than guessed.
function resolveCounterparty(label, wallets) {
  const raw = (label || "").trim();
  if (!raw) return "external:unspecified";
  const lower = raw.toLowerCase();
  const byAddress = wallets.find((w) => w.address && w.address.trim().toLowerCase() === lower);
  if (byAddress) return `self:${byAddress.name}`;
  const byName = wallets.find((w) => w.name.toLowerCase() === lower);
  if (byName) return `self:${byName.name}`;
  const byContains = wallets.find(
    (w) => w.name.length > 3 && (lower.includes(w.name.toLowerCase()) || w.name.toLowerCase().includes(lower))
  );
  if (byContains) return `self:${byContains.name}`;
  return `external:${raw}`;
}

// ---------- transaction-type template engine ----------
// A "template" is how one *kind* of structured event (not a free-text bank line)
// turns into a balanced journal entry, defined once by a human and then automatic.

function matchesRule(tx, rule) {
  if (!rule) return false;
  if (rule.all) return rule.all.every((r) => matchesRule(tx, r));
  if (rule.any) return rule.any.some((r) => matchesRule(tx, r));
  return tx[rule.field] === rule.equals;
}

function findTemplate(tx, registry) {
  return registry.find((t) => t.status === "active" && matchesRule(tx, t.matchRule)) || null;
}

// Lets a leg's account be written as e.g. "Client Custody Payable - {venue}",
// resolved against the event's own fields - one template can then serve every venue.
function resolveAccountRef(ref, tx) {
  return ref.replace(/\{(\w+)\}/g, (_, key) => (tx[key] !== undefined ? tx[key] : `{${key}}`));
}

// A leg's amount comes from one of two modes:
//  - "pct" (the default): a percentage of one of the event's numeric fields.
//    pct defaults to 100, so a plain 1:1 field mapping is just the pct=100
//    special case - this is what lets one field (e.g. a downpayment total)
//    fund several legs in different proportions instead of requiring a
//    separate pre-computed field per leg.
//  - "fixed": a flat dollar amount typed straight into the mapping, with no
//    dependency on any event field at all. This is what unblocks an event
//    type that has no numeric field to reference - e.g. a downpayment that's
//    always the same amount can be mapped without needing the event itself
//    to carry that number.
// `baseField` is the current name for the pct mode's field reference;
// `amountField` is read as a fallback so templates saved before this existed
// keep working unchanged (they're implicitly mode="pct", pct=100).
function legBaseField(leg) { return leg.baseField ?? leg.amountField; }
function legPct(leg) { return Number.isFinite(leg.pct) ? leg.pct : 100; }
function legMode(leg) { return leg.mode === "fixed" ? "fixed" : "pct"; }

function buildLegs(template, tx, accounts) {
  return template.legs.map((leg) => {
    const resolvedName = resolveAccountRef(leg.accountRef, tx);
    const account = accounts.find((a) => a.name === resolvedName);
    const mode = legMode(leg);
    let amount, baseField = null, pct = null;
    if (mode === "fixed") {
      amount = Number.isFinite(leg.fixedAmount) ? leg.fixedAmount : NaN;
    } else {
      baseField = legBaseField(leg);
      pct = legPct(leg);
      const base = tx[baseField];
      amount = typeof base === "number" ? base * (pct / 100) : NaN;
    }
    return {
      side: leg.side,
      accountRef: leg.accountRef,
      resolvedName,
      accountId: account?.id,
      mode,
      baseField,
      pct,
      fixedAmount: leg.fixedAmount,
      amount,
    };
  });
}

function balanceCheck(legs) {
  const debit = legs.filter((l) => l.side === "debit").reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0);
  const credit = legs.filter((l) => l.side === "credit").reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0);
  return { debit, credit, balanced: legs.length > 0 && Math.abs(debit - credit) < 0.005 };
}

function legsResolved(legs) {
  return legs.every((l) => l.accountId && Number.isFinite(l.amount));
}

// Tries to post one event against the current registry. Returns the event
// with a status of posted / unmapped (never seen this type) / error (matched
// but a leg's account is missing or the amounts don't balance).
function tryPostEvent(ev, registry, accounts) {
  const template = findTemplate(ev, registry);
  if (!template) return { ...ev, status: "unmapped", reason: null, templateId: null, legs: null };

  const legs = buildLegs(template, ev, accounts);
  if (!legsResolved(legs)) {
    const bad = legs.find((l) => !l.accountId);
    const reason = bad
      ? `No account named "${bad.resolvedName}" - add it in Chart of Accounts, then fix the mapping.`
      : "A leg's amount field is missing on this event.";
    return { ...ev, status: "error", reason, templateId: template.id, legs };
  }
  const check = balanceCheck(legs);
  if (!check.balanced) {
    return {
      ...ev, status: "error", templateId: template.id, legs,
      reason: `Doesn't balance: debit ${money(check.debit)} vs credit ${money(check.credit)}.`,
    };
  }
  return { ...ev, status: "posted", reason: null, templateId: template.id, legs };
}

// Suggested starting point for a new template, keyed by event type - the human
// still has to review and hit Activate, this just saves re-typing the obvious part.
// These two examples map to accounts that already exist in the real COA:
// referral payouts route through Client custody payable (per the documented
// design - no intermediate payable), and gas fees have two variants depending
// on which wallet fronts them, so the credit side is deliberately left blank
// for the human to pick rather than guessed.
const SUGGESTIONS = {
  REFERRAL_PAID: {
    label: "Referral Payout",
    matchFields: ["eventType"],
    legs: [
      { accountRef: "Marketing expenses", side: "debit", amountField: "amount" },
      { accountRef: "Client custody payable", side: "credit", amountField: "amount" },
    ],
  },
  GAS_FEE_PAID: {
    label: "Gas Fee",
    matchFields: ["eventType", "method"],
    legs: [
      { accountRef: "Gas fee", side: "debit", amountField: "amount" },
      { accountRef: "", side: "credit", amountField: "amount" },
    ],
  },
  // Client sells crypto through an execution venue (e.g. OKX): the crypto
  // moves out of the client's custody sub-wallet into the company's pooled
  // wallet for execution, and Client Custody Payable is relieved. Verified
  // against a real 5-leg example (a $50,000 sell at a 0.5% convert fee ->
  // $250 fee revenue) - the 99.5%/0.5% split is that venue's actual rate, so
  // treat it as a starting point per venue and adjust the percentages to
  // match the fee that venue actually charges.
  //
  // NOTE: the original example's 5th leg credited "Client synthetic position
  // payable" for the net-of-fee amount - that account isn't in the current
  // Chart of Accounts, so this leg is deliberately left blank rather than
  // guessed. Pick the right liability account for "what we now owe the
  // client after the sale" before activating any mapping built from this.
  CRYPTO_SELL: {
    label: "Crypto Sell (via venue)",
    matchFields: ["eventType", "venue"],
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "", side: "credit", mode: "pct", baseField: "amount", pct: 99.5 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "amount", pct: 0.5 },
    ],
  },
};

// Seeded from Money Buddy's transaction-types reference sheet - one
// balanced journal entry per documented event type ID (Settlement A-series,
// Earn B-series, Referral F, P2P G, Gas fee H6, Crypto Buy/Sell C-series,
// BNPL D-series). Every leg pulls its amount from a named field on the
// incoming real event (mode: "pct", pct: 100 - i.e. a plain 1:1 field
// mapping), matched purely on eventType == the sheet's ID (e.g.
// "A1-stable"). Field names are inferred from the sheet's worked example:
// the largest amount in each entry is "amount", smaller ones are named by
// role (feeAmount, interestAmount, principalAmount, pnlAmount, etc.) -
// rename/repoint any of them once the upstream event's real field names
// are known. All 98 verified to balance when fed the sheet's own numbers.
// The 8 futures-close templates (C3a/C3b *-gain/-loss for OKX/Binance/
// Kraken) use a "pnlAmount" field since the sheet marks that leg "X" -
// whatever the position gained/lost, not a fixed figure.
const DEFAULT_REGISTRY = [
  {
    id: "tpl_A1_stable", code: "A1-stable", label: "Client crypto deposit (stablecoin)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A1-stable" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A1_crypto", code: "A1-crypto", label: "Client crypto deposit (non-stablecoin)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A1-crypto" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A2_stable", code: "A2-stable", label: "Client crypto withdrawal (stablecoin)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A2-stable" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - withdraw fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_A2_crypto", code: "A2-crypto", label: "Client crypto withdrawal (non-stablecoin)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A2-crypto" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - withdraw fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_A3", code: "A3", label: "Wallet-to-wallet internal transfer", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A3" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A4_stable", code: "A4-stable", label: "Sweep hot to cold (client stablecoin)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A4-stable" }] },
    legs: [
      { accountRef: "Bitgo cold wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A4_crypto", code: "A4-crypto", label: "Sweep hot to cold (client non-stablecoin)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A4-crypto" }] },
    legs: [
      { accountRef: "Bitgo cold wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A5_okx", code: "A5-okx", label: "Transfer USDT from Bitgo to OKX spot", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A5-okx" }] },
    legs: [
      { accountRef: "OKX spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A5_bin", code: "A5-bin", label: "Transfer USDT from Bitgo to Binance spot", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A5-bin" }] },
    legs: [
      { accountRef: "Binance spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A5_kraken", code: "A5-kraken", label: "Transfer USDT from Bitgo to Kraken spot", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A5-kraken" }] },
    legs: [
      { accountRef: "Kraken spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A5_kinesis_usdt", code: "A5-kinesis-usdt", label: "Transfer USDT from Bitgo to Kinesis", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A5-kinesis-usdt" }] },
    legs: [
      { accountRef: "Kinesis spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A5_kinesis_kau", code: "A5-kinesis-kau", label: "Transfer KAU from Bitgo to Kinesis", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A5-kinesis-kau" }] },
    legs: [
      { accountRef: "Kinesis spot - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A6_okx", code: "A6-okx", label: "Fund OKX margin from OKX spot", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A6-okx" }] },
    legs: [
      { accountRef: "OKX margin - Company", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A6_bin", code: "A6-bin", label: "Fund Binance margin from Binance spot", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A6-bin" }] },
    legs: [
      { accountRef: "Binance margin - Company", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Binance spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A6_kraken", code: "A6-kraken", label: "Fund Kraken margin from Kraken spot", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A6-kraken" }] },
    legs: [
      { accountRef: "Kraken margin - Company", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Kraken spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_okx_usdt_to_crypto", code: "A7-okx-usdt-to-crypto", label: "OKX spot buy \u2014 USDT to crypto (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-okx-usdt-to-crypto" }] },
    legs: [
      { accountRef: "OKX spot - Company #Crypto", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "OKX spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_okx_crypto_to_usdt", code: "A7-okx-crypto-to-usdt", label: "OKX spot sell \u2014 crypto to USDT (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-okx-crypto-to-usdt" }] },
    legs: [
      { accountRef: "OKX spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "OKX spot - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_bin_usdt_to_crypto", code: "A7-bin-usdt-to-crypto", label: "Binance spot buy \u2014 USDT to crypto (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-bin-usdt-to-crypto" }] },
    legs: [
      { accountRef: "Binance spot - Company #Crypto", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_bin_crypto_to_usdt", code: "A7-bin-crypto-to-usdt", label: "Binance spot sell \u2014 crypto to USDT (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-bin-crypto-to-usdt" }] },
    legs: [
      { accountRef: "Binance spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance spot - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_kraken_usdt_to_stock", code: "A7-kraken-usdt-to-stock", label: "Kraken spot buy \u2014 USDT to stock (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-kraken-usdt-to-stock" }] },
    legs: [
      { accountRef: "Kraken spot - Company #Crypto", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_kraken_stock_to_usdt", code: "A7-kraken-stock-to-usdt", label: "Kraken spot sell \u2014 stock to USDT (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-kraken-stock-to-usdt" }] },
    legs: [
      { accountRef: "Kraken spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken spot - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_kinesis_usdt_to_kau", code: "A7-kinesis-usdt-to-kau", label: "Kinesis spot buy \u2014 USDT to KAU (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-kinesis-usdt-to-kau" }] },
    legs: [
      { accountRef: "Kinesis spot - Company #Crypto", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kinesis spot - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A7_kinesis_kau_to_usdt", code: "A7-kinesis-kau-to-usdt", label: "Kinesis spot sell \u2014 KAU to USDT (inventory rebalance)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A7-kinesis-kau-to-usdt" }] },
    legs: [
      { accountRef: "Kinesis spot - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Realized loss on asset held", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kinesis spot - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_A8", code: "A8", label: "Monthly fee collection sweep", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "A8" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_B1", code: "B1", label: "Allocate to Earn (client lock)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B1" }] },
    legs: [
      { accountRef: "Bitgo earn wallet - for Client", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_H6", code: "H6", label: "Gas fee paid from company wallet", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "H6" }] },
    legs: [
      { accountRef: "Gas fee", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo gas wallet - Company", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_B1b", code: "B1b", label: "Deploy from Earn to DeFi", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B1b" }] },
    legs: [
      { accountRef: "Defi pool - for Client", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo earn wallet - for Client", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_B2a", code: "B2a", label: "Daily protocol yield accrual (positive spread)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B2a" }] },
    legs: [
      { accountRef: "Client Earn yield accrued", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Revenue - Earn yield spread", side: "credit", mode: "pct", baseField: "amount3", pct: 100 }
    ],
  },
  {
    id: "tpl_B2a_neg", code: "B2a-neg", label: "Daily protocol yield accrual (negative spread)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B2a-neg" }] },
    legs: [
      { accountRef: "Client Earn yield accrued", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Revenue - Earn yield spread", side: "debit", mode: "pct", baseField: "amount3", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_B2b", code: "B2b", label: "Yield distribution from protocol (client still active)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B2b" }] },
    legs: [
      { accountRef: "Defi pool - for Client", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client Earn yield accrued", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_B2b_Y", code: "B2b-Y", label: "Yield distribution from protocol (Policy Y recovery)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B2b-Y" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client Earn yield accrued", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_B3", code: "B3", label: "Withdraw from Earn to Spendable (Policy Y)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B3" }] },
    legs: [
      { accountRef: "Bitgo earn wallet - for Client", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Defi pool - for Client", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo earn wallet - for Client", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount2", pct: 100 }
    ],
  },
  {
    id: "tpl_B4", code: "B4", label: "Extract yield spread revenue", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "B4" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Defi pool - for Client", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_F1", code: "F1", label: "Referral bonus (USDT paid to client)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "F1" }] },
    legs: [
      { accountRef: "Marketing expenses", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_G1", code: "G1", label: "P2P order \u2014 merchant crypto to escrow", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "G1" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "P2P escrow payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_G2", code: "G2", label: "P2P trade complete - release to customer", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "G2" }] },
    legs: [
      { accountRef: "P2P escrow payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - P2P merchant markup fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_G3", code: "G3", label: "P2P trade cancelled \u2014 return to merchant", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "G3" }] },
    legs: [
      { accountRef: "P2P escrow payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_H6_1", code: "H6-1", label: "Gas fee paid from company hot wallet", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "H6-1" }] },
    legs: [
      { accountRef: "Gas fee", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_H6_2a", code: "H6-2a", label: "Prepay gas from hot to gas wallet", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "H6-2a" }] },
    legs: [
      { accountRef: "Bitgo gas wallet - Company", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_H6_2b", code: "H6-2b", label: "Gas fee paid from company gas wallet", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "H6-2b" }] },
    legs: [
      { accountRef: "Gas fee", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo gas wallet - Company", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_buy_okx", code: "C1-buy-okx", label: "Client buy order (BTC via OKX) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-buy-okx" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_buy_okx_down", code: "C2a-buy-okx-down", label: "MTM Client custody payable [BTC] (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-buy-okx-down" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on asset held (P/L)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_buy_okx_down", code: "C2b-buy-okx-down", label: "MTM OKX long futures (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-buy-okx-down" }] },
    legs: [
      { accountRef: "Unrealised loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX - Futures position MTM (liability side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_buy_okx_up", code: "C2a-buy-okx-up", label: "MTM Client custody payable [BTC] (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-buy-okx-up" }] },
    legs: [
      { accountRef: "Unrealised loss on asset held (P/L)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_buy_okx_up", code: "C2b-buy-okx-up", label: "MTM OKX long futures (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-buy-okx-up" }] },
    legs: [
      { accountRef: "OKX - Futures position MTM (asset side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3a_close_okx_long_gain", code: "C3a-close-okx-long-gain", label: "Close OKX long futures \u2014 realise gain", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3a-close-okx-long-gain" }] },
    legs: [
      { accountRef: "Unrealised gain on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Realized gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX margin - Company", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX - Futures position MTM (asset side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3a_close_okx_long_loss", code: "C3a-close-okx-long-loss", label: "Close OKX long futures \u2014 realise loss", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3a-close-okx-long-loss" }] },
    legs: [
      { accountRef: "Realized loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised loss on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX - Futures position MTM (liability side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX margin - Company", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_sell_okx", code: "C1-sell-okx", label: "Client sell order (BTC via OKX) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-sell-okx" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_sell_okx_down", code: "C2a-sell-okx-down", label: "MTM BTC inventory (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-sell-okx-down" }] },
    legs: [
      { accountRef: "Unrealised loss on asset held (P/L)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_sell_okx_down", code: "C2b-sell-okx-down", label: "MTM OKX short futures (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-sell-okx-down" }] },
    legs: [
      { accountRef: "OKX - Futures position MTM (asset side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_sell_okx_up", code: "C2a-sell-okx-up", label: "MTM BTC inventory (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-sell-okx-up" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on asset held (P/L)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_sell_okx_up", code: "C2b-sell-okx-up", label: "MTM OKX short futures (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-sell-okx-up" }] },
    legs: [
      { accountRef: "Unrealised loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX - Futures position MTM (liability side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3b_close_okx_short_gain", code: "C3b-close-okx-short-gain", label: "Close OKX short futures \u2014 realise gain", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3b-close-okx-short-gain" }] },
    legs: [
      { accountRef: "Unrealised gain on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Realized gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX margin - Company", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX - Futures position MTM (asset side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3b_close_okx_short_loss", code: "C3b-close-okx-short-loss", label: "Close OKX short futures \u2014 realise loss", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3b-close-okx-short-loss" }] },
    legs: [
      { accountRef: "Realized loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised loss on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX - Futures position MTM (liability side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "OKX margin - Company", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_buy_bin", code: "C1-buy-bin", label: "Client buy order (BTC via Binance) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-buy-bin" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_buy_bin_down", code: "C2a-buy-bin-down", label: "MTM Client custody payable [BTC] (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-buy-bin-down" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on asset held (P/L)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_buy_bin_down", code: "C2b-buy-bin-down", label: "MTM Binance long futures (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-buy-bin-down" }] },
    legs: [
      { accountRef: "Unrealised loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Binance - Futures position MTM (liability side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_buy_bin_up", code: "C2a-buy-bin-up", label: "MTM Client custody payable [BTC] (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-buy-bin-up" }] },
    legs: [
      { accountRef: "Unrealised loss on asset held (P/L)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_buy_bin_up", code: "C2b-buy-bin-up", label: "MTM Binance long futures (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-buy-bin-up" }] },
    legs: [
      { accountRef: "Binance - Futures position MTM (asset side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3a_close_bin_long_gain", code: "C3a-close-bin-long-gain", label: "Close Binance long futures \u2014 realise gain", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3a-close-bin-long-gain" }] },
    legs: [
      { accountRef: "Unrealised gain on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Realized gain on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance margin - Company", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance - Futures position MTM (asset side)", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3a_close_bin_long_loss", code: "C3a-close-bin-long-loss", label: "Close Binance long futures \u2014 realise loss", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3a-close-bin-long-loss" }] },
    legs: [
      { accountRef: "Realized loss on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Unrealised loss on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance - Futures position MTM (liability side)", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance margin - Company", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_sell_bin", code: "C1-sell-bin", label: "Client sell order (BTC via Binance) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-sell-bin" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_sell_bin_down", code: "C2a-sell-bin-down", label: "MTM BTC inventory (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-sell-bin-down" }] },
    legs: [
      { accountRef: "Unrealised loss on asset held (P/L)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_sell_bin_down", code: "C2b-sell-bin-down", label: "MTM Binance short futures (BTC drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-sell-bin-down" }] },
    legs: [
      { accountRef: "Binance - Futures position MTM (asset side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_sell_bin_up", code: "C2a-sell-bin-up", label: "MTM BTC inventory (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-sell-bin-up" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on asset held (P/L)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_sell_bin_up", code: "C2b-sell-bin-up", label: "MTM Binance short futures (BTC rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-sell-bin-up" }] },
    legs: [
      { accountRef: "Unrealised loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Binance - Futures position MTM (liability side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3b_close_bin_short_gain", code: "C3b-close-bin-short-gain", label: "Close Binance short futures \u2014 realise gain", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3b-close-bin-short-gain" }] },
    legs: [
      { accountRef: "Unrealised gain on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Realized gain on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance margin - Company", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance - Futures position MTM (asset side)", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3b_close_bin_short_loss", code: "C3b-close-bin-short-loss", label: "Close Binance short futures \u2014 realise loss", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3b-close-bin-short-loss" }] },
    legs: [
      { accountRef: "Realized loss on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Unrealised loss on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance - Futures position MTM (liability side)", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Binance margin - Company", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_buy_kraken", code: "C1-buy-kraken", label: "Client buy order (stock via Kraken) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-buy-kraken" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_buy_kraken_down", code: "C2a-buy-kraken-down", label: "MTM Client custody payable [stock] (stock drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-buy-kraken-down" }] },
    legs: [
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on asset held (P/L)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_buy_kraken_down", code: "C2b-buy-kraken-down", label: "MTM Kraken long futures (stock drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-buy-kraken-down" }] },
    legs: [
      { accountRef: "Unrealised loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Kraken - Futures position MTM (liability side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_buy_kraken_up", code: "C2a-buy-kraken-up", label: "MTM Client custody payable [stock] (stock rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-buy-kraken-up" }] },
    legs: [
      { accountRef: "Unrealised loss on asset held (P/L)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_buy_kraken_up", code: "C2b-buy-kraken-up", label: "MTM Kraken long futures (stock rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-buy-kraken-up" }] },
    legs: [
      { accountRef: "Kraken - Futures position MTM (asset side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3a_close_kraken_long_gain", code: "C3a-close-kraken-long-gain", label: "Close Kraken long futures \u2014 realise gain", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3a-close-kraken-long-gain" }] },
    legs: [
      { accountRef: "Unrealised gain on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Realized gain on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken margin - Company", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken - Futures position MTM (asset side)", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3a_close_kraken_long_loss", code: "C3a-close-kraken-long-loss", label: "Close Kraken long futures \u2014 realise loss", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3a-close-kraken-long-loss" }] },
    legs: [
      { accountRef: "Realized loss on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Unrealised loss on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken - Futures position MTM (liability side)", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken margin - Company", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_sell_kraken", code: "C1-sell-kraken", label: "Client sell order (stock via Kraken) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-sell-kraken" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_sell_kraken_down", code: "C2a-sell-kraken-down", label: "MTM stock inventory (stock drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-sell-kraken-down" }] },
    legs: [
      { accountRef: "Unrealised loss on asset held (P/L)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_sell_kraken_down", code: "C2b-sell-kraken-down", label: "MTM Kraken short futures (stock drops)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-sell-kraken-down" }] },
    legs: [
      { accountRef: "Kraken - Futures position MTM (asset side)", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on derivatives", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2a_sell_kraken_up", code: "C2a-sell-kraken-up", label: "MTM stock inventory (stock rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2a-sell-kraken-up" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Unrealised gain on asset held (P/L)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C2b_sell_kraken_up", code: "C2b-sell-kraken-up", label: "MTM Kraken short futures (stock rises)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C2b-sell-kraken-up" }] },
    legs: [
      { accountRef: "Unrealised loss on derivatives", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Kraken - Futures position MTM (liability side)", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3b_close_kraken_short_gain", code: "C3b-close-kraken-short-gain", label: "Close Kraken short futures \u2014 realise gain", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3b-close-kraken-short-gain" }] },
    legs: [
      { accountRef: "Unrealised gain on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Realized gain on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken margin - Company", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken - Futures position MTM (asset side)", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C3b_close_kraken_short_loss", code: "C3b-close-kraken-short-loss", label: "Close Kraken short futures \u2014 realise loss", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C3b-close-kraken-short-loss" }] },
    legs: [
      { accountRef: "Realized loss on derivatives", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Unrealised loss on derivatives", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken - Futures position MTM (liability side)", side: "debit", mode: "pct", baseField: "pnlAmount", pct: 100 },
      { accountRef: "Kraken margin - Company", side: "credit", mode: "pct", baseField: "pnlAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_buy_kinesis", code: "C1-buy-kinesis", label: "Client gold buy (immediate delivery) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-buy-kinesis" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_C1_sell_kinesis", code: "C1-sell-kinesis", label: "Client gold sell (immediate delivery) \u2014 asset side", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "C1-sell-kinesis" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "feeAmount", pct: 100 },
      { accountRef: "Revenue - convert fee", side: "credit", mode: "pct", baseField: "feeAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_D1", code: "D1", label: "Client BNPL down payment received", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D1" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D2a", code: "D2a", label: "BNPL asset purchased & locked in escrow", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D2a" }] },
    legs: [
      { accountRef: "BNPL Collateral Escrow", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount2", pct: 100 },
      { accountRef: "Customer Collateral Payable - prepaid", side: "credit", mode: "pct", baseField: "prepaidAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_D2b", code: "D2b", label: "BNPL loan recognition", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D2b" }] },
    legs: [
      { accountRef: "BNPL principal receivable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Customer Collateral Payable - financed", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D3", code: "D3", label: "BNPL daily interest accrual", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D3" }] },
    legs: [
      { accountRef: "Accrued interests receivable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Interest income", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D4", code: "D4", label: "Client BNPL installment payment", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D4" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Client custody payable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Accrued interests receivable", side: "credit", mode: "pct", baseField: "interestAmount", pct: 100 },
      { accountRef: "BNPL principal receivable", side: "credit", mode: "pct", baseField: "principalAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_D5", code: "D5", label: "BNPL final repayment - asset released", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D5" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - for Client #Crypto", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "BNPL Collateral Escrow", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Customer Collateral Payable - prepaid", side: "debit", mode: "pct", baseField: "prepaidAmount", pct: 100 },
      { accountRef: "Customer Collateral Payable - financed", side: "debit", mode: "pct", baseField: "financedAmount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D6a", code: "D6a", label: "Early termination - sell collateral", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D6a" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "BNPL Collateral Escrow", side: "credit", mode: "pct", baseField: "escrowAmount", pct: 100 },
      { accountRef: "Customer Collateral Payable - prepaid", side: "credit", mode: "pct", baseField: "prepaidAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_D6b", code: "D6b", label: "Early termination - settle loan & refund", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D6b" }] },
    legs: [
      { accountRef: "Customer Collateral Payable - prepaid", side: "debit", mode: "pct", baseField: "prepaidAmount", pct: 100 },
      { accountRef: "Customer Collateral Payable - financed", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Accrued interests receivable", side: "credit", mode: "pct", baseField: "interestAmount", pct: 100 },
      { accountRef: "BNPL principal receivable", side: "credit", mode: "pct", baseField: "principalAmount", pct: 100 },
      { accountRef: "Client custody payable", side: "credit", mode: "pct", baseField: "amount2", pct: 100 }
    ],
  },
  {
    id: "tpl_D6c", code: "D6c", label: "Early termination - deliver residual to client wallet", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D6c" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - for Client #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D6_fee", code: "D6-fee", label: "Early termination fee accrual", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D6-fee" }] },
    legs: [
      { accountRef: "Client fee receivable", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Revenue - BNPL early termination fee", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D7a", code: "D7a", label: "Forced liquidation - MTM collateral before sale (loss)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D7a" }] },
    legs: [
      { accountRef: "Customer Collateral Payable - prepaid", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "BNPL Collateral Escrow", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D7b", code: "D7b", label: "Forced liquidation - sell collateral", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D7b" }] },
    legs: [
      { accountRef: "Liquidation settlement clearing", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "BNPL Collateral Escrow", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
  {
    id: "tpl_D7c", code: "D7c", label: "Forced liquidation - waterfall unwind (partial recovery)", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D7c" }] },
    legs: [
      { accountRef: "Customer Collateral Payable - financed", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Loss on liquidation shortfall", side: "debit", mode: "pct", baseField: "interestAmount", pct: 100 },
      { accountRef: "BNPL principal receivable", side: "credit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Accrued interests receivable", side: "credit", mode: "pct", baseField: "interestAmount", pct: 100 }
    ],
  },
  {
    id: "tpl_D7d", code: "D7d", label: "Forced liquidation - distribute clearing proceeds", status: "active",
    matchRule: { all: [{ field: "eventType", equals: "D7d" }] },
    legs: [
      { accountRef: "Bitgo hot wallet - Company #Stablecoin", side: "debit", mode: "pct", baseField: "amount", pct: 100 },
      { accountRef: "Liquidation settlement clearing", side: "credit", mode: "pct", baseField: "amount", pct: 100 }
    ],
  },
];
const todayStr = () => new Date().toISOString().slice(0, 10);
const rand = (min, max) => +(Math.random() * (max - min) + min).toFixed(2);

// A date field that shows and accepts dd/mm/yyyy (not the browser's locale
// default), while storing the value internally as yyyy-mm-dd. It keeps a native
// date picker alongside the text box so you can either type dd/mm/yyyy or pick
// from the calendar - typing no longer gets misread as US mm/dd/yyyy.
function isoToDMY(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function DateField({ value, onChange, className = "", min, ...rest }) {
  const [text, setText] = useState(isoToDMY(value));
  useEffect(() => { setText(isoToDMY(value)); }, [value]);
  const commit = (str) => {
    const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const d = m[1].padStart(2, "0"), mo = m[2].padStart(2, "0"), y = m[3];
      if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
        const iso = `${y}-${mo}-${d}`;
        onChange(iso); setText(`${d}/${mo}/${y}`); return;
      }
    }
    setText(isoToDMY(value)); // invalid - revert to the stored date
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input type="text" inputMode="numeric" placeholder="dd/mm/yyyy" value={text}
        onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.target.value); } }}
        className={className} {...rest} />
      <input type="date" value={value || ""} min={min} onChange={(e) => onChange(e.target.value)}
        title="Pick from calendar" aria-label="Pick date"
        className="w-6 border border-stone-300 rounded text-transparent bg-white cursor-pointer" style={{ colorScheme: "light" }} />
    </span>
  );
}

function makeReferralEvent() {
  return { eventType: "REFERRAL_PAID", amount: rand(5, 50) };
}
function makeGasFeeEvent(method) {
  return { eventType: "GAS_FEE_PAID", method, amount: rand(0.5, 5) };
}
function makeCryptoSellEvent(venue) {
  return { eventType: "CRYPTO_SELL", venue, amount: rand(5000, 60000) };
}

// ---------- storage ----------

const STORAGE_KEY = "ledger-data";
const TENANTS_STORAGE_KEY = "ledger-tenants";

// Persistence prefers window.storage when the host provides it, and falls back
// to the browser's localStorage - so a plain browser build (where window.storage
// doesn't exist) still remembers data across reloads. What actually gets saved
// per tenant is a config-only subset (see the save effect): setup like the chart
// of accounts, coins, wallets, labels, rules and filters persists, while the
// transaction lists intentionally reset each session.
async function loadData(key) {
  try {
    if (typeof window !== "undefined" && window.storage) {
      const res = await window.storage.get(key, false);
      if (res) return JSON.parse(res.value);
    }
  } catch { /* fall through to localStorage */ }
  try {
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    }
  } catch { /* ignore */ }
  return null;
}
async function saveData(key, data) {
  const json = JSON.stringify(data);
  try {
    if (typeof window !== "undefined" && window.storage) {
      await window.storage.set(key, json, false);
      return;
    }
  } catch { /* fall through to localStorage */ }
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, json);
  } catch { /* best-effort */ }
}

// ---------- language / i18n ----------

// A deliberately scoped translation layer: navigation, page headers/
// subtitles, and common action buttons get real Thai translations; deeper
// content (help text, CSV format explanations, table column labels) stays
// in English for now. The dictionary shape (flat key -> string per
// language) is what would get extended if more coverage is wanted later -
// no restructuring needed, just more entries.
const LANGUAGES = { en: "English", th: "ไทย" };
const TRANSLATIONS = {
  en: {
    tagline: "double-entry, automated",
    nav_general: "General", nav_bank: "Bank", nav_crypto: "Crypto", nav_automation: "Automation", nav_reporting: "Reporting", nav_settings: "Settings",
    nav_coa: "Chart of Accounts", nav_ledgerSync: "Ledger Connection", nav_bankTx: "Bank Transactions", nav_import: "Import", nav_categorize: "Categorize",
    nav_coins: "Coins", nav_wallets: "Wallets", nav_cryptoTx: "Crypto Transactions", nav_revaluation: "Revaluation", nav_types: "Label Mapping", nav_gasTanks: "Gas Tanks", nav_dataSources: "Data Sources",
    nav_ledger: "Ledger", nav_reports: "Reports", nav_analytics: "Analytics", nav_settingsTab: "Settings",
    ledger_balanced: "Ledger balanced", ledger_outOfBalance: "Out of balance",
    tenant_label: "Tenant", tenant_manage: "Manage tenants", tenant_modalTitle: "Tenants",
    tenant_newNamePlaceholder: "New tenant name (e.g. 2025 Demo)", tenant_hasCrypto: "This company has crypto transactions",
    tenant_close: "Close",
    common_add: "Add", common_save: "Save", common_cancel: "Cancel", common_edit: "Edit", common_delete: "Delete",
    common_import: "Import", common_export: "Export", common_reset: "Reset",
    title_coa: "Chart of Accounts", subtitle_coa: "Set up once, edit as your business changes. History-bearing accounts can't be deleted.",
    title_ledgerSync: "Ledger Connection", subtitle_ledgerSync: "Bring an existing ledger's balances in, or export this ledger's activity out.",
    title_bankTx: "Bank Transactions", subtitle_bankTx: "Import a bank statement, then match every transaction to an account before it posts.",
    title_import: "Import", subtitle_import: "Bring in a bank statement CSV to categorize and post.",
    title_categorize: "Categorize", subtitle_categorize: "Match imported transactions to accounts before they post.",
    title_coins: "Coins", subtitle_coins: "The master list of tradable assets this ledger prices activity against.",
    title_wallets: "Wallets", subtitle_wallets: "Custody locations, distinct from the accounts they map to.",
    title_cryptoTx: "Crypto Transactions", subtitle_cryptoTx: "Deposits, withdrawals, and transfers with FIFO cost-basis tracking.",
    title_gasTanks: "Gas Tanks", subtitle_gasTanks: "Register a gas-tank address per chain and pull its on-chain activity straight from the block explorer - no CSV export needed.",
    title_dataSources: "Data Sources", subtitle_dataSources: "Every way crypto activity comes in - file imports, on-chain gas tanks, and exchange syncs - in one place.",
    title_revaluation: "Revaluation", subtitle_revaluation: "Mark crypto holdings to market at a period end and book the unrealized gain or loss.",
    title_types: "Label Mapping", subtitle_types: "Map each label to the accounts it posts to (a debit and/or credit account). Applying a label to a transaction books its other side automatically.",
    title_ledger: "General Ledger", subtitle_ledger: "Every posted entry for one account, with a running balance.",
    title_reports: "Reports", subtitle_reports: "Computed live from the journal - never stored, never stale.",
    title_analytics: "Analytics", subtitle_analytics: "Financials Overview - computed live from the journal, same as Reports.",
    title_settings: "Settings", subtitle_settings: "App-wide preferences.",
    settings_language: "Language", settings_languageHelp: "Changes the sidebar, page titles, and common buttons across the app. This is a personal display preference, not part of any tenant's books - it stays the same when you switch tenants.",
  },
  th: {
    tagline: "บัญชีคู่ อัตโนมัติ",
    nav_general: "ทั่วไป", nav_bank: "ธนาคาร", nav_crypto: "คริปโต", nav_automation: "ระบบอัตโนมัติ", nav_reporting: "รายงาน", nav_settings: "ตั้งค่า",
    nav_coa: "ผังบัญชี", nav_ledgerSync: "การเชื่อมต่อบัญชีแยกประเภท", nav_bankTx: "ธุรกรรมธนาคาร", nav_import: "นำเข้า", nav_categorize: "จัดหมวดหมู่",
    nav_coins: "เหรียญ", nav_wallets: "กระเป๋าเงิน", nav_cryptoTx: "ธุรกรรมคริปโต", nav_revaluation: "ตีราคาใหม่", nav_types: "การจับคู่ป้ายกำกับ", nav_gasTanks: "แท็งก์ค่าแก๊ส", nav_dataSources: "แหล่งข้อมูล",
    nav_ledger: "บัญชีแยกประเภท", nav_reports: "รายงาน", nav_analytics: "การวิเคราะห์", nav_settingsTab: "ตั้งค่า",
    ledger_balanced: "บัญชีสมดุล", ledger_outOfBalance: "บัญชีไม่สมดุล",
    tenant_label: "บริษัท", tenant_manage: "จัดการบริษัท", tenant_modalTitle: "บริษัท",
    tenant_newNamePlaceholder: "ชื่อบริษัทใหม่ (เช่น 2025 Demo)", tenant_hasCrypto: "บริษัทนี้มีธุรกรรมคริปโต",
    tenant_close: "ปิด",
    common_add: "เพิ่ม", common_save: "บันทึก", common_cancel: "ยกเลิก", common_edit: "แก้ไข", common_delete: "ลบ",
    common_import: "นำเข้า", common_export: "ส่งออก", common_reset: "รีเซ็ต",
    title_coa: "ผังบัญชี", subtitle_coa: "ตั้งค่าเพียงครั้งเดียว แก้ไขได้เมื่อธุรกิจเปลี่ยนแปลง บัญชีที่มีประวัติธุรกรรมไม่สามารถลบได้",
    title_ledgerSync: "การเชื่อมต่อบัญชีแยกประเภท", subtitle_ledgerSync: "นำยอดคงเหลือจากบัญชีแยกประเภทเดิมเข้ามา หรือส่งออกกิจกรรมของบัญชีนี้",
    title_bankTx: "ธุรกรรมธนาคาร", subtitle_bankTx: "นำเข้ารายการเดินบัญชีธนาคาร แล้วจับคู่ทุกธุรกรรมกับบัญชีก่อนผ่านรายการ",
    title_import: "นำเข้า", subtitle_import: "นำเข้าไฟล์ CSV จากรายการเดินบัญชีธนาคารเพื่อจัดหมวดหมู่และผ่านรายการ",
    title_categorize: "จัดหมวดหมู่", subtitle_categorize: "จับคู่ธุรกรรมที่นำเข้ากับบัญชีก่อนผ่านรายการ",
    title_coins: "เหรียญ", subtitle_coins: "รายการหลักของสินทรัพย์ที่ซื้อขายได้ซึ่งบัญชีนี้ใช้อ้างอิงราคา",
    title_wallets: "กระเป๋าเงิน", subtitle_wallets: "สถานที่เก็บรักษาสินทรัพย์ แยกจากบัญชีที่เชื่อมโยงอยู่",
    title_cryptoTx: "ธุรกรรมคริปโต", subtitle_cryptoTx: "การฝาก ถอน และโอน พร้อมการติดตามต้นทุนแบบ FIFO",
    title_gasTanks: "แท็งก์ค่าแก๊ส", subtitle_gasTanks: "ลงทะเบียนที่อยู่แท็งก์ค่าแก๊สแต่ละเชน และดึงกิจกรรมออนเชนจาก block explorer โดยตรง - ไม่ต้องส่งออก CSV",
    title_revaluation: "ตีราคาใหม่", subtitle_revaluation: "ปรับมูลค่าสินทรัพย์คริปโตตามราคาตลาด ณ สิ้นงวด และบันทึกกำไรหรือขาดทุนที่ยังไม่เกิดขึ้นจริง",
    title_types: "การจับคู่ป้ายกำกับ", subtitle_types: "จับคู่ป้ายกำกับแต่ละอันกับบัญชีที่จะผ่านรายการ (บัญชีเดบิตและ/หรือเครดิต) การใช้ป้ายกำกับกับธุรกรรมจะบันทึกอีกด้านหนึ่งโดยอัตโนมัติ",
    title_ledger: "บัญชีแยกประเภททั่วไป", subtitle_ledger: "ทุกรายการที่ผ่านบัญชีแล้วของบัญชีหนึ่ง พร้อมยอดคงเหลือสะสม",
    title_reports: "รายงาน", subtitle_reports: "คำนวณสดจากสมุดรายวัน - ไม่มีการจัดเก็บ ไม่มีข้อมูลล้าสมัย",
    title_analytics: "การวิเคราะห์", subtitle_analytics: "ภาพรวมทางการเงิน - คำนวณสดจากสมุดรายวัน เช่นเดียวกับรายงาน",
    title_settings: "ตั้งค่า", subtitle_settings: "การตั้งค่าทั่วทั้งแอป",
    settings_language: "ภาษา", settings_languageHelp: "เปลี่ยนแถบด้านข้าง ชื่อหน้า และปุ่มทั่วไปทั่วทั้งแอป การตั้งค่านี้เป็นความชอบส่วนบุคคลในการแสดงผล ไม่ใช่ส่วนหนึ่งของบัญชีบริษัทใด ๆ จึงไม่เปลี่ยนแปลงเมื่อสลับบริษัท",
  },
};

// React Context rather than prop-drilling `lang`/`t` through every screen -
// this is a UI-wide concern (like theme would be), not something specific
// to any one component's data, and most screens below already take a long
// list of data/handler props without a language concern mixed in.
const LanguageContext = createContext({ lang: "en", t: (key) => key, setLang: () => {} });
function useLang() {
  return useContext(LanguageContext);
}
function translate(lang, key) {
  return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
}

const LANGUAGE_STORAGE_KEY = "ledger-language";

// ---------- searchable account picker ----------

// A drop-in replacement for `<select>{accounts.map(...)}</select>` used
// everywhere an account gets chosen from the Chart of Accounts. The real COA
// runs well past 100 rows, so scrolling a native select to find one account
// is painful - this looks and behaves like a select (click it, pick one,
// value is the account id) but the field is also a live text filter against
// both code and name, and closing without picking anything just reverts to
// showing whatever was already selected. Deliberately built once as a
// shared component rather than repeating this pattern at every call site.
function AccountSelect({ accounts, value, onChange, placeholder, className, disabled, allowClear, clearLabel, valueKey = "id" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  const selected = accounts.find((a) => a[valueKey] === value);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) => a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : accounts;

  function selectAccount(account) {
    onChange(account === "" ? "" : account[valueKey]);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e) {
    const optionCount = filtered.length + (allowClear ? 1 : 0);
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, optionCount - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (allowClear && highlight === 0) selectAccount("");
      else {
        const a = filtered[allowClear ? highlight - 1 : highlight];
        if (a) selectAccount(a);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        disabled={disabled}
        value={open ? query : (selected ? `${selected.code} - ${selected.name}` : "")}
        onChange={(e) => { setQuery(e.target.value); setHighlight(0); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); setHighlight(0); }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className || "w-full border border-stone-300 rounded px-2 py-1.5 text-sm"}
      />
      {open && (
        <div className="absolute z-40 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-stone-300 rounded shadow-lg">
          {allowClear && (
            <div
              onMouseDown={(e) => { e.preventDefault(); selectAccount(""); }}
              onMouseEnter={() => setHighlight(0)}
              className={`px-2 py-1.5 text-sm cursor-pointer text-slate-400 ${highlight === 0 ? "bg-[#E6FBF1]" : ""}`}
            >
              {clearLabel || "- none -"}
            </div>
          )}
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-slate-400">No matching accounts</div>
          )}
          {filtered.map((a, i) => {
            const idx = allowClear ? i + 1 : i;
            return (
              <div
                key={a.id}
                onMouseDown={(e) => { e.preventDefault(); selectAccount(a); }}
                onMouseEnter={() => setHighlight(idx)}
                className={`px-2 py-1.5 text-sm cursor-pointer ${idx === highlight ? "bg-[#E6FBF1]" : ""} ${a[valueKey] === value ? "font-medium" : ""}`}
              >
                {a.code} - {a.name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Grouped for the sidebar - Bank and Crypto both "bring in external
// transactions and post them" but work differently under the hood (free-text
// rule-matching vs. structured FIFO cost basis), so they stay separate
// screens; grouping just makes the relationship visible in the nav.
const NAV_GROUPS = [
  {
    labelKey: "nav_general",
    items: [
      { key: "coa", labelKey: "nav_coa", icon: BookOpen },
      { key: "ledgerSync", labelKey: "nav_ledgerSync", icon: RefreshCw },
    ],
  },
  {
    labelKey: "nav_bank",
    items: [
      { key: "bankTx", labelKey: "nav_bankTx", icon: Upload },
    ],
  },
  {
    labelKey: "nav_crypto",
    items: [
      { key: "dataSources", labelKey: "nav_dataSources", icon: FileUp },
      { key: "cryptoTx", labelKey: "nav_cryptoTx", icon: ArrowLeftRight },
      { key: "coins", labelKey: "nav_coins", icon: CoinsIcon },
      { key: "wallets", labelKey: "nav_wallets", icon: WalletIcon },
      { key: "revaluation", labelKey: "nav_revaluation", icon: Scale },
    ],
  },
  {
    // Referral payouts and gas fees - today's two sample event types - are
    // both crypto-side activity, so this sits right after Crypto rather
    // than up near Bank.
    labelKey: "nav_automation",
    items: [{ key: "types", labelKey: "nav_types", icon: Layers }],
  },
  {
    labelKey: "nav_reporting",
    items: [
      { key: "ledger", labelKey: "nav_ledger", icon: ScrollText },
      { key: "reports", labelKey: "nav_reports", icon: BarChart3 },
      { key: "analytics", labelKey: "nav_analytics", icon: Gauge },
    ],
  },
  {
    labelKey: "nav_settings",
    items: [{ key: "settings", labelKey: "nav_settingsTab", icon: SettingsIcon }],
  },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

// The actual application for one tenant's books - everything this file did
// before multi-tenant support was added. `tenantId`/`tenantName` are purely
// cosmetic here (header label); isolation between tenants is handled by the
// caller mounting a fresh instance (via React `key`) per tenant rather than
// this component threading a tenant id through every read/write itself -
// simpler and safer than trying to namespace every setter by hand.
function TenantWorkspace({ tenantId, tenantName, tenants, seed, hasCrypto, onSwitchTenant, onManageTenants }) {
  const { t } = useLang();
  const [ready, setReady] = useState(false);
  const [accounts, setAccounts] = useState(() => seedDataForTenant(seed, tenantName).accounts);
  const [entities, setEntities] = useState(() => seedDataForTenant(seed, tenantName).entities);
  const [transactions, setTransactions] = useState([]);
  const [rules, setRules] = useState(() => seedDataForTenant(seed, tenantName).rules);
  const [registry, setRegistry] = useState(() => seedDataForTenant(seed, tenantName).registry);
  const [events, setEvents] = useState([]);
  const [coins, setCoins] = useState(DEFAULT_COINS);
  const [wallets, setWallets] = useState(() => deriveDefaultWallets(seedDataForTenant(seed, tenantName).accounts));
  const [cryptoTxs, setCryptoTxs] = useState([]);
  const [cryptoRules, setCryptoRules] = useState([]);
  // Crypto label mappings - named contra splits (see DEFAULT_CRYPTO_LABELS).
  // The crypto half of the unified label-mapping posting automation.
  const [cryptoLabels, setCryptoLabels] = useState(() => seedDataForTenant(seed, tenantName).cryptoLabels);
  // Saved/favorite transaction filters (Cryptio-style) - named condition sets
  // reusable across sessions.
  const [cryptoFilters, setCryptoFilters] = useState([]);
  const [walletLabelRules, setWalletLabelRules] = useState([]);
  // Registered gas-tank addresses ({id, name, chain, address, walletId, cursor,
  // lastSyncedAt}) and the block-explorer API keys used to fetch them. Keys are
  // stored per-tenant alongside the rest of the books.
  const [gasTanks, setGasTanks] = useState(DEFAULT_GAS_TANKS);
  const [explorerKeys, setExplorerKeys] = useState({ etherscan: "", tronscan: "", coingecko: "", krakenUrl: "", krakenToken: "" });
  // Client withdrawal fee schedule (flat fee per coin) - carved out of each
  // client withdrawal and booked to fee revenue.
  const [withdrawFees, setWithdrawFees] = useState(DEFAULT_WITHDRAW_FEES);
  // Period-end revaluations (mark-to-market) - each a posted record whose
  // journal lines are computed live from its stored per-holding adjustments.
  const [revaluations, setRevaluations] = useState([]);
  // Period lock (internal control) - a "closed through" date. Once set,
  // nothing dated on or before it can be posted, edited, or deleted, so a
  // closed accounting period can't be silently changed after the fact.
  // Empty string = nothing locked.
  const [lockDate, setLockDate] = useState("");
  const isLocked = (date) => !!lockDate && !!date && date <= lockDate;
  const [tab, setTab] = useState("coa");
  // When a report row's "See movements" link is clicked, jump to the Ledger
  // tab with that account preselected. Lives here (not in LedgerView) because
  // the tab switch and the account focus have to happen together.
  const [ledgerFocusAccountId, setLedgerFocusAccountId] = useState("");
  function goToLedger(accountId) {
    setLedgerFocusAccountId(accountId);
    setTab("ledger");
  }
  const fileRef = useRef(null);

  // Some tenants don't deal in crypto at all - hide that whole nav group
  // rather than leaving three tabs open onto empty/irrelevant screens.
  const navGroups = hasCrypto ? NAV_GROUPS : NAV_GROUPS.filter((g) => g.labelKey !== "nav_crypto");
  const CRYPTO_TABS = ["dataSources", "coins", "wallets", "cryptoTx", "revaluation"];
  useEffect(() => {
    if (!hasCrypto && CRYPTO_TABS.includes(tab)) setTab("coa");
  }, [hasCrypto, tab]);

  // Every tenant persists under its own storage key so switching tenants
  // never reads or writes another company's books.
  const storageKey = `${STORAGE_KEY}-${tenantId}`;

  useEffect(() => {
    (async () => {
      const saved = await loadData(storageKey);
      const seedData = seedDataForTenant(seed, tenantName);
      if (saved) {
        setAccounts(saved.accounts || seedData.accounts);
        setEntities(saved.entities || seedData.entities);
        setTransactions(saved.transactions || []);
        setRules(saved.rules || seedData.rules);
        setEvents(saved.events || []);
        setRegistry(saved.registry || seedData.registry);
        setCoins(saved.coins || DEFAULT_COINS);
        setWallets(saved.wallets || deriveDefaultWallets(saved.accounts || seedData.accounts));
        setCryptoTxs(saved.cryptoTxs || []);
        setCryptoRules(saved.cryptoRules || []);
        setCryptoLabels(migrateCryptoLabels((saved.cryptoLabels || seedData.cryptoLabels || []).map(normalizeCryptoLabel)));
        setCryptoFilters(saved.cryptoFilters || []);
        setWalletLabelRules(saved.walletLabelRules || []);
        // `?? defaults` so a tenant saved before this feature (no gasTanks key)
        // gets the four BitGo tanks; a saved [] (user deleted them) stays empty.
        // Sync cursors reset each session (the txs they tracked didn't persist),
        // so a fresh Sync re-fetches from the start.
        setGasTanks((saved.gasTanks ?? DEFAULT_GAS_TANKS).map((g) => ({ ...g, cursor: 0, lastSyncedAt: 0 })));
        setWithdrawFees(saved.withdrawFees ?? DEFAULT_WITHDRAW_FEES);
        // explorerKeys are loaded separately from localStorage (see below), not
        // from this window.storage blob, so they persist across reloads.
        setRevaluations(saved.revaluations || []);
        setLockDate(saved.lockDate || "");
      }
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (!ready) return;
    // Config only - the setup that's tedious to redo. The transaction lists
    // (transactions, cryptoTxs, events, revaluations) are deliberately excluded
    // so they reset each session; imports/syncs bring them back. Gas-tank sync
    // cursors are stripped so a fresh session re-fetches (its txs didn't persist).
    saveData(storageKey, {
      accounts, entities, rules, registry, coins, wallets,
      cryptoRules, cryptoLabels, cryptoFilters, walletLabelRules,
      gasTanks: gasTanks.map((g) => ({ id: g.id, name: g.name, chain: g.chain, address: g.address, walletId: g.walletId })),
      withdrawFees, lockDate,
    });
  }, [storageKey, accounts, entities, rules, registry, coins, wallets, cryptoRules, cryptoLabels, cryptoFilters, walletLabelRules, gasTanks, withdrawFees, lockDate, ready]);

  // API keys are the one thing that should survive a reload (they're annoying to
  // re-enter), even though transactions and other books intentionally don't.
  // So they persist on their own in the browser's localStorage, keyed per
  // company - independent of the window.storage path everything else uses.
  const explorerKeysKey = `ledger-explorer-keys-${tenantId}`;
  useEffect(() => {
    try {
      const v = typeof localStorage !== "undefined" ? localStorage.getItem(explorerKeysKey) : null;
      const parsed = v ? JSON.parse(v) : null;
      setExplorerKeys(parsed && typeof parsed === "object"
        ? { etherscan: parsed.etherscan || "", tronscan: parsed.tronscan || "", coingecko: parsed.coingecko || "", krakenUrl: parsed.krakenUrl || "", krakenToken: parsed.krakenToken || "" }
        : { etherscan: "", tronscan: "", coingecko: "", krakenUrl: "", krakenToken: "" });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);
  useEffect(() => {
    if (!ready) return;
    try { if (typeof localStorage !== "undefined") localStorage.setItem(explorerKeysKey, JSON.stringify(explorerKeys)); } catch { /* best-effort */ }
  }, [explorerKeys, explorerKeysKey, ready]);

  // Once loaded, drop any zero-principal crypto transactions already sitting
  // in the ledger (fee-only import artifacts). They can never post, so this
  // just clears them out of Needs review. New imports skip them at the source
  // (parseCryptoCsvRow), so this only has to run once per load.
  useEffect(() => {
    if (!ready) return;
    setCryptoTxs((prev) => {
      const cleaned = prev.filter((t) => Number(t.quantity) > 0);
      return cleaned.length === prev.length ? prev : cleaned;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // If any unposted draft references a coin with no market rate, fetch the rate
  // from CoinGecko in the background (not only when the Coins tab is open) so
  // zero-price rows - e.g. gas-tank imports whose sync-time price fetch didn't
  // land - get valued automatically. Guarded so it runs once per gap, no loop.
  const ratesFetchingRef = useRef(false);
  useEffect(() => {
    if (!ready || ratesFetchingRef.current) return;
    const need = coins.filter((c) => !c.isFiat && !(Number(c.marketRate) > 0) && cryptoTxs.some((t) => !t.posted && t.coinId === c.id));
    if (!need.length) return;
    ratesFetchingRef.current = true;
    (async () => {
      try {
        const { updates } = await fetchLiveCoinRates(need, explorerKeys.coingecko);
        if (updates.length) setCoins((prev) => prev.map((c) => { const u = updates.find((x) => x.id === c.id); return u ? { ...c, marketRate: u.rate } : c; }));
      } catch { /* offline / blocked - rates stay as-is */ }
      finally { ratesFetchingRef.current = false; }
    })();
  }, [coins, cryptoTxs, ready, explorerKeys]);

  // Backfill a price onto any unposted draft still sitting at $0 once its coin
  // has a market rate. Gas-tank rows fetch a historical price at sync time, but
  // rows imported before a rate was known (or any zero-price import) would
  // otherwise be stuck un-postable at $0 - this values them at the coin's
  // current rate so they can post (correct the rate in the row if needed).
  // Idempotent: only fills a missing price, so it never loops or overwrites.
  useEffect(() => {
    if (!ready) return;
    setCryptoTxs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.posted || Number(t.perCoinPrice) > 0) return t;
        const rate = Number(coins.find((c) => c.id === t.coinId)?.marketRate) || 0;
        if (rate > 0) { changed = true; return { ...t, perCoinPrice: rate }; }
        return t;
      });
      return changed ? next : prev;
    });
  }, [coins, cryptoTxs, ready]);

  const bankJournal = useJournal(transactions);
  const eventJournal = useMemo(() => {
    const lines = [];
    events.filter((e) => e.status === "posted").forEach((e) => {
      const label = registry.find((t) => t.id === e.templateId)?.label || e.eventType;
      e.legs.forEach((l, i) =>
        lines.push({
          id: `${e.id}_${i}`, entryId: e.id, date: e.date, description: label,
          accountId: l.accountId, debit: l.side === "debit" ? l.amount : 0, credit: l.side === "credit" ? l.amount : 0,
        })
      );
    });
    return lines;
  }, [events, registry]);
  // The FIFO engine needs every posted crypto tx together (lots carry
  // forward across transactions), so it's run once per render rather than
  // per-transaction - same "recompute live from source data" principle as
  // the rest of the journal.
  const cryptoLedger = useMemo(
    () => computeCryptoLedger(cryptoTxs.filter((t) => t.posted), wallets, accounts, coins),
    [cryptoTxs, wallets, accounts, coins]
  );
  const cryptoJournal = useMemo(() => {
    const lines = [];
    cryptoTxs.filter((t) => t.posted).forEach((t) => {
      const legs = cryptoLedger.linesByTx.get(t.id) || [];
      const coin = coins.find((c) => c.id === t.coinId);
      legs.forEach((l, i) =>
        lines.push({
          id: `${t.id}_${i}`, entryId: t.id, date: t.date, description: `${t.type} ${coin?.symbol || ""} - ${l.label}`,
          accountId: l.accountId, debit: l.side === "debit" ? l.amount : 0, credit: l.side === "credit" ? l.amount : 0,
        })
      );
    });
    return lines;
  }, [cryptoTxs, cryptoLedger, coins]);
  const revaluationJournal = useMemo(() => {
    const lines = [];
    revaluations.forEach((r) => lines.push(...revaluationJournalLines(r, wallets, accounts)));
    return lines;
  }, [revaluations, wallets, accounts]);
  const journal = useMemo(() => [...bankJournal, ...eventJournal, ...cryptoJournal, ...revaluationJournal], [bankJournal, eventJournal, cryptoJournal, revaluationJournal]);

  // The full org chart has 19 entities, but only the ones with actual
  // accounts in this ledger belong in a Balance Sheet/Analytics column
  // pivot - a 19-column table would be unreadable and 18 of those columns
  // would always read zero. This list grows on its own as accounts get
  // tagged to other entities; nothing else needs to change for that to
  // start working.
  const activeEntities = useMemo(
    () => entities.filter((e) => accounts.some((a) => a.entityId === e.id)),
    [entities, accounts]
  );

  const totalDebits = journal.reduce((s, j) => s + j.debit, 0);
  const totalCredits = journal.reduce((s, j) => s + j.credit, 0);
  const balanced = Math.abs(totalDebits - totalCredits) < 0.005;

  const bankAccounts = accounts.filter((a) => a.isBank);
  const expenseFallback = accounts.find((a) => a.code === "590199")?.id;

  function addAccount(acc) {
    const id = uid("acc");
    setAccounts((prev) => [...prev, { ...acc, id }]);
    return id;
  }
  // Bulk version of addAccount for bringing in an existing client's account
  // list wholesale (as opposed to Ledger Connection's opening-balance
  // import, which also posts a balancing journal entry) - this just creates
  // the accounts themselves, no balances, no journal activity. Rows whose
  // code collides with an existing account are silently skipped (the
  // ChartOfAccounts screen's preview step already warns about these before
  // this is ever called) rather than overwriting/duplicating.
  function addAccountsBulk(rows) {
    let added = 0;
    setAccounts((prev) => {
      const existingCodes = new Set(prev.map((a) => a.code));
      // Falls back to whatever entity this tenant's existing accounts
      // already use (there's usually just one until multi-entity is set
      // up), rather than a hardcoded id that would only be right for a
      // blank-seed tenant.
      const defaultEntityId = prev[0]?.entityId || entities[0]?.id;
      const next = [...prev];
      rows.forEach((row) => {
        if (existingCodes.has(row.code)) return;
        existingCodes.add(row.code);
        next.push({ id: uid("acc"), ...row, entityId: row.entityId || defaultEntityId });
        added++;
      });
      return next;
    });
    return added;
  }
  function updateAccount(id, patch) {
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  function deleteAccount(id) {
    if (journal.some((j) => j.accountId === id)) return;
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  function addEntity(entity) {
    const id = uid("ent");
    setEntities((prev) => [...prev, { ...entity, id }]);
    return id;
  }
  function updateEntity(id, patch) {
    setEntities((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  // Blocked if any account still points to this entity (would otherwise
  // orphan those accounts' entity tag) or if another entity still lists it
  // as a parent (would otherwise break the Ownership Structure chain).
  function deleteEntity(id) {
    if (accounts.some((a) => a.entityId === id)) return false;
    if (entities.some((e) => e.id !== id && (e.parentId === id || e.secondParentId === id))) return false;
    setEntities((prev) => prev.filter((e) => e.id !== id));
    return true;
  }

  function importCsv(text, bankAccountId) {
    const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    const existingHashes = new Set(transactions.map((t) => t.hash));
    let added = 0, dupes = 0;
    const next = [];
    parsed.data.forEach((row) => {
      const date = (row.Date || row.date || "").trim();
      const description = (row.Description || row.description || "").trim();
      const amount = parseFloat(String(row.Amount ?? row.amount ?? "0").replace(/[$,]/g, ""));
      if (!date || Number.isNaN(amount)) return;
      const hash = `${date}|${amount}|${description.toLowerCase()}`;
      if (existingHashes.has(hash)) { dupes++; return; }
      existingHashes.add(hash);
      const { accountId, matched } = applyRules(description, rules, expenseFallback, amount);
      next.push({
        id: uid("tx"), date, description, amount, hash,
        bankAccountId, mappedAccountId: accountId,
        posted: matched, matchedByRule: matched,
      });
      added++;
    });
    setTransactions((prev) => [...prev, ...next]);
    return { added, dupes };
  }

  function addEvent(fields) {
    const attempted = tryPostEvent({ id: uid("evt"), date: todayStr(), ...fields }, registry, accounts);
    setEvents((prev) => [...prev, attempted]);
  }

  // Saving a template (new or edited) immediately re-tries every event that
  // isn't already posted - this is the "automatic after matching" part.
  function saveTemplate(template) {
    const newRegistry = registry.some((t) => t.id === template.id)
      ? registry.map((t) => (t.id === template.id ? template : t))
      : [...registry, template];
    setRegistry(newRegistry);
    setEvents((prev) => prev.map((e) => (e.status === "posted" ? e : tryPostEvent(e, newRegistry, accounts))));
  }

  function toggleTemplateStatus(id) {
    setRegistry((prev) => prev.map((t) => (t.id === id ? { ...t, status: t.status === "active" ? "inactive" : "active" } : t)));
  }

  // Bringing an existing ledger in: each row is {code, name, type, balance}.
  // An existing code keeps its account untouched (name/type aren't silently
  // overwritten) - only a new code creates a new account. Every balance
  // posts once, as of one conversion date, against Opening Balance Equity -
  // the same convention QuickBooks/Xero use for their own opening-balance
  // entries, so the whole import is exactly one balanced journal entry with
  // no invented history. It's built as a real (one-off) Transaction Types
  // template with fixed legs, so it shows up - and is editable/reversible -
  // in Transaction Types exactly like anything else that's ever posted.
  function importOpeningBalances(rows, asOfDate) {
    let workingAccounts = accounts;
    const resolvedRows = [];
    let created = 0;
    rows.forEach((row) => {
      let acct = workingAccounts.find((a) => a.code === row.code);
      if (!acct) {
        acct = {
          id: uid("acc"), code: row.code, name: row.name, type: row.type,
          isBank: false, cf: ["Asset", "Liability", "Equity"].includes(row.type) ? defaultCf(row.type) : undefined,
        };
        workingAccounts = [...workingAccounts, acct];
        created++;
      }
      resolvedRows.push({ account: acct, balance: row.balance });
    });
    if (workingAccounts !== accounts) setAccounts(workingAccounts);

    // A positive stated balance sits on the account's own normal-balance
    // side; a negative one (e.g. an overdrawn account, or a contra balance)
    // flips to the other side instead of being misread as a bigger positive.
    const legs = [];
    let debitTotal = 0, creditTotal = 0;
    resolvedRows.forEach(({ account, balance }) => {
      if (!Number.isFinite(balance) || Math.abs(balance) < 0.005) return;
      const normalSide = NORMAL_BALANCE[account.type];
      const side = balance >= 0 ? normalSide : (normalSide === "debit" ? "credit" : "debit");
      const amount = Math.abs(balance);
      legs.push({ accountRef: account.name, side, mode: "fixed", fixedAmount: amount });
      if (side === "debit") debitTotal += amount; else creditTotal += amount;
    });
    const diff = debitTotal - creditTotal;
    if (Math.abs(diff) >= 0.005) {
      legs.push({
        accountRef: "Opening Balance Equity",
        side: diff > 0 ? "credit" : "debit",
        mode: "fixed",
        fixedAmount: Math.abs(diff),
      });
    }

    const eventType = `OPENING_BALANCES_${asOfDate}`;
    const template = {
      id: uid("type"), code: `OB-${asOfDate}`, label: `Opening balances as of ${asOfDate}`, status: "active",
      matchRule: { all: [{ field: "eventType", equals: eventType }] },
      legs,
    };
    const newRegistry = [...registry, template];
    setRegistry(newRegistry);
    const posted = tryPostEvent({ id: uid("evt"), date: asOfDate, eventType }, newRegistry, workingAccounts);
    setEvents((prev) => [...prev, posted]);
    return { accountsCreated: created, accountsMatched: resolvedRows.length - created, legCount: legs.length, status: posted.status, reason: posted.reason };
  }

  function addCoin(coin) {
    setCoins((prev) => [...prev, { ...coin, id: uid("coin") }]);
  }
  function updateCoinRate(id, marketRate) {
    setCoins((prev) => prev.map((c) => (c.id === id ? { ...c, marketRate } : c)));
  }
  // Pull live USD prices from CoinGecko and write them onto each mappable coin's
  // marketRate. Returns { updated, skipped } for the UI; throws on fetch failure.
  // Fetch each symbol's USD price as of a specific date (historical), for the
  // revaluation marks - historical-by-date via CoinGecko (with key) or Coinbase,
  // falling back to the current price if that date isn't available. Returns a
  // { symbol: price } map.
  async function fetchDatedCoinPrices(symbols, isoDate) {
    const out = {};
    for (const sym of [...new Set(symbols)]) {
      let p = null;
      try { p = await fetchGasHistoricalPrice(sym, isoDate, explorerKeys.coingecko); } catch { p = null; }
      if (!(p > 0)) { try { p = await fetchGasCurrentPrice(sym, explorerKeys.coingecko); } catch { p = 0; } }
      if (p > 0) out[sym] = p;
    }
    return out;
  }
  async function refreshLiveRates() {
    const { updates, skipped } = await fetchLiveCoinRates(coins, explorerKeys.coingecko);
    if (updates.length) setCoins((prev) => prev.map((c) => {
      const u = updates.find((x) => x.id === c.id);
      return u ? { ...c, marketRate: u.rate } : c;
    }));
    return { updated: updates.length, skipped };
  }

  function addWallet(wallet) {
    setWallets((prev) => [...prev, { ...wallet, id: uid("wal") }]);
  }
  function updateWallet(id, patch) {
    setWallets((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }
  function deleteWallet(id) {
    if (cryptoTxs.some((t) => t.walletId === id || t.toWalletId === id)) return;
    setWallets((prev) => prev.filter((w) => w.id !== id));
  }

  // A new crypto transaction is always saved as a draft (posted: false) -
  // "Build Journals" is the separate, explicit step that pushes drafts into
  // the real ledger, mirroring the reference's two-phase build-then-post flow.
  function addCryptoTx(tx) {
    if (!(Number(tx.quantity) > 0)) return; // no zero-amount transactions
    setCryptoTxs((prev) => [...prev, { ...tx, id: uid("ctx"), posted: false }]);
  }
  // `extraLabelRules` are wallet-label mappings the importer's own "map this
  // wallet" prompt just resolved for labels this file mentions that weren't
  // already covered - applied to this import immediately, and persisted via
  // addWalletLabelRule so the same label routes automatically next time.
  function importCryptoCsvHandler(text, walletId, extraLabelRules = []) {
    const mergedLabelRules = extraLabelRules.length
      ? [...walletLabelRules, ...extraLabelRules.filter((r) => !walletLabelRules.some((w) => w.label.toLowerCase() === r.label.toLowerCase()))]
      : walletLabelRules;
    const result = importCryptoCsv(text, walletId, wallets, coins, accounts, cryptoTxs, cryptoRules, mergedLabelRules, cryptoLabels);
    if (result.newCoins?.length) setCoins((prev) => [...prev, ...result.newCoins]);
    // A CSV upload is a Bitgo client-custody import (gas-tank rows come in via
    // the sync path instead), tagged so Needs Review can be filtered by source.
    setCryptoTxs((prev) => [...prev, ...result.txs.map((tx) => ({ ...tx, id: uid("ctx"), posted: false, source: "client" }))]);
    extraLabelRules.forEach((r) => addWalletLabelRule(r.label, r.walletId));
    return {
      added: result.added, dupes: result.dupes, skipped: result.skipped,
      autoRouted: result.autoRouted, newCoins: (result.newCoins || []).map((c) => c.symbol),
    };
  }
  // "Teach once" - a label from a source's own export mapped to one of this
  // app's Wallets, remembered so every future row with that same label
  // routes automatically instead of needing this prompt again. A newer
  // mapping for the same label (case-insensitive) replaces the old one.
  function addWalletLabelRule(label, walletId) {
    setWalletLabelRules((prev) => [
      ...prev.filter((r) => r.label.toLowerCase() !== label.toLowerCase()),
      { id: uid("wlrule"), label, walletId },
    ]);
  }
  // ---- gas tanks ----
  function addGasTank(tank) {
    setGasTanks((prev) => [...prev, { id: uid("gtank"), name: "", chain: "eth", address: "", walletId: "", cursor: 0, lastSyncedAt: 0, ...tank }]);
  }
  function updateGasTank(id, patch) {
    setGasTanks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function removeGasTank(id) {
    setGasTanks((prev) => prev.filter((t) => t.id !== id));
  }
  // ---- withdrawal fee schedule ----
  function addWithdrawFee(entry) {
    setWithdrawFees((prev) => [...prev, { id: uid("wf"), coin: "", network: "", fee: 0, ...entry }]);
  }
  function updateWithdrawFee(id, patch) {
    setWithdrawFees((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function removeWithdrawFee(id) {
    setWithdrawFees((prev) => prev.filter((f) => f.id !== id));
  }
  // Fetch each listed gas tank from its chain's explorer and import the new
  // activity, threading a growing "existing transactions"/"new coins" view
  // through the loop so one Sync-all run de-dupes correctly across tanks and
  // commits state once. Returns a per-tank { added, dupes, skipped } | { error }.
  // Pull Kraken trades + ledgers through the user's signing proxy and import
  // them: trades become Trade transactions (via the existing trade importer),
  // deposits/withdrawals become Deposit/Withdrawal rows. Tagged source "kraken".
  async function syncKraken() {
    const url = (explorerKeys.krakenUrl || "").trim();
    const token = (explorerKeys.krakenToken || "").trim();
    if (!url) return { error: "Set the Kraken proxy URL in Settings › Crypto first." };
    // Land Kraken activity on a Kraken venue wallet if there is one, else a
    // company crypto wallet (the trade importer re-routes the crypto side).
    const fallback = wallets.find((w) => /kraken/i.test(w.name))
      || wallets.find((w) => /#\s*crypto/i.test(w.name) && /company/i.test(w.name) && !/client/i.test(w.name))
      || wallets.find((w) => !w.isBank) || wallets[0];
    if (!fallback) return { error: "No wallet available to import Kraken activity into." };
    try {
      const trades = await fetchKrakenAll(url, token, "TradesHistory", "trades");
      const ledger = await fetchKrakenAll(url, token, "Ledgers", "ledger");
      const tradeRes = importTradeFills(krakenTradesToFillRows(trades), fallback.id, wallets, coins, cryptoTxs, cryptoLabels);
      const afterTrades = [...cryptoTxs, ...tradeRes.txs];
      const workingCoins = [...coins, ...(tradeRes.newCoins || [])];
      const ledgerRes = buildCryptoTxsFromRows(krakenLedgersToRows(ledger), fallback.id, wallets, workingCoins, accounts, afterTrades, cryptoRules, walletLabelRules, cryptoLabels);
      const newCoins = [...(tradeRes.newCoins || []), ...(ledgerRes.newCoins || [])];
      if (newCoins.length) setCoins((prev) => [...prev, ...newCoins.filter((c) => !prev.some((p) => p.symbol === c.symbol))]);
      const withIds = [
        ...tradeRes.txs.map((tx) => ({ ...tx, id: uid("ctx"), posted: false, source: "kraken" })),
        ...ledgerRes.txs.map((tx) => ({ ...tx, id: uid("ctx"), posted: false, source: "kraken" })),
      ];
      if (withIds.length) setCryptoTxs((prev) => [...prev, ...withIds]);
      return { trades: tradeRes.added, deposits: ledgerRes.added, dupes: (tradeRes.dupes || 0) + (ledgerRes.dupes || 0), at: Date.now() };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }
  async function syncGasTanks(ids) {
    let existing = cryptoTxs;
    const addedCoins = [];
    const newTxs = [];
    const cursors = {};
    const perTank = {};
    // All gas tanks post to the one company gas wallet (112106), resolved here
    // so tanks don't have to carry a walletId (defaults included).
    const gasWalletId = wallets.find((w) => w.accountId === "acc_112106")?.id;
    const priceCache = {}; // `${sym}|${date}` -> usd, shared across tanks this run
    const rateSeed = {}; // symbol -> current price, to seed a new coin's market rate
    for (const id of ids) {
      const tank = gasTanks.find((t) => t.id === id);
      if (!tank) { perTank[id] = { error: "Gas tank not found." }; continue; }
      if (!String(tank.address || "").trim()) { perTank[id] = { error: "Set this tank's address first." }; continue; }
      if (!gasWalletId) { perTank[id] = { error: "No company gas wallet (112106) - add one in Wallets." }; continue; }
      try {
        const { rows, cursor } = await fetchGasTankRows(tank, explorerKeys);
        // Explorers don't return a USD price - fetch one (historical per date,
        // current fallback) so imported rows have a real value, not $0.
        const sym = GAS_TANK_CHAINS[tank.chain]?.sym;
        const cur = await stampGasTankRowPrices(rows, sym, priceCache, explorerKeys.coingecko);
        if (sym && cur > 0 && rateSeed[sym] === undefined) rateSeed[sym] = cur;
        const workingCoins = [...coins, ...addedCoins];
        const result = buildCryptoTxsFromRows(rows, gasWalletId, wallets, workingCoins, accounts, existing, cryptoRules, walletLabelRules, cryptoLabels);
        const withIds = result.txs.map((tx) => ({ ...tx, id: uid("ctx"), posted: false, source: "gastank" }));
        existing = [...existing, ...withIds];
        newTxs.push(...withIds);
        (result.newCoins || []).forEach((c) => { if (!addedCoins.some((x) => x.symbol === c.symbol)) addedCoins.push(c); });
        cursors[id] = cursor;
        perTank[id] = { added: result.added, dupes: result.dupes, skipped: result.skipped };
      } catch (e) {
        perTank[id] = { error: e.message || String(e) };
      }
    }
    // Seed a market rate on any newly-created coin (and any existing gas-tank
    // coin still sitting at 0) from the current price we fetched, so it isn't $0
    // in Coins/Inventory/reports until the live-rate refresh runs.
    addedCoins.forEach((c) => { if (!(c.marketRate > 0) && rateSeed[c.symbol] > 0) c.marketRate = rateSeed[c.symbol]; });
    if (addedCoins.length) setCoins((prev) => [...prev, ...addedCoins.filter((c) => !prev.some((p) => p.symbol === c.symbol))]);
    if (Object.keys(rateSeed).length) setCoins((prev) => prev.map((c) => (!(c.marketRate > 0) && rateSeed[c.symbol] > 0 ? { ...c, marketRate: rateSeed[c.symbol] } : c)));
    if (newTxs.length) setCryptoTxs((prev) => [...prev, ...newTxs]);
    if (Object.keys(cursors).length) setGasTanks((prev) => prev.map((t) => (cursors[t.id] !== undefined ? { ...t, cursor: cursors[t.id], lastSyncedAt: Date.now() } : t)));
    return perTank;
  }
  // The one thing a Drafts-list row can be fixed up after the fact - a
  // missing Ledger Account or destination wallet, same "one field short"
  // gap a CSV-imported bank row has before Categorize. Posted transactions
  // are immutable for the same FIFO-history reason deletion is restricted.
  function updateCryptoTx(id, patch) {
    const target = cryptoTxs.find((t) => t.id === id);
    if (target && isLocked(target.date)) return;
    setCryptoTxs((prev) => prev.map((t) => (t.id === id && !t.posted ? { ...t, ...patch } : t)));
  }
  // Needs Review's per-row Post - the crypto equivalent of Categorize's
  // Post button. Applies the chosen account (or split, or destination
  // wallet) to just this one draft, then checks - via the same FIFO engine
  // the live ledger uses - whether it actually resolves before marking it
  // posted. Other drafts sitting in the queue are untouched; they still
  // wait for either their own Post or a batch Build Journals.
  function postCryptoTx(id, patch) {
    const target = cryptoTxs.find((t) => t.id === id);
    if (target && isLocked(target.date)) return { ok: false, reason: `Period is locked through ${lockDate} - can't post into a closed period.` };
    const updated = cryptoTxs.map((t) => (t.id === id ? { ...t, ...patch } : t));
    const attempt = computeCryptoLedger(updated, wallets, accounts, coins);
    if (!attempt.linesByTx.has(id)) return { ok: false, reason: attempt.errors.get(id) };
    setCryptoTxs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch, posted: true } : t)));
    return { ok: true };
  }
  // One account applied to a batch of Needs Review rows at once - the same
  // idea as postCryptoTx, just for many ids in one click instead of one
  // Post button at a time. Every patched row is attempted together, oldest
  // date first (same order Build Journals uses), so a Withdrawal earlier in
  // the same batch can draw on cost-basis lots a Deposit elsewhere in that
  // same batch just established - each row's own state only actually flips
  // to posted once it genuinely resolves; anything that doesn't (e.g. not
  // enough recorded cost basis yet) is left as a draft with its real reason,
  // same "never force-posted" guarantee buildJournals gives.
  function bulkPostCryptoTxs(ids, ledgerAccountId, remember) {
    let working = cryptoTxs.map((t) => (ids.includes(t.id) ? { ...t, ledgerAccountId, ledgerSplits: null, ledgerLegs: null, matchedLabelId: undefined } : t));
    const posted = [];
    const failed = [];
    // Anything dated in a closed period can't be booked - fail those up front
    // with the lock reason, and only attempt the rest.
    const lockedIds = ids.filter((id) => isLocked(working.find((t) => t.id === id)?.date));
    lockedIds.forEach((id) => failed.push({ id, reason: `Period is locked through ${lockDate}.` }));
    const attemptable = ids.filter((id) => !lockedIds.includes(id));
    const orderedIds = [...attemptable].sort((a, b) => {
      const ta = working.find((t) => t.id === a)?.date || "";
      const tb = working.find((t) => t.id === b)?.date || "";
      return ta.localeCompare(tb);
    });
    orderedIds.forEach((id) => {
      const attempt = computeCryptoLedger(working, wallets, accounts, coins);
      if (attempt.linesByTx.has(id)) {
        working = working.map((t) => (t.id === id ? { ...t, posted: true } : t));
        posted.push(id);
      } else {
        failed.push({ id, reason: attempt.errors.get(id) });
      }
    });
    setCryptoTxs(working);
    if (remember) {
      // One rule per distinct (type, coin) actually posted in this batch -
      // same wildcard-rule shape a single row's "remember" checkbox saves.
      const seen = new Set();
      posted.forEach((id) => {
        const t = working.find((x) => x.id === id);
        const key = `${t.type}|${t.coinId}`;
        if (seen.has(key)) return;
        seen.add(key);
        rememberCryptoRule(t.type, t.coinId, ledgerAccountId, undefined);
      });
    }
    return { posted, failed };
  }
  // Apply one label to a batch of Needs Review rows and post them - the bridge
  // from the transaction filter to the label-mapping automation. Unlike the
  // single-account bulk post, the contra account is resolved per row from the
  // label by direction (its Credit Account on deposits, Debit Account on
  // withdrawals), so a mixed filtered set books each side correctly. Same
  // oldest-first, never-force-posted, lock-respecting guarantees.
  function bulkLabelAndPost(ids, labelId, remember) {
    const label = cryptoLabels.find((l) => l.id === labelId);
    if (!label) return { posted: [], failed: ids.map((id) => ({ id, reason: "Unknown label." })) };
    const isTransfer = labelIsTransfer(label);
    let working = cryptoTxs.map((t) => {
      if (!ids.includes(t.id)) return t;
      const coin = coins.find((c) => c.id === t.coinId);
      if (isTransfer) {
        const dest = labelTransferDestWallet(label, wallets, t.walletId, coin);
        if (!dest || dest.id === t.walletId) return { ...t, matchedLabelId: labelId };
        return { ...t, type: "Transfer", toWalletId: dest.id, ledgerLegs: undefined, ledgerAccountId: null, ledgerSplits: null, matchedLabelId: labelId };
      }
      const legs = resolveLabelLegs(label, t.type, coinValue(t.quantity, t.perCoinPrice));
      // The label's wallet leg is the accounting wallet (auto-routed to the
      // coin's stablecoin/crypto sibling) - re-point the row onto it.
      const labelWallet = labelPostWallet(label, wallets, coin);
      return { ...t, ledgerLegs: legs || undefined, ledgerAccountId: null, ledgerSplits: null, matchedLabelId: labelId, ...(legs && labelWallet ? { walletId: labelWallet.id } : {}) };
    });
    const posted = [];
    const failed = [];
    const lockedIds = ids.filter((id) => isLocked(working.find((t) => t.id === id)?.date));
    lockedIds.forEach((id) => failed.push({ id, reason: `Period is locked through ${lockDate}.` }));
    const noContra = ids.filter((id) => !lockedIds.includes(id) && (isTransfer
      ? working.find((t) => t.id === id)?.type !== "Transfer"
      : !working.find((t) => t.id === id)?.ledgerLegs));
    noContra.forEach((id) => {
      const t = working.find((x) => x.id === id);
      const noValue = !isTransfer && !(coinValue(t?.quantity, t?.perCoinPrice) > 0);
      failed.push({ id, reason: isTransfer
        ? `This transfer label's destination wallet couldn't be resolved for this row.`
        : noValue
          ? `This ${(t?.type || "").toLowerCase()} has no value yet - set its coin's market rate (or price) first.`
          : `This label doesn't apply to a ${(t?.type || "").toLowerCase()} (its legs net the wrong way).` });
    });
    const skip = new Set([...lockedIds, ...noContra]);
    const orderedIds = ids.filter((id) => !skip.has(id)).sort((a, b) => {
      const ta = working.find((t) => t.id === a)?.date || "";
      const tb = working.find((t) => t.id === b)?.date || "";
      return ta.localeCompare(tb);
    });
    orderedIds.forEach((id) => {
      const attempt = computeCryptoLedger(working, wallets, accounts, coins);
      if (attempt.linesByTx.has(id)) {
        working = working.map((t) => (t.id === id ? { ...t, posted: true } : t));
        posted.push(id);
      } else {
        failed.push({ id, reason: attempt.errors.get(id) });
      }
    });
    setCryptoTxs(working);
    if (remember) {
      const seen = new Set();
      posted.forEach((id) => {
        const t = working.find((x) => x.id === id);
        const key = `${t.type}|${t.coinId}`;
        if (seen.has(key)) return;
        seen.add(key);
        rememberCryptoLabelRule(t.type, t.coinId, labelId, undefined);
      });
    }
    return { posted, failed };
  }
  // "remember" on a Needs Review row - saves a (type, coin) -> account rule
  // so future CSV imports of the same kind resolve automatically instead of
  // needing review again. A newer rule for the same (type, coin) replaces
  // the old one.
  // counterparty is optional - omitted, this saves the old-style wildcard
  // rule (matches every counterparty for this type+coin); provided, it
  // saves a more specific rule that only fires for that exact counterparty
  // and is tried first (see applyCryptoRule).
  function rememberCryptoRule(type, coinId, ledgerAccountId, counterparty) {
    setCryptoRules((prev) => [
      ...prev.filter((r) => !(r.type === type && r.coinId === coinId && r.counterparty === counterparty)),
      { id: uid("crule"), type, coinId, ledgerAccountId, counterparty },
    ]);
  }
  // Same as rememberCryptoRule but the target is a label (a multi-account
  // contra split) rather than a single account.
  function rememberCryptoLabelRule(type, coinId, labelId, counterparty) {
    setCryptoRules((prev) => [
      ...prev.filter((r) => !(r.type === type && r.coinId === coinId && r.counterparty === counterparty)),
      { id: uid("crule"), type, coinId, labelId, counterparty },
    ]);
  }
  // Auto-mapping rule: map every transaction matching a set of filter conditions
  // to a label. Applied to existing unmapped drafts (via the effect below) and to
  // future imports (applyCryptoRule). Replaces any rule with the same conditions.
  function addAutoMapRule(conditions, labelId, filterName) {
    const clean = (conditions || []).filter((c) => c.value !== undefined && c.value !== "");
    if (!clean.length || !labelId) return;
    const key = JSON.stringify(clean);
    setCryptoRules((prev) => [
      ...prev.filter((r) => !(Array.isArray(r.conditions) && JSON.stringify(r.conditions) === key)),
      { id: uid("crule"), conditions: clean, labelId, filterName },
    ]);
  }
  function deleteCryptoRule(id) {
    setCryptoRules((prev) => prev.filter((r) => r.id !== id));
  }
  // Apply condition-based auto-map rules to unmapped, unposted drafts. Only fills
  // rows that have no label/account yet, so it never overrides a manual choice
  // and (being idempotent) never loops.
  useEffect(() => {
    if (!ready) return;
    const condRules = cryptoRules.filter((r) => Array.isArray(r.conditions) && r.conditions.length && r.labelId);
    if (!condRules.length) return;
    setCryptoTxs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        // Skip anything already fully resolved or posted.
        if (t.posted || t.ledgerAccountId || (t.ledgerLegs && t.ledgerLegs.length) || (t.type === "Transfer" && t.toWalletId)) return t;
        // Use an already-assigned rule label, or find a rule matching this row.
        let labelId = t.matchedLabelId;
        if (!labelId) {
          const rule = condRules.find((r) => matchesCryptoFilter(t, r.conditions, { coins, wallets }));
          if (rule) labelId = rule.labelId;
        }
        if (!labelId) return t;
        const label = cryptoLabels.find((l) => l.id === labelId && l.status !== "inactive");
        if (!label) return t;
        const patch = labelPatchFor(t, label, wallets, coins);
        if (patch) { changed = true; return { ...t, ...patch, matchedByRule: true }; }
        // Legs couldn't resolve. If the blocker is just a missing price (value
        // not known yet - common for gas fees), still assign the label so the row
        // shows as mapped; the legs resolve here automatically once the price
        // lands (via the rate backfill). If value is known but the label doesn't
        // fit the row's direction, leave it for manual handling.
        const valueKnown = coinValue(t.quantity, t.perCoinPrice) > 0;
        if (!valueKnown && t.matchedLabelId !== labelId) { changed = true; return { ...t, matchedLabelId: labelId, matchedByRule: true }; }
        return t;
      });
      return changed ? next : prev;
    });
  }, [cryptoRules, cryptoTxs, cryptoLabels, coins, wallets, ready]);

  // Attach the flat withdrawal fee (from the schedule) to any unposted client
  // withdrawal carrying a fee-bearing label, so the engine carves it out and
  // books it to fee revenue. Clears it if the label/schedule no longer applies.
  useEffect(() => {
    if (!ready) return;
    const feeLabelIds = new Set(cryptoLabels.filter((l) => l.withdrawFeeRevenue).map((l) => l.id));
    setCryptoTxs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.posted || t.type !== "Withdrawal") return t;
        const label = t.matchedLabelId && feeLabelIds.has(t.matchedLabelId) ? cryptoLabels.find((l) => l.id === t.matchedLabelId) : null;
        const coin = coins.find((c) => c.id === t.coinId);
        const fee = label ? withdrawFeeFor(coin?.symbol, withdrawFees, t.network) : 0;
        const acct = label ? (label.feeAccountId || "acc_410101") : undefined;
        const recvAcct = label ? (label.feeReceivableAccountId || "acc_140101") : undefined;
        if (fee > 0 && acct && recvAcct) {
          if (t.withdrawFeeUnits !== fee || t.withdrawFeeAccountId !== acct || t.withdrawFeeReceivableAccountId !== recvAcct) {
            changed = true; return { ...t, withdrawFeeUnits: fee, withdrawFeeAccountId: acct, withdrawFeeReceivableAccountId: recvAcct };
          }
        } else if (t.withdrawFeeUnits !== undefined) {
          changed = true; const { withdrawFeeUnits, withdrawFeeAccountId, withdrawFeeReceivableAccountId, ...rest } = t; return rest;
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [cryptoTxs, cryptoLabels, coins, withdrawFees, ready]);

  // Crypto label mapping CRUD (the crypto half of the unified Label Mapping).
  function addCryptoLabel(label) {
    const id = uid("clbl");
    setCryptoLabels((prev) => [...prev, { id, status: "active", ...label }]);
    return id;
  }
  function updateCryptoLabel(id, patch) {
    setCryptoLabels((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function deleteCryptoLabel(id) {
    setCryptoLabels((prev) => prev.filter((l) => l.id !== id));
    setCryptoRules((prev) => prev.filter((r) => r.labelId !== id));
  }
  // Saved/favorite transaction filters.
  function addCryptoFilter(name, conditions) {
    const id = uid("cflt");
    setCryptoFilters((prev) => [...prev, { id, name, conditions }]);
    return id;
  }
  function deleteCryptoFilter(id) {
    setCryptoFilters((prev) => prev.filter((f) => f.id !== id));
  }
  function loadSampleCryptoTxs() {
    const sample = makeSampleCryptoTxs(wallets, coins, accounts);
    setCryptoTxs((prev) => [...prev, ...sample.map((tx) => ({ ...tx, id: uid("ctx"), posted: false }))]);
    return sample.length;
  }
  // Posted crypto transactions can't be deleted - later transactions may
  // have consumed the cost-basis lots they created, so removing one after
  // the fact would silently corrupt everyone downstream's FIFO history.
  function deleteCryptoTx(id) {
    const target = cryptoTxs.find((t) => t.id === id);
    if (target && isLocked(target.date)) return;
    setCryptoTxs((prev) => prev.filter((t) => t.id !== id || t.posted));
  }
  // Attempts every draft together with what's already posted, in date order,
  // via the same FIFO engine the live ledger uses - so "will this build?"
  // is answered by actually running it, not a separate approximation. Drafts
  // that come up short (e.g. not enough recorded cost basis yet) are left as
  // drafts with their real reason, never force-posted.
  function buildJournals() {
    const attempt = computeCryptoLedger(cryptoTxs, wallets, accounts, coins);
    setCryptoTxs((prev) =>
      prev.map((t) => (!t.posted && !isLocked(t.date) && attempt.linesByTx.has(t.id) ? { ...t, posted: true } : t))
    );
  }
  // Post a specific set of already-resolved (ready-to-build) drafts at once -
  // the "Post all" action on the Ready to build list. Same guards as
  // buildJournals: never posts an unresolved row or one in a locked period.
  function postResolvedDrafts(ids) {
    const idSet = new Set(ids);
    const attempt = computeCryptoLedger(cryptoTxs, wallets, accounts, coins);
    setCryptoTxs((prev) =>
      prev.map((t) => (idSet.has(t.id) && !t.posted && !isLocked(t.date) && attempt.linesByTx.has(t.id) ? { ...t, posted: true } : t))
    );
  }
  // Book a period-end revaluation. Kept sequential (a new one must be dated
  // after the latest existing one) so the incremental "target minus already
  // booked" math stays sound, and blocked inside a locked period.
  function bookRevaluation(date, markPrices) {
    if (isLocked(date)) return { ok: false, reason: `Period is locked through ${lockDate}.` };
    const latest = revaluations.reduce((m, r) => (r.date > m ? r.date : m), "");
    if (latest && date <= latest) return { ok: false, reason: `A revaluation already exists on or after ${date} (latest ${latest}). Pick a later date.` };
    const { gainAccountId, lossAccountId } = resolveUnrealizedAccounts(accounts);
    if (!gainAccountId || !lossAccountId) return { ok: false, reason: "No unrealised gain/loss accounts in the Chart of Accounts." };
    const lines = computeRevaluation(cryptoTxs, wallets, accounts, coins, revaluations, date, markPrices)
      .filter((ln) => Math.abs(ln.adjustment) >= 0.005);
    if (lines.length === 0) return { ok: false, reason: "Nothing to revalue - holdings already carry at these marks." };
    const total = lines.reduce((s, ln) => s + ln.adjustment, 0);
    setRevaluations((prev) => [...prev, { id: uid("reval"), date, lines }]);
    return { ok: true, total, count: lines.length };
  }
  // Only the most recent revaluation can be removed (earlier ones are the
  // baseline later ones were computed against), and never one in a locked
  // period.
  function deleteRevaluation(id) {
    const target = revaluations.find((r) => r.id === id);
    if (!target) return;
    const latest = revaluations.reduce((m, r) => (r.date > m ? r.date : m), "");
    if (target.date !== latest) return;
    if (isLocked(target.date)) return;
    setRevaluations((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <div
      // Full viewport height at every screen size - not a fixed pixel value
      // capped by vh - so the app's proportions stay consistent whether it's
      // a small window or a large monitor, instead of the old h-[720px]
      // getting cropped by max-h-[85vh] at some sizes and leaving dead space
      // at others. Sidebar stays a fixed-width column beside the content at
      // every width (see below) - it doesn't reflow into a top bar.
      className="flex h-screen w-full bg-stone-100 text-black rounded-xl overflow-hidden border border-stone-300"
      style={{ fontFamily: '"Open Runde", -apple-system, BlinkMacSystemFont, "SF Pro Rounded", "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}
    >
      {/* Money Buddy's brand typeface - a rounded variant of Inter, loaded
          straight from its GitHub source via jsDelivr so nothing needs to be
          installed locally. Falls back to the system's rounded/sans stack
          (set on the wrapper's inline style above) until it loads. */}
      <style>{`
        @font-face { font-family: "Open Runde"; src: url("https://cdn.jsdelivr.net/gh/lauridskern/open-runde@1.0.1/src/web/OpenRunde-Regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: "Open Runde"; src: url("https://cdn.jsdelivr.net/gh/lauridskern/open-runde@1.0.1/src/web/OpenRunde-Medium.woff2") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
        @font-face { font-family: "Open Runde"; src: url("https://cdn.jsdelivr.net/gh/lauridskern/open-runde@1.0.1/src/web/OpenRunde-Semibold.woff2") format("woff2"); font-weight: 600; font-style: normal; font-display: swap; }
        @font-face { font-family: "Open Runde"; src: url("https://cdn.jsdelivr.net/gh/lauridskern/open-runde@1.0.1/src/web/OpenRunde-Bold.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
      `}</style>
      {/* Sidebar - always a fixed-width vertical rail with a full vertical
          list of labeled tabs, at every screen size. Its own overflow-y-auto
          (below) lets the tab list scroll internally if the window gets
          short, instead of reflowing into a different layout. */}
      <div className="w-56 shrink-0 bg-black text-slate-300 flex flex-col">
        <div className="px-5 pt-5 pb-4 border-b border-slate-700/60">
          <div className="font-bold text-2xl text-white tracking-tight">
            Primmy's <span className="text-[#03D47C]">Ledger</span>
          </div>
          <div className="text-[11px] uppercase tracking-widest text-slate-500 mt-0.5">{t("tagline")}</div>
        </div>
        {/* Tenant switcher - each tenant is a fully separate set of books
            (own accounts, journal, everything); switching just remounts
            this whole component under a different tenant id (see the outer
            App component), the same way SoftLedger's "Select a Tenant"
            modal drops you into a different company entirely. */}
        <div className="px-5 py-3 border-b border-slate-700/60">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1.5">{t("tenant_label")}</div>
          <select
            value={tenantId}
            onChange={(e) => onSwitchTenant(e.target.value)}
            className="w-full bg-white/5 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
          >
            {tenants.map((tn) => <option key={tn.id} value={tn.id} className="text-black">{tn.name}</option>)}
          </select>
          <button onClick={onManageTenants} className="text-xs text-slate-500 hover:text-slate-300 mt-1.5 flex items-center gap-1">
            <Building2 size={12} /> {t("tenant_manage")}
          </button>
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.labelKey} className="mb-1">
              <div className="px-5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                {t(group.labelKey)}
              </div>
              {group.items.map((n) => {
                const Icon = n.icon;
                const active = tab === n.key;
                return (
                  <button
                    key={n.key}
                    onClick={() => setTab(n.key)}
                    className={`w-full flex items-center gap-2.5 px-5 py-2.5 text-sm text-left border-l-2 transition-colors ${
                      active
                        ? "border-[#03D47C] bg-[#03D47C]/10 text-[#03D47C]"
                        : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5"
                    }`}
                  >
                    <Icon size={16} />
                    {t(n.labelKey)}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-700/60">
          <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium ${
            balanced ? "bg-[#03D47C]/10 text-[#03D47C]" : "bg-[#EF4444]/10 text-[#EF4444]"
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${balanced ? "bg-[#03D47C] animate-pulse" : "bg-[#EF4444]"}`} />
            {balanced ? t("ledger_balanced") : t("ledger_outOfBalance")}
          </div>
        </div>
      </div>

      {/* Main - min-h-0/min-w-0 keep this the scrollable child in the flex
          shell (a flex item's default min-size is its content size, which
          would otherwise let a wide table or a tall list push the sidebar
          off-screen instead of scrolling internally). */}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
        {tab === "coa" && (
          <ChartOfAccounts
            accounts={accounts}
            journal={journal}
            onAdd={addAccount}
            onBulkAdd={addAccountsBulk}
            onUpdate={updateAccount}
            onDelete={deleteAccount}
          />
        )}
        {tab === "bankTx" && (
          <BankTransactions
            bankAccounts={bankAccounts}
            accounts={accounts}
            onImport={importCsv}
            onUpdateAccount={updateAccount}
            fileRef={fileRef}
            transactions={transactions}
            rules={rules}
            setTransactions={setTransactions}
            setRules={setRules}
            isLocked={isLocked}
            lockDate={lockDate}
          />
        )}
        {tab === "types" && (
          <TransactionTypes
            accounts={accounts}
            cryptoLabels={cryptoLabels}
            onAddCryptoLabel={addCryptoLabel}
            onUpdateCryptoLabel={updateCryptoLabel}
            onDeleteCryptoLabel={deleteCryptoLabel}
            cryptoRules={cryptoRules}
            cryptoFilters={cryptoFilters}
            coins={coins}
            wallets={wallets}
            onAddRule={addAutoMapRule}
            onDeleteRule={deleteCryptoRule}
          />
        )}
        {hasCrypto && tab === "coins" && (
          <CoinsScreen coins={coins} onAdd={addCoin} onUpdateRate={updateCoinRate} onRefreshRates={refreshLiveRates} cryptoTxs={cryptoTxs} wallets={wallets} accounts={accounts} />
        )}
        {hasCrypto && tab === "wallets" && (
          <WalletsScreen wallets={wallets} accounts={accounts} onAdd={addWallet} onUpdate={updateWallet} onDelete={deleteWallet} />
        )}
        {hasCrypto && tab === "gasTanks" && (
          <GasTanksScreen
            gasTanks={gasTanks} wallets={wallets}
            onAdd={addGasTank} onUpdate={updateGasTank} onRemove={removeGasTank}
            onSync={syncGasTanks}
          />
        )}
        {hasCrypto && tab === "cryptoTx" && (
          <CryptoTransactions
            cryptoTxs={cryptoTxs}
            coins={coins}
            wallets={wallets}
            accounts={accounts}
            cryptoLedger={cryptoLedger}
            cryptoRules={cryptoRules}
            cryptoLabels={cryptoLabels}
            cryptoFilters={cryptoFilters}
            onAddFilter={addCryptoFilter}
            onDeleteFilter={deleteCryptoFilter}
            walletLabelRules={walletLabelRules}
            onAdd={addCryptoTx}
            onUpdate={updateCryptoTx}
            onDelete={deleteCryptoTx}
            onBuildJournals={buildJournals}
            onPostReady={postResolvedDrafts}
            onLoadSample={loadSampleCryptoTxs}
            onImportCsv={importCryptoCsvHandler}
            onPostOne={postCryptoTx}
            onBulkPost={bulkPostCryptoTxs}
            onBulkLabelPost={bulkLabelAndPost}
            onRemember={rememberCryptoRule}
            onRememberLabel={rememberCryptoLabelRule}
            onAutoMapFilter={addAutoMapRule}
          />
        )}
        {hasCrypto && tab === "revaluation" && (
          <RevaluationScreen
            cryptoTxs={cryptoTxs}
            wallets={wallets}
            accounts={accounts}
            coins={coins}
            revaluations={revaluations}
            lockDate={lockDate}
            isLocked={isLocked}
            onBook={bookRevaluation}
            onDelete={deleteRevaluation}
            onFetchDatedPrices={fetchDatedCoinPrices}
          />
        )}
        {tab === "ledger" && <LedgerView accounts={accounts} journal={journal} focusAccountId={ledgerFocusAccountId} />}
        {tab === "reports" && <Reports accounts={accounts} journal={journal} entities={activeEntities} onSeeMovements={goToLedger} />}
        {tab === "analytics" && (
          <Analytics
            accounts={accounts}
            journal={journal}
            entities={activeEntities}
            allEntities={entities}
            onAddEntity={addEntity}
            onUpdateEntity={updateEntity}
            onDeleteEntity={deleteEntity}
          />
        )}
        {tab === "ledgerSync" && (
          <LedgerConnectionScreen
            accounts={accounts}
            journal={journal}
            onImportOpeningBalances={importOpeningBalances}
          />
        )}
        {tab === "settings" && <SettingsScreen lockDate={lockDate} onSetLock={setLockDate} explorerKeys={explorerKeys} onSetKeys={setExplorerKeys}
          withdrawFees={withdrawFees} coins={coins} onAddWithdrawFee={addWithdrawFee} onUpdateWithdrawFee={updateWithdrawFee} onRemoveWithdrawFee={removeWithdrawFee} hasCrypto={hasCrypto} />}
      </div>
    </div>
  );
}

// `seed` picks which starter data set (see seedDataForTenant above) a
// tenant opens onto the first time it's ever loaded. Only the original
// Money Buddy tenant gets the real, hand-built COA - everything added
// later starts from the minimal generic template instead. `hasCrypto`
// controls whether the Coins/Wallets/Crypto Transactions nav group (and
// everything under it) shows up at all for that tenant - a company with no
// crypto activity shouldn't have to look at three tabs that don't apply.
const DEFAULT_TENANTS = [
  { id: "tenant_hc", name: "Money Buddy KH Co., Ltd", seed: "moneybuddy", hasCrypto: true },
];

// ---------- Multi-tenant shell ----------

// Top-level: which separate company's books are we looking at. This is a
// different axis from the entities/consolidation inside TenantWorkspace -
// a tenant is a fully separate set of books (own accounts, own journal,
// nothing shared), the same distinction SoftLedger draws between its
// tenant switcher and its per-tenant Location/entity columns. Mounting
// TenantWorkspace with `key={tenantId}` is what actually guarantees
// isolation: React tears down and re-creates all of that component's state
// on every tenant switch, so there's no path for one tenant's data to leak
// into another's render.
export default function App() {
  const [tenants, setTenants] = useState(DEFAULT_TENANTS);
  const [tenantId, setTenantId] = useState(DEFAULT_TENANTS[0].id);
  const [tenantsReady, setTenantsReady] = useState(false);
  const [managingTenants, setManagingTenants] = useState(false);
  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantHasCrypto, setNewTenantHasCrypto] = useState(false);

  // A personal display preference, not part of any tenant's books - one
  // value for the whole app, persisted separately from tenant data so it
  // survives (and stays the same across) every tenant switch.
  const [lang, setLang] = useState("en");
  useEffect(() => {
    (async () => {
      const saved = await loadData(LANGUAGE_STORAGE_KEY);
      if (saved?.lang && TRANSLATIONS[saved.lang]) setLang(saved.lang);
    })();
  }, []);
  useEffect(() => {
    saveData(LANGUAGE_STORAGE_KEY, { lang });
  }, [lang]);
  const langCtx = useMemo(() => ({ lang, t: (key) => translate(lang, key), setLang }), [lang]);

  useEffect(() => {
    (async () => {
      const saved = await loadData(TENANTS_STORAGE_KEY);
      if (saved?.tenants?.length) {
        setTenants(saved.tenants);
        setTenantId(saved.currentTenantId && saved.tenants.some((t) => t.id === saved.currentTenantId) ? saved.currentTenantId : saved.tenants[0].id);
      }
      setTenantsReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!tenantsReady) return;
    saveData(TENANTS_STORAGE_KEY, { tenants, currentTenantId: tenantId });
  }, [tenants, tenantId, tenantsReady]);

  function addTenant() {
    const name = newTenantName.trim();
    if (!name) return;
    const id = uid("tenant");
    setTenants((prev) => [...prev, { id, name, seed: "blank", hasCrypto: newTenantHasCrypto }]);
    setTenantId(id);
    setNewTenantName("");
    setNewTenantHasCrypto(false);
    setManagingTenants(false);
  }

  function renameTenant(id, name) {
    setTenants((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }

  function toggleTenantHasCrypto(id, hasCrypto) {
    setTenants((prev) => prev.map((t) => (t.id === id ? { ...t, hasCrypto } : t)));
  }

  // Clears one tenant's saved books back to its seed template - mainly to
  // recover a tenant that was created before a seeding fix and got the
  // wrong starter data saved to its own storage key (loadData would
  // otherwise keep finding that bad save and never fall back to the
  // corrected seed). If the tenant being reset is the one on screen, the
  // resetNonce bump changes TenantWorkspace's key, forcing React to tear it
  // down and remount fresh - same mechanism a tenant switch already uses.
  const [resetNonce, setResetNonce] = useState(0);
  async function resetTenantData(id) {
    if (!window.confirm("Clear this tenant's saved accounts and transactions and start over from its seed template? This can't be undone.")) return;
    await saveData(`${STORAGE_KEY}-${id}`, null);
    if (id === tenantId) setResetNonce((n) => n + 1);
  }

  if (!tenantsReady) return null;
  const currentTenant = tenants.find((t) => t.id === tenantId) || tenants[0];
  const t = langCtx.t;

  return (
    <LanguageContext.Provider value={langCtx}>
      <TenantWorkspace
        key={`${tenantId}-${resetNonce}`}
        tenantId={currentTenant.id}
        tenantName={currentTenant.name}
        tenants={tenants}
        seed={currentTenant.seed || "blank"}
        hasCrypto={!!currentTenant.hasCrypto}
        onSwitchTenant={setTenantId}
        onManageTenants={() => setManagingTenants(true)}
      />
      {managingTenants && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setManagingTenants(false)}>
          <div className="bg-white rounded-lg shadow-lg p-5 w-96" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-black mb-3 flex items-center gap-1.5"><Building2 size={15} /> {t("tenant_modalTitle")}</h2>
            <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {tenants.map((tn) => (
                <div key={tn.id} className="border border-stone-200 rounded px-2 py-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <input
                      value={tn.name}
                      onChange={(e) => renameTenant(tn.id, e.target.value)}
                      className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm"
                    />
                    <button
                      onClick={() => resetTenantData(tn.id)}
                      title="Clear this tenant's saved data and start over from its seed template"
                      className="text-xs text-slate-400 hover:text-[#EF4444] px-1.5 shrink-0"
                    >
                      {t("common_reset")}
                    </button>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 px-0.5">
                    <input
                      type="checkbox"
                      checked={!!tn.hasCrypto}
                      onChange={(e) => toggleTenantHasCrypto(tn.id, e.target.checked)}
                    />
                    {t("tenant_hasCrypto")}
                  </label>
                </div>
              ))}
            </div>
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-1.5">
                <input
                  value={newTenantName}
                  onChange={(e) => setNewTenantName(e.target.value)}
                  placeholder={t("tenant_newNamePlaceholder")}
                  className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm"
                />
                <button onClick={addTenant} disabled={!newTenantName.trim()}
                  className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full shrink-0">
                  {t("common_add")}
                </button>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 px-0.5">
                <input type="checkbox" checked={newTenantHasCrypto} onChange={(e) => setNewTenantHasCrypto(e.target.checked)} />
                {t("tenant_hasCrypto")}
              </label>
            </div>
            <button onClick={() => setManagingTenants(false)} className="text-xs text-slate-500 underline">{t("tenant_close")}</button>
          </div>
        </div>
      )}
    </LanguageContext.Provider>
  );
}

// ---------- Chart of Accounts ----------

function ChartOfAccounts({ accounts, journal, onAdd, onBulkAdd, onUpdate, onDelete }) {
  const { t } = useLang();
  const [form, setForm] = useState({ code: "", name: "", type: "Expense", isBank: false, cf: undefined });
  const [similarId, setSimilarId] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [bulkResult, setBulkResult] = useState(null);
  const bulkFileRef = useRef(null);
  // One row editable at a time - a copy of that account's fields, only
  // written back (via onUpdate) on Save; Cancel just drops the copy.
  // Balance itself is never edited here - it's derived from the journal,
  // not a stored fact on the account.
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [editError, setEditError] = useState("");

  const showsCf = ["Asset", "Liability", "Equity"].includes(form.type);
  const similarOptions = accounts.filter((a) => a.type === form.type).sort((a, b) => a.code.localeCompare(b.code));

  useEffect(() => {
    setForm((f) => ({
      ...f,
      code: suggestAccountCodeSmart(f.name, f.type, similarId, accounts),
      cf: ["Asset", "Liability", "Equity"].includes(f.type) ? defaultCf(f.type) : undefined,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.type, form.name, similarId]);

  function resetForm(type) {
    setSimilarId("");
    setForm({ code: suggestAccountCode(type, accounts), name: "", type, isBank: false, cf: showsCf ? defaultCf(type) : undefined });
  }

  function startEditAccount(a) {
    setEditingId(a.id);
    setEditForm({ code: a.code, name: a.name, type: a.type, isBank: !!a.isBank, cf: a.cf });
    setEditError("");
  }
  function cancelEditAccount() {
    setEditingId(null);
    setEditForm(null);
    setEditError("");
  }
  function saveEditAccount() {
    if (!editForm.name.trim() || !editForm.code.trim()) { setEditError("Code and name are both required."); return; }
    if (accounts.some((a) => a.id !== editingId && a.code === editForm.code.trim())) {
      setEditError(`Code ${editForm.code.trim()} is already used by another account.`);
      return;
    }
    const showsCfEdit = ["Asset", "Liability", "Equity"].includes(editForm.type);
    onUpdate(editingId, {
      code: editForm.code.trim(),
      name: editForm.name.trim(),
      type: editForm.type,
      isBank: editForm.type === "Asset" ? editForm.isBank : false,
      cf: showsCfEdit ? (editForm.cf || defaultCf(editForm.type)) : undefined,
    });
    setEditingId(null);
    setEditForm(null);
    setEditError("");
  }

  // Parses a client's existing account list (code, name, type, and
  // optionally isBank/cf) into rows ready for the preview table below.
  // Loosely accepts whatever header casing/wording shows up in a real
  // export - same aliasing pattern used everywhere else this app parses a
  // CSV. Every row is checked against both the accounts already in this
  // ledger and every other row already seen in this same paste, so a
  // duplicate code is caught wherever it comes from.
  function parseBulkRows(text) {
    const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    const existingCodes = new Set(accounts.map((a) => a.code));
    const seenInBatch = new Set();
    return parsed.data.map((row) => {
      const code = String(row.code ?? row.Code ?? row.AccountCode ?? "").trim();
      const name = String(row.name ?? row.Name ?? row.AccountName ?? "").trim();
      const rawType = String(row.type ?? row.Type ?? row.AccountType ?? "").trim();
      const type = TYPES.find((t) => t.toLowerCase() === rawType.toLowerCase()) || "";
      const isBankRaw = String(row.isBank ?? row.IsBank ?? row["Is Bank"] ?? "").trim().toLowerCase();
      const isBank = ["true", "yes", "1", "y"].includes(isBankRaw);
      const cfRaw = String(row.cf ?? row.CF ?? row.CashFlow ?? row["Cash Flow"] ?? "").trim().toLowerCase();
      const cf = ["cash", "operating", "investing", "financing"].includes(cfRaw)
        ? cfRaw
        : (["Asset", "Liability", "Equity"].includes(type) ? defaultCf(type) : undefined);

      let issue = "";
      if (!code || !name || !type) issue = "Missing code, name, or a valid type.";
      else if (existingCodes.has(code)) issue = "Code already exists in this ledger.";
      else if (seenInBatch.has(code)) issue = "Duplicate code within this import.";
      if (!issue) seenInBatch.add(code);

      return { code, name, type, isBank, cf, issue };
    });
  }
  const bulkRows = bulkText.trim() ? parseBulkRows(bulkText) : [];
  const bulkValid = bulkRows.filter((r) => !r.issue);

  function handleBulkFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setBulkText(String(ev.target.result || "")); setBulkResult(null); setBulkError(""); };
    reader.readAsText(file);
  }

  function runBulkImport() {
    if (bulkValid.length === 0) { setBulkError("No valid rows to import."); return; }
    const added = onBulkAdd(bulkValid.map(({ issue, ...rest }) => rest));
    setBulkResult(added);
    setBulkText("");
    setBulkError("");
    if (bulkFileRef.current) bulkFileRef.current.value = "";
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_coa")}</h1>
      <p className="text-sm text-slate-500 mb-5">{t("subtitle_coa")}</p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-6 shadow-sm">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-3">Add account</div>
        <div className="flex flex-wrap gap-3 items-end mb-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-slate-500 mb-1">Base code on (only needed if the name alone isn't enough)</label>
            <select value={similarId} onChange={(e) => setSimilarId(e.target.value)}
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm">
              <option value="">- let the name decide -</option>
              {similarOptions.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-400 -mt-2 mb-3">
          The code is suggested from the account name first: naming a new venue/bank the same way as an existing one (e.g. "MEXC spot - Company #Crypto" next to "Binance spot - Company #Crypto") opens a new subgroup automatically, while reusing a venue that already exists just adds the next slot in its subgroup. "Base code on" only matters when the name doesn't match an existing pattern.
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Code</label>
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })}
              className="w-24 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-500 mb-1">Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Marketing Expense"
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Type</label>
            <select value={form.type} onChange={(e) => { setSimilarId(""); setForm({ ...form, type: e.target.value }); }}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm">
              {TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          {showsCf && (
            <div>
              <label className="block text-xs text-slate-500 mb-1">Cash flow</label>
              <select value={form.cf} onChange={(e) => setForm({ ...form, cf: e.target.value })}
                className="border border-stone-300 rounded px-2 py-1.5 text-sm">
                <option value="cash">Cash equivalent</option>
                <option value="operating">Operating</option>
                <option value="investing">Investing</option>
                <option value="financing">Financing</option>
              </select>
            </div>
          )}
          {form.type === "Asset" && (
            <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2">
              <input type="checkbox" checked={form.isBank} onChange={(e) => setForm({ ...form, isBank: e.target.checked })} />
              Bank account
            </label>
          )}
          <button
            onClick={() => { if (form.name.trim()) { onAdd(form); resetForm(form.type); } }}
            className="flex items-center gap-1.5 bg-black hover:bg-[#4D4D4D] text-white text-sm px-3 py-1.5 rounded-full"
          >
            <Plus size={14} /> {t("common_add")}
          </button>
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-6 shadow-sm">
        <button onClick={() => { setBulkOpen((v) => !v); setBulkResult(null); setBulkError(""); }}
          className="w-full flex items-center justify-between text-left">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
            <FileUp size={13} /> Bulk import existing accounts
          </span>
          <span className="text-xs text-slate-400">{bulkOpen ? "Hide" : "Show"}</span>
        </button>

        {bulkOpen && (
          <div className="mt-3">
            <p className="text-xs text-slate-400 mb-3">
              Paste or upload a client's existing account list as CSV - columns <span className="font-mono">code, name, type</span>,
              and optionally <span className="font-mono">isBank, cf</span>. This only creates the accounts themselves (no balances,
              no journal entry) - to bring in opening balances too, use Ledger Connection instead.
            </p>
            <div className="flex items-center gap-2 mb-3">
              <input ref={bulkFileRef} type="file" accept=".csv,text/csv" onChange={handleBulkFile} className="text-xs" />
            </div>
            <textarea
              value={bulkText}
              onChange={(e) => { setBulkText(e.target.value); setBulkResult(null); setBulkError(""); }}
              rows={5}
              placeholder="code,name,type,isBank,cf&#10;101201,Cash - Second Bank,Asset,true,cash"
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono mb-3"
            />

            {bulkError && <div className="text-xs text-[#EF4444] mb-3 flex items-center gap-1"><AlertTriangle size={13} />{bulkError}</div>}

            {bulkRows.length > 0 && (
              <div className="border border-stone-200 rounded mb-3 overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-400 border-b border-stone-200 sticky top-0 bg-white">
                      <th className="text-left px-2 py-1.5 font-medium">Code</th>
                      <th className="text-left px-2 py-1.5 font-medium">Name</th>
                      <th className="text-left px-2 py-1.5 font-medium">Type</th>
                      <th className="text-left px-2 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((r, i) => (
                      <tr key={i} className={`border-b border-stone-100 last:border-0 ${r.issue ? "text-slate-400" : ""}`}>
                        <td className="px-2 py-1.5 font-mono">{r.code || "-"}</td>
                        <td className="px-2 py-1.5">{r.name || "-"}</td>
                        <td className="px-2 py-1.5">{r.type || "-"}</td>
                        <td className={`px-2 py-1.5 ${r.issue ? "text-[#EF4444]" : "text-[#02B169]"}`}>{r.issue || "will import"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <button onClick={runBulkImport} disabled={bulkValid.length === 0}
              className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
              Import {bulkValid.length} account{bulkValid.length === 1 ? "" : "s"}
            </button>

            {bulkResult != null && (
              <div className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                <CheckCircle2 size={13} className="text-[#03D47C]" /> Added {bulkResult} account{bulkResult === 1 ? "" : "s"}.
              </div>
            )}
          </div>
        )}
      </div>

      {TYPES.map((type) => {
        const rows = accounts.filter((a) => a.type === type).sort((a, b) => a.code.localeCompare(b.code));
        if (!rows.length) return null;
        const subtotal = rows.reduce((s, a) => s + balanceFor(a.id, journal, accounts), 0);
        return (
          <div key={type} className="mb-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">{type}</div>
            <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((a) => {
                    if (editingId === a.id) {
                      const showsCfEdit = ["Asset", "Liability", "Equity"].includes(editForm.type);
                      return (
                        <tr key={a.id} className="border-b border-stone-100 last:border-0 bg-[#E6FBF1]/30">
                          <td className="px-3 py-1.5 align-top">
                            <input value={editForm.code} onChange={(e) => setEditForm({ ...editForm, code: e.target.value })}
                              className="w-16 border border-stone-300 rounded px-2 py-1 text-xs font-mono" />
                          </td>
                          <td className="px-3 py-1.5 align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                className="flex-1 min-w-[160px] border border-stone-300 rounded px-2 py-1 text-sm" />
                              <select value={editForm.type} onChange={(e) => setEditForm({ ...editForm, type: e.target.value })}
                                className="border border-stone-300 rounded px-1.5 py-1 text-xs">
                                {TYPES.map((t) => <option key={t}>{t}</option>)}
                              </select>
                              {showsCfEdit && (
                                <select value={editForm.cf || defaultCf(editForm.type)} onChange={(e) => setEditForm({ ...editForm, cf: e.target.value })}
                                  className="border border-stone-300 rounded px-1.5 py-1 text-xs">
                                  <option value="cash">Cash equivalent</option>
                                  <option value="operating">Operating</option>
                                  <option value="investing">Investing</option>
                                  <option value="financing">Financing</option>
                                </select>
                              )}
                              {editForm.type === "Asset" && (
                                <label className="flex items-center gap-1 text-xs text-slate-600">
                                  <input type="checkbox" checked={editForm.isBank} onChange={(e) => setEditForm({ ...editForm, isBank: e.target.checked })} />
                                  Bank
                                </label>
                              )}
                            </div>
                            {editError && <div className="text-xs text-[#EF4444] mt-1">{editError}</div>}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-300 align-top">{money(balanceFor(a.id, journal, accounts))}</td>
                          <td className="px-3 py-1.5 w-10 align-top">
                            <div className="flex items-center gap-1.5 justify-end">
                              <button onClick={saveEditAccount} className="text-[#03B469] hover:text-[#02B169]" title="Save">
                                <CheckCircle2 size={15} />
                              </button>
                              <button onClick={cancelEditAccount} className="text-slate-300 hover:text-slate-600" title="Cancel">
                                <XCircle size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={a.id} className="border-b border-stone-100 last:border-0">
                        <td className="px-3 py-2 font-mono text-slate-500 w-16">{a.code}</td>
                        <td className="px-3 py-2">
                          {a.name}
                          {a.isBank && <Landmark size={12} className="inline ml-1.5 text-slate-400 mb-0.5" />}
                          {a.cf && (
                            <span className={`ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                              a.cf === "cash" ? "bg-[#E6FBF1] text-[#02B169]" : "bg-stone-100 text-stone-500"
                            }`}>
                              {CF_LABELS[a.cf]}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{money(balanceFor(a.id, journal, accounts))}</td>
                        <td className="px-3 py-2 w-16 text-right">
                          <div className="flex items-center gap-2 justify-end">
                            <button onClick={() => startEditAccount(a)} className="text-slate-300 hover:text-slate-600" title="Edit">
                              <Pencil size={13} />
                            </button>
                            <button onClick={() => onDelete(a.id)}
                              disabled={journal.some((j) => j.accountId === a.id)}
                              title={journal.some((j) => j.accountId === a.id) ? "Has transaction history" : "Delete"}
                              className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-stone-50">
                    <td colSpan={2} className="px-3 py-1.5 text-xs text-slate-400">Subtotal</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-500">{money(subtotal)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Bank Transactions (Import + Categorize, tabbed like Crypto Transactions) ----------

function BankTransactions({ bankAccounts, accounts, onImport, onUpdateAccount, fileRef, transactions, rules, setTransactions, setRules, isLocked, lockDate }) {
  const { t } = useLang();
  const [subTab, setSubTab] = useState("import");

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_bankTx")}</h1>
      <p className="text-sm text-slate-500 mb-5">{t("subtitle_bankTx")}</p>

      <div className="flex gap-1 mb-4 border-b border-stone-200">
        {[["import", "Import"], ["transactions", "Transactions"]].map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${subTab === k ? "border-[#03D47C] text-[#02B169] font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {subTab === "import" && (
        <ImportScreen
          bankAccounts={bankAccounts}
          accounts={accounts}
          onImport={onImport}
          onUpdateAccount={onUpdateAccount}
          fileRef={fileRef}
        />
      )}
      {subTab === "transactions" && (
        <Categorize
          transactions={transactions}
          accounts={accounts}
          rules={rules}
          setTransactions={setTransactions}
          setRules={setRules}
          isLocked={isLocked}
          lockDate={lockDate}
        />
      )}
    </div>
  );
}

// ---------- Import ----------

function ImportScreen({ bankAccounts, accounts, onImport, onUpdateAccount, fileRef }) {
  const { t } = useLang();
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id || "");
  const [csvText, setCsvText] = useState("");
  const [result, setResult] = useState(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [candidateId, setCandidateId] = useState("");

  // Accounts that exist in the COA as Assets but aren't yet wired up as an
  // import target - the ones this dropdown lets you promote to "bank account".
  const candidates = accounts.filter((a) => a.type === "Asset" && !a.isBank);

  useEffect(() => {
    if (!bankAccountId && bankAccounts[0]) setBankAccountId(bankAccounts[0].id);
  }, [bankAccounts, bankAccountId]);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ""));
    reader.readAsText(file);
  }

  function startAddingAccount() {
    setCandidateId(candidates[0]?.id || "");
    setAddingAccount(true);
  }
  function submitExistingAccount() {
    if (!candidateId) return;
    onUpdateAccount(candidateId, { isBank: true });
    setBankAccountId(candidateId);
    setAddingAccount(false);
  }

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-slate-500 mb-5">
        CSV with <span className="font-mono">Date, Description, Amount</span> columns. Duplicates (same date + amount + description) are skipped automatically.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm">
        <div className="flex items-end gap-3 mb-1">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Import into</label>
            <div className="w-64">
              <AccountSelect accounts={bankAccounts} value={bankAccountId} onChange={setBankAccountId} />
            </div>
          </div>
          {!addingAccount && (
            <button onClick={startAddingAccount}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 pb-2">
              <Plus size={13} /> Add existing account
            </button>
          )}
        </div>

        {addingAccount && (
          <div className="flex items-end gap-2 mb-3 mt-2 p-3 bg-stone-50 border border-stone-200 rounded">
            {candidates.length === 0 ? (
              <div className="text-xs text-slate-400 py-1">
                Every Asset account is already an import target. Add a new one in Chart of Accounts first.
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-xs text-slate-500 mb-1">Account (from Chart of Accounts)</label>
                  <AccountSelect accounts={candidates} value={candidateId} onChange={setCandidateId} className="w-full border border-stone-300 rounded px-2 py-1.5 text-xs" />
                </div>
                <button onClick={submitExistingAccount}
                  className="flex items-center gap-1 bg-black hover:bg-[#4D4D4D] text-white text-xs px-2.5 py-1.5 rounded-full shrink-0">
                  <Plus size={12} /> Add
                </button>
              </>
            )}
            <button onClick={() => setAddingAccount(false)}
              className="text-xs border border-stone-300 px-2.5 py-1.5 rounded hover:bg-white shrink-0">
              Cancel
            </button>
          </div>
        )}

        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder="Paste CSV here..."
          rows={8}
          className="w-full border border-stone-300 rounded px-3 py-2 text-sm font-mono mb-3 mt-3"
        />

        <div className="flex items-center gap-2 mb-4">
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" id="csv-file" />
          <label htmlFor="csv-file" className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 cursor-pointer hover:bg-stone-50">
            <FileUp size={14} /> Upload CSV file
          </label>
          <button onClick={() => setCsvText(SAMPLE_CSV)} className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 hover:bg-stone-50">
            <Sparkles size={14} /> Load sample data
          </button>
          <div className="flex-1" />
          <button
            onClick={() => { if (csvText.trim() && bankAccountId) setResult(onImport(csvText, bankAccountId)); }}
            className="bg-black hover:bg-[#4D4D4D] text-white text-sm px-4 py-1.5 rounded-full"
          >
            Import
          </button>
        </div>

        {result && (
          <div className="text-sm bg-stone-50 border border-stone-200 rounded px-3 py-2">
            Imported <b>{result.added}</b> transaction{result.added === 1 ? "" : "s"}.
            {result.dupes > 0 && <> Skipped <b>{result.dupes}</b> duplicate{result.dupes === 1 ? "" : "s"}.</>}
            {" "}Rule-matched rows were posted automatically - check <b>Categorize</b> for the rest.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Categorize ----------

function Categorize({ transactions, accounts, rules, setTransactions, setRules, isLocked = () => false, lockDate = "" }) {
  // Aliased to `tr` - `t` is already used everywhere below as the loop
  // variable for individual transactions.
  const { t: tr } = useLang();
  const pending = transactions.filter((t) => !t.posted).sort((a, b) => a.date.localeCompare(b.date));
  const posted = transactions.filter((t) => t.posted).sort((a, b) => b.date.localeCompare(a.date));
  // Data-quality health metric - share of imported bank transactions still
  // waiting to be categorized (mirrors Cryptio's "Needs review %" badge).
  const reviewPct = transactions.length ? Math.round((pending.length / transactions.length) * 100) : 0;
  const [choice, setChoice] = useState({});
  const [remember, setRemember] = useState({});
  const [splitMode, setSplitMode] = useState({});
  const [splitRows, setSplitRows] = useState({});

  // If a transaction reappears in the queue already carrying >1 split (e.g. it
  // was posted as a split, then Unposted for a fix), open straight into the
  // split editor pre-filled - don't silently collapse it back to one account.
  useEffect(() => {
    let modeChanged = false, rowsChanged = false;
    const nextMode = { ...splitMode };
    const nextRows = { ...splitRows };
    pending.forEach((t) => {
      if (t.splits && t.splits.length > 1 && !(t.id in nextRows)) {
        nextMode[t.id] = true;
        nextRows[t.id] = t.splits.map((s) => ({ accountId: s.accountId, amount: s.amount }));
        modeChanged = true;
        rowsChanged = true;
      }
    });
    if (modeChanged) setSplitMode(nextMode);
    if (rowsChanged) setSplitRows(nextRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.map((t) => t.id).join(",")]);

  function post(tx) {
    if (isLocked(tx.date)) return; // can't book into a closed period
    const accountId = choice[tx.id] || tx.mappedAccountId;
    if (!accountId) return; // real COA has no generic "other income" bucket - a choice is required
    setTransactions((prev) => prev.map((t) => (t.id === tx.id ? { ...t, mappedAccountId: accountId, splits: null, posted: true } : t)));
    if (remember[tx.id]) {
      setRules((prev) => [...prev, { id: uid("rule"), pattern: tx.description, accountId }]);
    }
  }

  function unpost(tx) {
    if (isLocked(tx.date)) return; // can't reopen a closed period
    setTransactions((prev) => prev.map((t) => (t.id === tx.id ? { ...t, posted: false } : t)));
  }

  function startSplit(t) {
    const currentAccountId = choice[t.id] || t.mappedAccountId || "";
    setSplitMode((prev) => ({ ...prev, [t.id]: true }));
    setSplitRows((prev) => ({
      ...prev,
      [t.id]: [
        { accountId: currentAccountId, amount: Math.abs(t.amount) },
        { accountId: "", amount: 0 },
      ],
    }));
  }
  function cancelSplit(t) {
    setSplitMode((prev) => ({ ...prev, [t.id]: false }));
  }
  function updateSplitRow(txId, i, patch) {
    setSplitRows((prev) => ({ ...prev, [txId]: prev[txId].map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));
  }
  function addSplitRow(txId) {
    setSplitRows((prev) => ({ ...prev, [txId]: [...prev[txId], { accountId: "", amount: 0 }] }));
  }
  function removeSplitRow(txId, i) {
    setSplitRows((prev) => ({
      ...prev,
      [txId]: prev[txId].length > 2 ? prev[txId].filter((_, idx) => idx !== i) : prev[txId],
    }));
  }
  function postSplit(t) {
    if (isLocked(t.date)) return; // can't book into a closed period
    const rows = (splitRows[t.id] || []).map((r) => ({ accountId: r.accountId, amount: Number(r.amount) || 0 }));
    if (rows.some((r) => !r.accountId || !(r.amount > 0))) return;
    const total = rows.reduce((s, r) => s + r.amount, 0);
    if (Math.abs(total - Math.abs(t.amount)) > 0.005) return;
    setTransactions((prev) => prev.map((tx) => (tx.id === t.id ? { ...tx, splits: rows, mappedAccountId: rows[0].accountId, posted: true } : tx)));
  }

  return (
    <div className="max-w-4xl">
      <p className="text-sm text-slate-500 mb-5">
        The bank side of every entry is automatic - you're only ever picking the other account(s). Outflows debit the category and credit the bank; inflows do the reverse.
        One transaction spanning more than one category? Split it across several accounts instead of picking just one.
      </p>
      {lockDate && (
        <div className="flex items-center gap-1.5 text-xs bg-[#FFFBEB] text-[#B45309] border border-[#F59E0B]/40 rounded px-3 py-1.5 mb-4">
          <Power size={13} /> Period locked through <b>{lockDate}</b> - transactions on or before that date can't be posted or changed.
        </div>
      )}

      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className={`font-semibold px-2 py-1 rounded-full ${reviewPct === 0 ? "bg-[#E6FBF1] text-[#02B169]" : "bg-[#FFFBEB] text-[#B45309]"}`}>
          Needs review {reviewPct}%
        </span>
        <span className="text-slate-400">{pending.length} of {transactions.length} transaction{transactions.length === 1 ? "" : "s"} uncategorized</span>
      </div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Needs review ({pending.length})</div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-visible">
        {pending.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing to review - imports with a matching rule post automatically.</div>}
        {pending.map((t) => {
          const selected = choice[t.id] ?? t.mappedAccountId ?? "";
          const isSplit = !!splitMode[t.id];
          const rows = splitRows[t.id] || [];
          const splitTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
          const remaining = Math.abs(t.amount) - splitTotal;
          const splitBalanced = Math.abs(remaining) < 0.005;
          const splitReady = splitBalanced && rows.every((r) => r.accountId && Number(r.amount) > 0);

          if (!isSplit) {
            return (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
                <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                <span className="flex-1 truncate">{t.description}</span>
                <span className={`font-mono w-24 text-right shrink-0 ${t.amount < 0 ? "text-[#EF4444]" : "text-[#02B169]"}`}>{money(t.amount)}</span>
                <div className="w-48">
                  <AccountSelect
                    accounts={accounts.filter((a) => !a.isBank)}
                    value={selected}
                    onChange={(id) => setChoice({ ...choice, [t.id]: id })}
                    allowClear
                    clearLabel="- choose account -"
                    placeholder="- choose account -"
                    className={`w-full border rounded px-2 py-1 text-xs ${selected ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                  />
                </div>
                <label className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
                  <input type="checkbox" checked={!!remember[t.id]} onChange={(e) => setRemember({ ...remember, [t.id]: e.target.checked })} />
                  remember
                </label>
                <button onClick={() => startSplit(t)} title="Split across multiple accounts"
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 shrink-0">
                  <Layers size={13} />
                </button>
                <button onClick={() => post(t)} disabled={!selected}
                  className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
              </div>
            );
          }

          return (
            <div key={t.id} className="px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm bg-stone-50/50">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                <span className="flex-1 truncate">{t.description}</span>
                <span className={`font-mono w-24 text-right shrink-0 ${t.amount < 0 ? "text-[#EF4444]" : "text-[#02B169]"}`}>{money(t.amount)}</span>
                <span className="text-[10px] uppercase tracking-wide text-[#02B169] bg-[#E6FBF1] px-1.5 py-0.5 rounded shrink-0">split</span>
              </div>
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2 mb-1.5 pl-3">
                  <div className="flex-1">
                    <AccountSelect
                      accounts={accounts.filter((a) => !a.isBank)}
                      value={r.accountId}
                      onChange={(id) => updateSplitRow(t.id, i, { accountId: id })}
                      allowClear
                      clearLabel="- choose account -"
                      placeholder="- choose account -"
                      className={`w-full border rounded px-2 py-1 text-xs ${r.accountId ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                    />
                  </div>
                  <input
                    type="number" step="0.01" value={r.amount}
                    onChange={(e) => updateSplitRow(t.id, i, { amount: e.target.value })}
                    className="w-28 border border-stone-300 rounded px-2 py-1 text-xs font-mono text-right"
                  />
                  <button onClick={() => removeSplitRow(t.id, i)} disabled={rows.length <= 2}
                    className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30 shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-3 pl-3 mt-1.5">
                <button onClick={() => addSplitRow(t.id)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
                  <Plus size={12} /> Add split
                </button>
                <span className={`text-xs ${splitBalanced ? "text-[#02B169]" : "text-[#B45309]"}`}>
                  {splitBalanced ? "Splits balance." : `Remaining: ${money(remaining)}`}
                </span>
                <div className="flex-1" />
                <button onClick={() => cancelSplit(t)} className="text-xs text-slate-400 hover:text-slate-600">Cancel split</button>
                <button onClick={() => postSplit(t)} disabled={!splitReady}
                  className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Posted</div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
        {posted.length === 0 && <div className="p-4 text-sm text-slate-400">No posted transactions yet.</div>}
        {posted.map((t) => {
          const acc = accounts.find((a) => a.id === t.mappedAccountId);
          const isSplit = t.splits && t.splits.length > 1;
          return (
            <div key={t.id} className="flex items-center gap-3 px-3 py-2 border-b border-stone-100 last:border-0 text-sm">
              <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
              <span className="flex-1 truncate text-slate-600">{t.description}</span>
              <span className={`font-mono w-24 text-right shrink-0 ${t.amount < 0 ? "text-[#EF4444]" : "text-[#02B169]"}`}>{money(t.amount)}</span>
              {isSplit ? (
                <span className="text-xs text-slate-500 w-48 truncate" title={t.splits.map((s) => accounts.find((a) => a.id === s.accountId)?.name).join(", ")}>
                  {t.splits.length} accounts (split)
                </span>
              ) : (
                <span className="text-xs text-slate-500 w-48 truncate">{acc ? `${acc.code} - ${acc.name}` : "-"}</span>
              )}
              {t.matchedByRule && <span className="text-[10px] uppercase tracking-wide text-[#02B169] bg-[#E6FBF1] px-1.5 py-0.5 rounded shrink-0">rule</span>}
              <button onClick={() => unpost(t)} className="text-slate-300 hover:text-slate-600 shrink-0"><Pencil size={13} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Ledger ----------

function LedgerView({ accounts, journal, focusAccountId }) {
  const { t } = useLang();
  // Preselect whichever account a "See movements" drill-through requested;
  // otherwise default to the first account. Initialized from the focus so a
  // fresh mount (this view unmounts when the tab isn't active) lands on the
  // right account immediately, with a sync effect for the rare case the
  // focus changes while the ledger tab is already open.
  const [accountId, setAccountId] = useState(focusAccountId || accounts[0]?.id || "");
  useEffect(() => { if (focusAccountId) setAccountId(focusAccountId); }, [focusAccountId]);
  useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const acc = accounts.find((a) => a.id === accountId);
  const rows = journal.filter((j) => j.accountId === accountId).sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_ledger")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("subtitle_ledger")}</p>
      <div className="w-64 mb-4">
        <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} />
      </div>

      <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Description</th>
              <th className="text-right px-3 py-2 font-medium">Debit</th>
              <th className="text-right px-3 py-2 font-medium">Credit</th>
              <th className="text-right px-3 py-2 font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              running += acc && NORMAL_BALANCE[acc.type] === "debit" ? r.debit - r.credit : r.credit - r.debit;
              return (
                <tr key={r.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 font-mono text-slate-500">{r.date}</td>
                  <td className="px-3 py-2 truncate max-w-[220px]">{r.description}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.debit ? money(r.debit) : ""}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.credit ? money(r.credit) : ""}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(running)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No activity for this account yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Reports ----------

function Reports({ accounts, journal, entities, onSeeMovements }) {
  const { t } = useLang();
  const [report, setReport] = useState("trial");
  const bal = (id) => balanceFor(id, journal, accounts);

  const income = accounts.filter((a) => a.type === "Income");
  const expense = accounts.filter((a) => a.type === "Expense");
  const incomeTotal = income.reduce((s, a) => s + bal(a.id), 0);
  const expenseTotal = expense.reduce((s, a) => s + bal(a.id), 0);
  const netIncome = incomeTotal - expenseTotal;

  const assets = accounts.filter((a) => a.type === "Asset");
  const liabilities = accounts.filter((a) => a.type === "Liability");
  const equity = accounts.filter((a) => a.type === "Equity");
  const assetTotal = assets.reduce((s, a) => s + bal(a.id), 0);
  const liabilityTotal = liabilities.reduce((s, a) => s + bal(a.id), 0);
  const equityTotal = equity.reduce((s, a) => s + bal(a.id), 0) + netIncome;

  const totalDebits = journal.reduce((s, j) => s + j.debit, 0);
  const totalCredits = journal.reduce((s, j) => s + j.credit, 0);
  const trialInBalance = Math.abs(totalDebits - totalCredits) < 0.005;
  // Only computed when needed - names the specific entries behind an imbalance.
  const unbalancedEntries = trialInBalance ? [] : findUnbalancedEntries(journal);

  // Cash Flow Statement - a "since inception" view (no prior period exists in
  // this ledger to diff against, so the opening balance for every account is
  // implicitly zero and each account's ending balance *is* its change).
  // An account's balance already carries the right sign for its normal side,
  // so an Asset's cash contribution is the negative of its balance (holding
  // more of a non-cash asset ties up cash) while a Liability/Equity's is its
  // balance as-is (an increase in either is a source of cash). This falls
  // straight out of Assets = Liabilities + Equity, so the three sections are
  // mathematically guaranteed to add up to the actual cash balance below -
  // that's what the tie-out check at the bottom is confirming.
  const cashAccounts = accounts.filter((a) => a.cf === "cash");
  const cashBalance = cashAccounts.reduce((s, a) => s + bal(a.id), 0);
  const signedCF = (a) => (a.type === "Asset" ? -bal(a.id) : bal(a.id));
  const cfRows = (cat) => accounts.filter((a) => a.cf === cat && bal(a.id) !== 0);
  const cfSubtotal = (cat) => cfRows(cat).reduce((s, a) => s + signedCF(a), 0);
  const operatingSubtotal = netIncome + cfSubtotal("operating");
  const investingSubtotal = cfSubtotal("investing");
  const financingSubtotal = cfSubtotal("financing");
  const netChangeInCash = operatingSubtotal + investingSubtotal + financingSubtotal;
  const cfTies = Math.abs(netChangeInCash - cashBalance) < 0.005;

  return (
    <div className={`p-6 ${report === "consolidated" ? "max-w-5xl" : "max-w-3xl"}`}>
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_reports")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("subtitle_reports")}</p>

      <div className="flex gap-1 mb-5 border-b border-stone-200">
        {[["trial", "Trial Balance"], ["income", "Income Statement"], ["balance", "Balance Sheet"], ["cashflow", "Cash Flow"], ["consolidated", "Consolidated Balance Sheet"]].map(([k, l]) => (
          <button key={k} onClick={() => setReport(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${report === k ? "border-[#03D47C] text-[#02B169] font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {report === "trial" && (
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
                <th className="text-left px-3 py-2">Account</th>
                <th className="text-right px-3 py-2">Debit</th>
                <th className="text-right px-3 py-2">Credit</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const d = journal.filter((j) => j.accountId === a.id).reduce((s, j) => s + j.debit, 0);
                const c = journal.filter((j) => j.accountId === a.id).reduce((s, j) => s + j.credit, 0);
                if (!d && !c) return null;
                return (
                  <tr key={a.id} className="border-b border-stone-100 last:border-0 group">
                    <td className="px-3 py-2">{a.code} - {a.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{d ? money(d) : ""}</td>
                    <td className="px-3 py-2 text-right font-mono">{c ? money(c) : ""}</td>
                    <td className="px-3 py-2 text-right">
                      {onSeeMovements && (
                        <button onClick={() => onSeeMovements(a.id)}
                          className="text-xs text-[#02B169] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:underline whitespace-nowrap">
                          See movements
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-stone-50 font-medium">
                <td className="px-3 py-2">Totals</td>
                <td className="px-3 py-2 text-right font-mono">{money(totalDebits)}</td>
                <td className="px-3 py-2 text-right font-mono">{money(totalCredits)}</td>
                <td className="px-3 py-2" />
              </tr>
            </tbody>
          </table>
          {trialInBalance ? (
            <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-[#02B169]">
              <CheckCircle2 size={13} /> Debits equal credits.
            </div>
          ) : (
            <div className="px-3 py-2 text-xs text-[#EF4444]">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle size={13} /> Out of balance by {money(Math.abs(totalDebits - totalCredits))}.
              </div>
              {unbalancedEntries.length > 0 ? (
                <div className="mt-1.5 text-slate-600">
                  <div className="text-slate-500 mb-1">
                    {unbalancedEntries.length} entr{unbalancedEntries.length === 1 ? "y" : "ies"} whose own debits and credits don't net to zero
                    {unbalancedEntries.length > 5 ? " (top 5 shown)" : ""}:
                  </div>
                  <ul className="space-y-0.5">
                    {unbalancedEntries.slice(0, 5).map((e) => (
                      <li key={e.key} className="flex items-center gap-2 font-mono">
                        <span className="text-slate-400 w-24 shrink-0">{e.date || "-"}</span>
                        <span className="flex-1 truncate text-slate-600">{e.description || e.key}</span>
                        <span className="shrink-0">Dr {money(e.debit)} / Cr {money(e.credit)}</span>
                        <span className="shrink-0 text-[#EF4444]">off {money(Math.abs(e.delta))}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-1.5 text-slate-500">
                  No single entry is unbalanced - this is sub-cent rounding spread across many entries. If it persists, it usually means a Transaction Types template's debit and credit legs don't reference equal amounts.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {report === "income" && (
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 space-y-4">
          <ReportGroup title="Income" rows={income} bal={bal} total={incomeTotal} />
          <ReportGroup title="Expenses" rows={expense} bal={bal} total={expenseTotal} />
          <div className="flex justify-between pt-2 border-t border-stone-200 font-semibold text-sm">
            <span>Net Income</span>
            <span className={`font-mono ${netIncome >= 0 ? "text-[#02B169]" : "text-[#EF4444]"}`}>{money(netIncome)}</span>
          </div>
        </div>
      )}

      {report === "balance" && (
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 space-y-4">
          <ReportGroup title="Assets" rows={assets} bal={bal} total={assetTotal} />
          <ReportGroup title="Liabilities" rows={liabilities} bal={bal} total={liabilityTotal} />
          <div>
            <ReportGroup title="Equity" rows={equity} bal={bal} total={null} />
            <div className="flex justify-between text-sm px-1">
              <span className="text-slate-600">Current-year earnings</span>
              <span className="font-mono">{money(netIncome)}</span>
            </div>
            <div className="flex justify-between text-sm px-1 font-medium pt-1 border-t border-stone-100 mt-1">
              <span>Total Equity</span>
              <span className="font-mono">{money(equityTotal)}</span>
            </div>
          </div>
          <div className="flex justify-between pt-2 border-t border-stone-200 font-semibold text-sm">
            <span>Assets vs. Liabilities + Equity</span>
            <span className="font-mono">{money(assetTotal)} / {money(liabilityTotal + equityTotal)}</span>
          </div>
          <div className={`flex items-center gap-1.5 text-xs ${Math.abs(assetTotal - (liabilityTotal + equityTotal)) < 0.005 ? "text-[#02B169]" : "text-[#EF4444]"}`}>
            {Math.abs(assetTotal - (liabilityTotal + equityTotal)) < 0.005 ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {Math.abs(assetTotal - (liabilityTotal + equityTotal)) < 0.005 ? "Balance sheet balances." : "Doesn't balance yet."}
          </div>
        </div>
      )}

      {report === "cashflow" && (
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 space-y-4">
          <p className="text-xs text-slate-400 -mt-1 mb-1">
            Since-inception view (no prior period to diff against yet). "Cash and cash equivalents" = accounts tagged{" "}
            <span className="text-[#02B169] font-medium">Cash</span> in the Chart of Accounts.
          </p>

          <CashFlowSection title="Operating Activities" leadLabel="Net income" leadValue={netIncome} rows={cfRows("operating")} signedCF={signedCF} total={operatingSubtotal} />
          <CashFlowSection title="Investing Activities" rows={cfRows("investing")} signedCF={signedCF} total={investingSubtotal} />
          <CashFlowSection title="Financing Activities" rows={cfRows("financing")} signedCF={signedCF} total={financingSubtotal} />

          <div className="flex justify-between pt-2 border-t border-stone-200 font-semibold text-sm">
            <span>Net change in cash</span>
            <span className="font-mono">{money(netChangeInCash)}</span>
          </div>
          <div className="flex justify-between text-sm px-1">
            <span className="text-slate-600">Cash and cash equivalents (ending)</span>
            <span className="font-mono">{money(cashBalance)}</span>
          </div>
          <div className={`flex items-center gap-1.5 text-xs ${cfTies ? "text-[#02B169]" : "text-[#EF4444]"}`}>
            {cfTies ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {cfTies ? "Ties to the cash balance." : "Doesn't tie to the cash balance - check account cash-flow tags."}
          </div>
        </div>
      )}

      {report === "consolidated" && <ConsolidatedBalanceSheet accounts={accounts} journal={journal} entities={entities} />}
    </div>
  );
}

// One column per legal entity plus Eliminations and Consolidated - each
// account belongs to exactly one entity (see entityId on the account), so
// pivoting is just "put this account's balance in its own entity's column,
// zero elsewhere." An account flagged isIntercompany gets an Eliminations
// entry equal to the negative of its own balance, netting that row to zero
// in the Consolidated column - the standard treatment for intercompany
// receivables/payables that aren't real claims on an outside party. Because
// intercompany pairs are recorded as matched debit/credit amounts in the
// same journal entry, the assets-side and liabilities-side eliminations
// are always equal, so wiping them out this way can never break the
// consolidated balance sheet's own Assets = Liabilities + Equity identity.
function ConsolidatedBalanceSheet({ accounts, journal, entities }) {
  const bal = (id) => balanceFor(id, journal, accounts);
  const rowsFor = (type) => accounts.filter((a) => a.type === type && bal(a.id) !== 0);

  function buildSection(type) {
    const rows = rowsFor(type);
    const withCols = rows.map((a) => {
      const amount = bal(a.id);
      const perEntity = {};
      entities.forEach((e) => { perEntity[e.id] = e.id === a.entityId ? amount : 0; });
      const elimination = a.isIntercompany ? -amount : 0;
      const consolidated = amount + elimination; // amount here = sum(perEntity) since only one entity is nonzero
      return { account: a, perEntity, elimination, consolidated };
    });
    const totals = { perEntity: {}, elimination: 0, consolidated: 0 };
    entities.forEach((e) => { totals.perEntity[e.id] = withCols.reduce((s, r) => s + r.perEntity[e.id], 0); });
    totals.elimination = withCols.reduce((s, r) => s + r.elimination, 0);
    totals.consolidated = withCols.reduce((s, r) => s + r.consolidated, 0);
    return { rows: withCols, totals };
  }

  const assetsSec = buildSection("Asset");
  const liabSec = buildSection("Liability");
  const equitySec = buildSection("Equity");

  const consolidatedIncome = accounts.filter((a) => a.type === "Income").reduce((s, a) => s + bal(a.id), 0);
  const consolidatedExpense = accounts.filter((a) => a.type === "Expense").reduce((s, a) => s + bal(a.id), 0);
  const consolidatedNetIncome = consolidatedIncome - consolidatedExpense;

  const assetsTotal = assetsSec.totals.consolidated;
  const liabEquityTotal = liabSec.totals.consolidated + equitySec.totals.consolidated + consolidatedNetIncome;
  const ties = Math.abs(assetsTotal - liabEquityTotal) < 0.005;

  function Section({ title, section }) {
    return (
      <>
        <tr className="bg-stone-50">
          <td className="px-3 py-1.5 font-semibold text-xs uppercase tracking-wide text-slate-500" colSpan={entities.length + 3}>{title}</td>
        </tr>
        {section.rows.map((r) => (
          <tr key={r.account.id} className="border-b border-stone-100 last:border-0">
            <td className="px-3 py-1.5">{r.account.name}</td>
            {entities.map((e) => (
              <td key={e.id} className="px-3 py-1.5 text-right font-mono text-slate-600">{r.perEntity[e.id] ? money(r.perEntity[e.id]) : ""}</td>
            ))}
            <td className="px-3 py-1.5 text-right font-mono text-[#EF4444]">{r.elimination ? money(r.elimination) : ""}</td>
            <td className="px-3 py-1.5 text-right font-mono font-medium">{money(r.consolidated)}</td>
          </tr>
        ))}
        <tr className="font-medium border-b-2 border-stone-200">
          <td className="px-3 py-1.5">Total {title}</td>
          {entities.map((e) => (
            <td key={e.id} className="px-3 py-1.5 text-right font-mono">{money(section.totals.perEntity[e.id])}</td>
          ))}
          <td className="px-3 py-1.5 text-right font-mono text-[#EF4444]">{money(section.totals.elimination)}</td>
          <td className="px-3 py-1.5 text-right font-mono">{money(section.totals.consolidated)}</td>
        </tr>
      </>
    );
  }

  return (
    <div className="-mx-3 overflow-x-auto">
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden mx-3">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
              <th className="text-left px-3 py-2 font-medium">Account</th>
              {entities.map((e) => <th key={e.id} className="text-right px-3 py-2 font-medium">{e.name}</th>)}
              <th className="text-right px-3 py-2 font-medium">Eliminations</th>
              <th className="text-right px-3 py-2 font-medium">Consolidated</th>
            </tr>
          </thead>
          <tbody>
            <Section title="Assets" section={assetsSec} />
            <Section title="Liabilities" section={liabSec} />
            <Section title="Equity" section={equitySec} />
            <tr>
              <td className="px-3 py-1.5 text-slate-500">Current-year earnings</td>
              {entities.map((e) => <td key={e.id} />)}
              <td />
              <td className="px-3 py-1.5 text-right font-mono text-slate-500">{money(consolidatedNetIncome)}</td>
            </tr>
          </tbody>
        </table>
        <div className={`flex items-center gap-1.5 px-3 py-2 text-xs ${ties ? "text-[#02B169]" : "text-[#EF4444]"}`}>
          {ties ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
          {ties
            ? `Consolidated Assets ${money(assetsTotal)} = Liabilities + Equity ${money(liabEquityTotal)}.`
            : `Out of balance: Assets ${money(assetsTotal)} vs. Liabilities + Equity ${money(liabEquityTotal)}.`}
        </div>
      </div>
    </div>
  );
}

function CashFlowSection({ title, leadLabel, leadValue, rows, signedCF, total }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{title}</div>
      {leadLabel !== undefined && (
        <div className="flex justify-between text-sm px-1 py-0.5">
          <span>{leadLabel}</span>
          <span className="font-mono">{money(leadValue)}</span>
        </div>
      )}
      {rows.length === 0 && leadLabel === undefined && <div className="text-sm text-slate-400 px-1">-</div>}
      {rows.map((a) => (
        <div key={a.id} className="flex justify-between text-sm px-1 py-0.5">
          <span>{a.name}</span>
          <span className="font-mono">{money(signedCF(a))}</span>
        </div>
      ))}
      <div className="flex justify-between text-sm px-1 pt-1 mt-1 border-t border-stone-100 font-medium">
        <span>Net cash from {title.toLowerCase()}</span>
        <span className="font-mono">{money(total)}</span>
      </div>
    </div>
  );
}

function ReportGroup({ title, rows, bal, total }) {
  const shown = rows.filter((a) => bal(a.id) !== 0);
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{title}</div>
      {shown.length === 0 && <div className="text-sm text-slate-400 px-1">-</div>}
      {shown.map((a) => (
        <div key={a.id} className="flex justify-between text-sm px-1 py-0.5">
          <span>{a.name}</span>
          <span className="font-mono">{money(bal(a.id))}</span>
        </div>
      ))}
      {total !== null && (
        <div className="flex justify-between text-sm px-1 pt-1 mt-1 border-t border-stone-100 font-medium">
          <span>Total {title}</span>
          <span className="font-mono">{money(total)}</span>
        </div>
      )}
    </div>
  );
}

// ---------- Analytics dashboard ----------

// Compact, dependency-free bar chart - no charting library is loaded
// anywhere in this app, so trend/breakdown visuals are plain inline SVG
// rather than pulling in a new dependency for two small charts.
function MiniBarChart({ data, height = 120, formatValue }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const barWidth = data.length ? Math.min(48, 100 / data.length) : 20;
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map((d, i) => {
        const h = Math.max(2, (Math.abs(d.value) / max) * (height - 24));
        return (
          <div key={i} className="flex flex-col items-center justify-end flex-1 h-full" title={formatValue ? formatValue(d.value) : d.value}>
            <div className="text-[10px] text-slate-500 mb-1 font-mono">{formatValue ? formatValue(d.value) : d.value}</div>
            <div
              className={`w-full rounded-t ${d.value >= 0 ? "bg-[#03D47C]" : "bg-[#EF4444]"}`}
              style={{ height: `${h}px`, maxWidth: 36, marginInline: "auto" }}
            />
            <div className="text-[10px] text-slate-400 mt-1 truncate max-w-full">{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 flex-1 min-w-[160px]">
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-xl font-semibold font-mono ${tone === "bad" ? "text-[#EF4444]" : "text-black"}`}>{value}</div>
    </div>
  );
}

// "Financials Overview" - cash on hand, revenue, a monthly trend, an expense
// breakdown, and (since entities now exist) an Intercompany Balances by
// Location panel with a location filter, mirroring the reference software's
// Analytics tab. Everything here is derived live from the same journal
// Reports uses - no separate/duplicated computation to drift out of sync.
function Analytics({ accounts, journal, entities, allEntities, onAddEntity, onUpdateEntity, onDeleteEntity }) {
  const { t } = useLang();
  const [locationFilter, setLocationFilter] = useState("all");
  const bal = (id) => balanceFor(id, journal, accounts);

  const cashAccounts = accounts.filter((a) => a.cf === "cash");
  const cashOnHand = cashAccounts.reduce((s, a) => s + bal(a.id), 0);

  const incomeAccounts = accounts.filter((a) => a.type === "Income");
  const expenseAccounts = accounts.filter((a) => a.type === "Expense");
  const totalRevenue = incomeAccounts.reduce((s, a) => s + bal(a.id), 0);
  const totalExpense = expenseAccounts.reduce((s, a) => s + bal(a.id), 0);
  const netIncome = totalRevenue - totalExpense;

  // Monthly revenue trend - grouped straight from journal line dates, so
  // this is real activity over time, not a synthetic sparkline.
  const monthlyRevenue = useMemo(() => {
    const incomeIds = new Set(incomeAccounts.map((a) => a.id));
    const byMonth = new Map();
    journal.forEach((j) => {
      if (!incomeIds.has(j.accountId)) return;
      const month = (j.date || "").slice(0, 7);
      if (!month) return;
      byMonth.set(month, (byMonth.get(month) || 0) + (j.credit - j.debit));
    });
    return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6)
      .map(([month, value]) => ({ label: month.slice(2), value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, accounts]);

  const expenseBreakdown = useMemo(() => {
    return expenseAccounts
      .map((a) => ({ label: a.name, value: bal(a.id) }))
      .filter((r) => r.value !== 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, accounts]);
  const maxExpense = Math.max(1, ...expenseBreakdown.map((r) => r.value));

  // Intercompany Balances by Location - each entity's net position across
  // its own isIntercompany-flagged accounts (Due to/Due from). bal() already
  // returns a positive number for an account's own normal side, but that
  // means a Liability's (Due to...) positive balance represents money owed
  // OUT, not in - so it has to be subtracted, not added, to get a true net
  // position. A receivable (Due from..., Asset) contributes positive; a
  // payable (Due to..., Liability) contributes negative. With that flip,
  // every real intercompany pair's contributions cancel exactly, so the
  // net across all locations combined is always zero - the same identity
  // the Eliminations column on the Consolidated Balance Sheet relies on.
  const intercompanyByEntity = entities.map((e) => {
    const rows = accounts.filter((a) => a.entityId === e.id && a.isIntercompany);
    const net = rows.reduce((s, a) => s + (a.type === "Liability" ? -bal(a.id) : bal(a.id)), 0);
    return { entity: e, rows, net };
  });
  const visibleIntercompany = locationFilter === "all" ? intercompanyByEntity : intercompanyByEntity.filter((r) => r.entity.id === locationFilter);

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_analytics")}</h1>
      <p className="text-sm text-slate-500 mb-5">{t("subtitle_analytics")}</p>

      <div className="flex flex-wrap gap-3 mb-6">
        <StatCard label="Cash on hand" value={money(cashOnHand)} />
        <StatCard label="Revenue (all-time)" value={money(totalRevenue)} />
        <StatCard label="Expenses (all-time)" value={money(totalExpense)} />
        <StatCard label="Net income" value={money(netIncome)} tone={netIncome < 0 ? "bad" : undefined} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4">
          <h2 className="text-sm font-semibold text-black mb-3">Revenue trend (last 6 months with activity)</h2>
          {monthlyRevenue.length > 0
            ? <MiniBarChart data={monthlyRevenue} formatValue={(v) => money(v)} />
            : <div className="text-sm text-slate-400 py-8 text-center">No income activity posted yet.</div>}
        </div>
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4">
          <h2 className="text-sm font-semibold text-black mb-3">Expense breakdown (top accounts)</h2>
          {expenseBreakdown.length > 0 ? (
            <div className="space-y-2">
              {expenseBreakdown.map((r) => (
                <div key={r.label} className="flex items-center gap-2 text-xs">
                  <div className="w-32 truncate text-slate-500 shrink-0">{r.label}</div>
                  <div className="flex-1 bg-stone-100 rounded h-3 overflow-hidden">
                    <div className="bg-[#03D47C] h-3 rounded" style={{ width: `${(r.value / maxExpense) * 100}%` }} />
                  </div>
                  <div className="w-20 text-right font-mono text-slate-600 shrink-0">{money(r.value)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-400 py-8 text-center">No expense activity posted yet.</div>
          )}
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-black">Intercompany Balances by Location</h2>
          <div className="flex items-center gap-2">
            <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}
              className="border border-stone-300 rounded px-2 py-1 text-xs">
              <option value="all">All locations</option>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span className="text-xs text-slate-400 border border-stone-200 rounded px-2 py-1">Reported currency: USD</span>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
              <th className="text-left px-2 py-1.5">Location</th>
              <th className="text-left px-2 py-1.5">Intercompany accounts</th>
              <th className="text-right px-2 py-1.5">Net intercompany position</th>
            </tr>
          </thead>
          <tbody>
            {visibleIntercompany.map((r) => (
              <tr key={r.entity.id} className="border-b border-stone-100 last:border-0">
                <td className="px-2 py-1.5 font-medium">{r.entity.name}</td>
                <td className="px-2 py-1.5 text-slate-500">{r.rows.map((a) => a.name).join(", ") || "-"}</td>
                <td className={`px-2 py-1.5 text-right font-mono ${r.net < 0 ? "text-[#EF4444]" : "text-slate-700"}`}>{money(r.net)}</td>
              </tr>
            ))}
            {visibleIntercompany.length === 0 && (
              <tr><td colSpan={3} className="px-2 py-4 text-center text-slate-400">No intercompany activity for this location.</td></tr>
            )}
          </tbody>
        </table>
        <p className="text-[11px] text-slate-400 mt-2">
          Positive = this location is owed money by an affiliate (a receivable); negative = this location owes an affiliate (a payable).
          These net to zero across all locations combined, which is exactly what the Eliminations column on the Consolidated Balance
          Sheet zeroes out.
        </p>
      </div>

      <OwnershipStructure allEntities={allEntities} onAdd={onAddEntity} onUpdate={onUpdateEntity} onDelete={onDeleteEntity} />
    </div>
  );
}

const EMPTY_ENTITY_FORM = { name: "", jurisdiction: "", parentId: "", ownershipPct: "", secondParentId: "", secondOwnershipPct: "", flagged: false };

// The group cap table - every entity, its jurisdiction, its direct
// parent(s) and ownership %, and whether it carries the org chart's star
// marker. Shown flat (sorted by depth from the top) rather than as a
// literal tree diagram - the parent column already makes the hierarchy
// readable, and a flat sortable list is far less work to keep correct than
// laying out box-and-line connectors. Ownership % is tracked here as
// metadata only; it is not yet used to adjust Reports/Consolidated Balance
// Sheet math (no NCI or equity-method split) - see the note above
// DEFAULT_ENTITIES for why that's a deliberate, revisitable simplification.
// Add/edit/delete follow the same inline-row pattern as Chart of Accounts
// and Wallets elsewhere in this app.
function OwnershipStructure({ allEntities, onAdd, onUpdate, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_ENTITY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [error, setError] = useState("");

  const byId = new Map(allEntities.map((e) => [e.id, e]));
  const depthOf = (e, seen = new Set()) => {
    if (!e.parentId || seen.has(e.id)) return 0;
    const parent = byId.get(e.parentId);
    return parent ? 1 + depthOf(parent, new Set([...seen, e.id])) : 0;
  };
  const rows = [...allEntities].sort((a, b) => depthOf(a) - depthOf(b) || a.name.localeCompare(b.name));

  function toPatch(f) {
    return {
      name: f.name.trim(),
      jurisdiction: f.jurisdiction.trim(),
      parentId: f.parentId || null,
      ownershipPct: f.ownershipPct === "" ? null : Number(f.ownershipPct),
      secondParentId: f.secondParentId || null,
      secondOwnershipPct: f.secondOwnershipPct === "" ? null : Number(f.secondOwnershipPct),
      flagged: !!f.flagged,
    };
  }

  function submitAdd() {
    if (!form.name.trim()) { setError("Name is required."); return; }
    onAdd(toPatch(form));
    setForm(EMPTY_ENTITY_FORM);
    setAdding(false);
    setError("");
  }

  function startEdit(e) {
    setEditingId(e.id);
    setEditForm({
      name: e.name, jurisdiction: e.jurisdiction || "", parentId: e.parentId || "",
      ownershipPct: e.ownershipPct ?? "", secondParentId: e.secondParentId || "",
      secondOwnershipPct: e.secondOwnershipPct ?? "", flagged: !!e.flagged,
    });
    setError("");
  }
  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setError("");
  }
  function saveEdit() {
    if (!editForm.name.trim()) { setError("Name is required."); return; }
    if (editForm.parentId === editingId || editForm.secondParentId === editingId) {
      setError("An entity can't be its own parent.");
      return;
    }
    onUpdate(editingId, toPatch(editForm));
    setEditingId(null);
    setEditForm(null);
    setError("");
  }
  function handleDelete(id) {
    if (!window.confirm("Remove this entity?")) return;
    const ok = onDelete(id);
    if (ok === false) setError("Can't remove an entity that still has accounts tagged to it, or that another entity lists as a parent.");
  }

  const parentOptions = (excludeId) => allEntities.filter((e) => e.id !== excludeId);

  return (
    <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 mt-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-black">Ownership Structure</h2>
        <button onClick={() => { setAdding((v) => !v); setError(""); }} className="text-xs text-[#02B169] hover:underline flex items-center gap-1">
          <Plus size={12} /> Add entity
        </button>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        The group cap table. Ownership % is tracked as metadata only - every entity is still fully consolidated
        in Reports regardless of stake size, a simplification worth revisiting before this feeds audited financials.
      </p>

      {error && <div className="text-xs text-[#EF4444] mb-2 flex items-center gap-1"><AlertTriangle size={12} />{error}</div>}

      {adding && (
        <div className="border border-stone-200 rounded-lg p-3 mb-3 bg-stone-50 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Entity name"
              className="border border-stone-300 rounded px-2 py-1.5 text-sm" />
            <input value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} placeholder="Jurisdiction (e.g. Cambodia)"
              className="border border-stone-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex gap-2">
              <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm">
                <option value="">Owned by (top level)</option>
                {parentOptions(null).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <input value={form.ownershipPct} onChange={(e) => setForm({ ...form, ownershipPct: e.target.value })} placeholder="%" type="number" min="0" max="100"
                className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm" />
            </div>
            <div className="flex gap-2">
              <select value={form.secondParentId} onChange={(e) => setForm({ ...form, secondParentId: e.target.value })} className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm">
                <option value="">2nd owner (optional)</option>
                {parentOptions(null).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <input value={form.secondOwnershipPct} onChange={(e) => setForm({ ...form, secondOwnershipPct: e.target.value })} placeholder="%" type="number" min="0" max="100"
                className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm" />
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={form.flagged} onChange={(e) => setForm({ ...form, flagged: e.target.checked })} /> Flag this entity (★)
          </label>
          <div className="flex gap-2">
            <button onClick={submitAdd} className="bg-black hover:bg-[#4D4D4D] text-white text-xs px-3 py-1.5 rounded-full">Save</button>
            <button onClick={() => { setAdding(false); setForm(EMPTY_ENTITY_FORM); setError(""); }} className="text-xs text-slate-500 underline">Cancel</button>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
            <th className="text-left px-2 py-1.5">Entity</th>
            <th className="text-left px-2 py-1.5">Jurisdiction</th>
            <th className="text-left px-2 py-1.5">Owned by</th>
            <th className="text-right px-2 py-1.5">Ownership</th>
            <th className="text-right px-2 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const parent = e.parentId ? byId.get(e.parentId) : null;
            const secondParent = e.secondParentId ? byId.get(e.secondParentId) : null;

            if (editingId === e.id) {
              return (
                <tr key={e.id} className="border-b border-stone-100 last:border-0 bg-stone-50">
                  <td className="px-2 py-1.5" colSpan={5}>
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <input value={editForm.name} onChange={(ev) => setEditForm({ ...editForm, name: ev.target.value })} placeholder="Entity name"
                          className="border border-stone-300 rounded px-2 py-1.5 text-sm" />
                        <input value={editForm.jurisdiction} onChange={(ev) => setEditForm({ ...editForm, jurisdiction: ev.target.value })} placeholder="Jurisdiction"
                          className="border border-stone-300 rounded px-2 py-1.5 text-sm" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex gap-2">
                          <select value={editForm.parentId} onChange={(ev) => setEditForm({ ...editForm, parentId: ev.target.value })} className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm">
                            <option value="">Owned by (top level)</option>
                            {parentOptions(e.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <input value={editForm.ownershipPct} onChange={(ev) => setEditForm({ ...editForm, ownershipPct: ev.target.value })} placeholder="%" type="number" min="0" max="100"
                            className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm" />
                        </div>
                        <div className="flex gap-2">
                          <select value={editForm.secondParentId} onChange={(ev) => setEditForm({ ...editForm, secondParentId: ev.target.value })} className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm">
                            <option value="">2nd owner (optional)</option>
                            {parentOptions(e.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <input value={editForm.secondOwnershipPct} onChange={(ev) => setEditForm({ ...editForm, secondOwnershipPct: ev.target.value })} placeholder="%" type="number" min="0" max="100"
                            className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm" />
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 text-xs text-slate-500">
                        <input type="checkbox" checked={editForm.flagged} onChange={(ev) => setEditForm({ ...editForm, flagged: ev.target.checked })} /> Flag this entity (★)
                      </label>
                      <div className="flex gap-2">
                        <button onClick={saveEdit} className="bg-black hover:bg-[#4D4D4D] text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-1"><CheckCircle2 size={12} /> Save</button>
                        <button onClick={cancelEdit} className="text-xs text-slate-500 underline flex items-center gap-1"><XCircle size={12} /> Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              );
            }

            return (
              <tr key={e.id} className="border-b border-stone-100 last:border-0">
                <td className="px-2 py-1.5">
                  {e.name}
                  {e.flagged && <span className="text-[#EF4444] ml-1" title="Flagged in the org chart">★</span>}
                </td>
                <td className="px-2 py-1.5 text-slate-500">{e.jurisdiction}</td>
                <td className="px-2 py-1.5 text-slate-500">
                  {parent ? parent.name : "-"}
                  {secondParent ? `, ${secondParent.name}` : ""}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {e.ownershipPct != null ? `${e.ownershipPct}%` : "-"}
                  {secondParent && e.secondOwnershipPct != null ? ` / ${e.secondOwnershipPct}%` : ""}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button onClick={() => startEdit(e)} className="text-slate-400 hover:text-black mr-2"><Pencil size={13} /></button>
                  <button onClick={() => handleDelete(e.id)} className="text-slate-400 hover:text-[#EF4444]"><Trash2 size={13} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Transaction Types (new-type mapping queue) ----------

function matchLabel(template) {
  const rules = template.matchRule?.all || [];
  return rules.map((r) => `${r.field} = ${r.equals}`).join("  &  ");
}

// Editing an existing template shouldn't require waiting for a live event to
// land in "Needs mapping"/"Needs review" first - this builds a stand-in
// sample straight from the template itself, so the "Edit" button on any
// registry row can open the same TemplateBuilder used everywhere else.
// Match-rule fields get their real "equals" value back (so re-saving still
// matches the same events); every field a leg references gets a placeholder
// number so "%" legs have something to preview against and the field stays
// editable rather than blank.
function sampleTxFromTemplate(template) {
  const tx = {};
  (template.matchRule?.all || []).forEach((r) => { tx[r.field] = r.equals; });
  if (!tx.eventType) tx.eventType = template.code;
  template.legs.forEach((leg) => {
    const field = legBaseField(leg);
    if (field && !(field in tx)) tx[field] = 100;
  });
  return tx;
}
function legLabel(leg) {
  const prefix = leg.side === "debit" ? "Dr" : "Cr";
  if (legMode(leg) === "fixed") return `${prefix} ${leg.accountRef} (fixed ${money(leg.fixedAmount)})`;
  const baseField = legBaseField(leg);
  const pct = legPct(leg);
  return `${prefix} ${leg.accountRef} (${pct === 100 ? baseField : `${pct}% of ${baseField}`})`;
}

function TransactionTypes({ accounts, cryptoLabels = [], onAddCryptoLabel, onUpdateCryptoLabel, onDeleteCryptoLabel, cryptoRules = [], cryptoFilters = [], coins = [], wallets = [], onAddRule, onDeleteRule }) {
  const { t } = useLang();
  const autoMapRules = cryptoRules.filter((r) => Array.isArray(r.conditions) && r.conditions.length && r.labelId);
  const activeCryptoLabels = cryptoLabels.filter((l) => l.status !== "inactive");
  // Rule builder: match a saved filter (favorite) to a label. The filter's
  // conditions become the rule's conditions.
  const [rFilterId, setRFilterId] = useState("");
  const [rLabel, setRLabel] = useState("");
  const selectedFilter = cryptoFilters.find((f) => f.id === rFilterId);
  const canAddRule = selectedFilter && (selectedFilter.conditions || []).length > 0 && rLabel && onAddRule;
  function addRule() {
    if (!canAddRule) return;
    onAddRule(selectedFilter.conditions, rLabel, selectedFilter.name);
    setRFilterId(""); setRLabel("");
  }
  const condText = (c) => {
    switch (c.field) {
      case "type": return `Type is ${c.value}`;
      case "source": return `Source is ${cryptoSourceLabel(c.value)}`;
      case "coin": return `Coin is ${coins.find((x) => x.id === c.value)?.symbol || c.value}`;
      case "wallet": return `Wallet is ${wallets.find((x) => x.id === c.value)?.name || c.value}`;
      case "label": return `Label is ${cryptoLabels.find((x) => x.id === c.value)?.label || c.value}`;
      case "dateFrom": return `On/after ${c.value}`;
      case "dateTo": return `On/before ${c.value}`;
      case "search": return `Text contains "${c.value}"`;
      default: return `${c.field}=${c.value}`;
    }
  };
  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_types")}</h1>
      <p className="text-sm text-slate-500 mb-5">{t("subtitle_types")}</p>
      <details className="bg-white border border-stone-200 rounded-lg p-4 mb-5 shadow-sm text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">How fees are handled</summary>
        <div className="mt-3 space-y-2 text-slate-600">
          <p><span className="font-medium">Fees not from a gas tank.</span> When gas is already bundled into a transaction's amount (e.g. BitGo's NULL-balance fee lines), it is not booked again — the amount already reflects it. A genuinely separate fee (an inline fee column, a standalone fee row, or a real-balance fee) posts as its own Fee entry: Dr the expense account, Cr the wallet holding that coin at FIFO cost, with the spread as a realized gain/loss. Trade fees are embedded in the price, so the realized loss on a trade is the trading fee (520302). Because the gas tanks pay gas for the custody wallets, those wallets' sends are booked as principal only.</p>
          <p><span className="font-medium">Fees from a gas tank.</span> A gas tank is the company gas wallet (112106), holding each chain's native coin. Coin in = a Deposit (cost basis); coin out + network gas = a Fee, posted via "Gas fee paid from gas tank": Dr Gas fee (520301), Cr the gas wallet at FIFO cost. Avalanche and Polygon carry an on-chain price; set an ETH and TRX market rate so those fees carry a USD value.</p>
        </div>
      </details>

      {/* Auto-mapping rules: filter conditions -> label, applied automatically
          to matching transactions. Created from the Crypto Transactions filter
          ("Auto-map every transaction matching this filter to a label"). */}
      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-5 shadow-sm">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Auto-mapping rules</div>
        <p className="text-xs text-slate-500 mb-3">
          Match a saved filter to a label: every transaction matching that filter is mapped to the label automatically - both existing drafts in Needs Review and future imports. Save filters on the Crypto Transactions screen (Save favorite).
        </p>
        {cryptoFilters.length === 0 ? (
          <div className="text-xs text-slate-400 mb-4 pb-4 border-b border-stone-100">No saved filters yet - create one on the Crypto Transactions screen (filter, then "Save favorite"), then match it to a label here.</div>
        ) : (
          <div className="flex flex-wrap items-end gap-2 mb-2">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[11px] text-slate-500 mb-1">Saved filter</label>
              <select value={rFilterId} onChange={(e) => setRFilterId(e.target.value)} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm">
                <option value="">choose filter…</option>
                {cryptoFilters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <span className="text-slate-400 pb-2">→</span>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[11px] text-slate-500 mb-1">Label</label>
              <select value={rLabel} onChange={(e) => setRLabel(e.target.value)} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm">
                <option value="">choose label…</option>
                {activeCryptoLabels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <button onClick={addRule} disabled={!canAddRule}
              className="flex items-center gap-1.5 bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
              <Plus size={14} /> Add rule
            </button>
          </div>
        )}
        {selectedFilter && (
          <div className="flex flex-wrap items-center gap-1 mb-4 pb-4 border-b border-stone-100 text-xs text-slate-500">
            <span className="text-slate-400">Matches:</span>
            {(selectedFilter.conditions || []).map((c, i) => <span key={i} className="bg-stone-100 text-slate-600 rounded px-1.5 py-0.5">{condText(c)}</span>)}
          </div>
        )}
        {autoMapRules.length === 0 ? (
          <div className="text-xs text-slate-400">No auto-mapping rules yet.</div>
        ) : (
          <div className="divide-y divide-stone-100">
            {autoMapRules.map((r) => (
              <div key={r.id} className="flex items-center gap-2 py-2 text-sm">
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
                  {r.filterName && <span className="text-xs font-medium text-slate-700">{r.filterName}</span>}
                  {r.conditions.map((c, i) => (
                    <span key={i} className="text-xs bg-stone-100 text-slate-600 rounded px-1.5 py-0.5">{condText(c)}</span>
                  ))}
                  <span className="text-slate-400 mx-1">→</span>
                  <span className="text-xs font-medium text-[#02B169]">{cryptoLabels.find((l) => l.id === r.labelId)?.label || "(deleted label)"}</span>
                </div>
                {onDeleteRule && (
                  <button onClick={() => onDeleteRule(r.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0" title="Remove rule"><Trash2 size={14} /></button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <CryptoLabelManager
        accounts={accounts}
        cryptoLabels={cryptoLabels}
        onAdd={onAddCryptoLabel}
        onUpdate={onUpdateCryptoLabel}
        onDelete={onDeleteCryptoLabel}
      />
    </div>
  );
}

// ---------- Label Manager (unified Label Mapping) ----------
// Each label maps a transaction's *contra* (non-wallet) side to one or more
// accounts - each leg is an account + Dr/Cr side + percentage of the value.
// The FIFO engine posts the wallet/cost-basis side. A label's legs must net to
// a full contra: credit-heavy (+100%) applies to deposits, debit-heavy (-100%)
// to withdrawals. This supports more than two legs (e.g. a fee split, or a
// mixed Dr/Cr fee pair).
function CryptoLabelManager({ accounts, cryptoLabels, onAdd, onUpdate, onDelete }) {
  const blankDraft = () => ({ label: "", legs: [{ accountId: "", side: "credit", pct: 100 }] });
  const [draft, setDraft] = useState(blankDraft());
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [search, setSearch] = useState("");

  const acctLabel = (id) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} - ${a.name}` : "-"; };
  const acctCode = (id) => accounts.find((x) => x.id === id)?.code || "?";
  // Direction/net are computed from the non-wallet (contra) legs only - a
  // wallet leg is posted by the cost-basis engine, not the label.
  const netPct = (legs) => legs.filter((l) => !l.wallet).reduce((s, l) => s + (l.side === "credit" ? (Number(l.pct) || 0) : -(Number(l.pct) || 0)), 0);
  // A label with no contra leg but two+ wallet legs (one a debit) is an internal
  // transfer - applying it moves crypto between wallets via the FIFO engine.
  const isTransferLegs = (legs) => { const w = legs.filter((l) => l.wallet); return legs.filter((l) => !l.wallet).length === 0 && w.length >= 2 && w.some((l) => l.side === "debit"); };
  const dirOf = (legs) => { if (isTransferLegs(legs)) return "Transfer"; if (legs.filter((l) => !l.wallet).length === 0) return null; const n = netPct(legs); if (Math.abs(n - 100) < 0.01) return "Deposit"; if (Math.abs(n + 100) < 0.01) return "Withdrawal"; return null; };
  // A wallet leg on a #Crypto or #Stablecoin custody account auto-routes to its
  // sibling by the coin's asset type, so one label covers both. Returns a note
  // naming the sibling it also routes to, or "" when there's no sibling.
  const acctName = (id) => accounts.find((x) => x.id === id)?.name || "";
  const siblingNoteForLeg = (leg) => {
    if (!leg?.wallet) return "";
    const name = acctName(leg.accountId);
    const mkSibling = (tag, repl) => {
      const target = name.replace(new RegExp(`#\\s*${tag}`, "i"), `#${repl}`);
      const a = accounts.find((x) => x.name.toLowerCase() === target.toLowerCase());
      return a ? `${a.code} #${repl}` : "";
    };
    if (/#\s*crypto/i.test(name)) { const sib = mkSibling("crypto", "Stablecoin"); return sib ? `USDT/USDC auto-route to ${sib}` : ""; }
    if (/#\s*stablecoin/i.test(name)) { const sib = mkSibling("stablecoin", "Crypto"); return sib ? `other crypto auto-routes to ${sib}` : ""; }
    return "";
  };
  const autoRouteNote = (legs) => { for (const l of (legs || [])) { const n = siblingNoteForLeg(l); if (n) return n; } return ""; };
  const legsText = (legs) => (legs || []).map((l) => `${l.side === "debit" ? "Dr" : "Cr"} ${l.pct}%${l.wallet ? " wallet" : ""} ${acctCode(l.accountId)}`).join(" · ");

  const q = search.trim().toLowerCase();
  const shownLabels = q
    ? cryptoLabels.filter((l) => l.label.toLowerCase().includes(q) || (l.legs || []).some((leg) => acctLabel(leg.accountId).toLowerCase().includes(q)))
    : cryptoLabels;

  const cleanLegs = (legs) => legs.map((l) => ({ accountId: l.accountId, side: l.side, pct: Number(l.pct), ...(l.wallet ? { wallet: true } : {}) }));
  function valid(form) {
    // Every leg needs an account and a nonzero pct. Direction isn't required to
    // save (a full-entry reference label may not net to a crypto contra).
    return form.label.trim() && form.legs.length > 0 && form.legs.every((l) => l.accountId && Number(l.pct) > 0);
  }
  function submitNew() {
    if (!valid(draft)) return;
    onAdd({ label: draft.label.trim(), legs: cleanLegs(draft.legs) });
    setDraft(blankDraft());
  }
  function startEdit(l) { setEditingId(l.id); setEditForm({ label: l.label, kind: l.kind, fullEntry: l.fullEntry, appliesTo: l.appliesTo, withdrawFeeRevenue: l.withdrawFeeRevenue, feeAccountId: l.feeAccountId, feeReceivableAccountId: l.feeReceivableAccountId, legs: (l.legs || []).map((x) => ({ accountId: x.accountId, side: x.side, pct: x.pct, wallet: x.wallet })) }); }
  function saveEdit() {
    if (!valid(editForm)) return;
    onUpdate(editingId, { label: editForm.label.trim(), legs: cleanLegs(editForm.legs), ...(editForm.kind ? { kind: editForm.kind } : {}), ...(editForm.fullEntry ? { fullEntry: true, appliesTo: editForm.appliesTo } : {}), ...(editForm.withdrawFeeRevenue ? { withdrawFeeRevenue: true, feeAccountId: editForm.feeAccountId, feeReceivableAccountId: editForm.feeReceivableAccountId } : {}) });
    setEditingId(null); setEditForm(null);
  }

  const renderLegEditor = (form, setForm) => {
    const dir = dirOf(form.legs);
    const net = netPct(form.legs);
    return (
      <div className="space-y-1.5">
        {form.legs.map((leg, i) => (
          <div key={i} className={`flex items-center gap-2 ${leg.wallet ? "opacity-70" : ""}`}>
            <select value={leg.side} onChange={(e) => setForm({ ...form, legs: form.legs.map((l, idx) => (idx === i ? { ...l, side: e.target.value } : l)) })}
              className="border border-stone-300 rounded px-2 py-1 text-xs w-16">
              <option value="debit">Dr</option>
              <option value="credit">Cr</option>
            </select>
            <div className="flex-1">
              <AccountSelect accounts={accounts} value={leg.accountId}
                onChange={(val) => setForm({ ...form, legs: form.legs.map((l, idx) => (idx === i ? { ...l, accountId: val } : l)) })}
                placeholder="- choose account -" className="w-full border border-stone-300 rounded px-2 py-1 text-xs" />
            </div>
            <input type="number" step="any" value={leg.pct}
              onChange={(e) => setForm({ ...form, legs: form.legs.map((l, idx) => (idx === i ? { ...l, pct: e.target.value } : l)) })}
              className="w-20 border border-stone-300 rounded px-2 py-1 text-xs font-mono text-right" />
            <span className="text-xs text-slate-400 w-3">%</span>
            <label className="flex items-center gap-1 text-[11px] text-slate-500 shrink-0" title="Wallet leg - posted automatically by cost-basis tracking, not by this label">
              <input type="checkbox" checked={!!leg.wallet} onChange={(e) => setForm({ ...form, legs: form.legs.map((l, idx) => (idx === i ? { ...l, wallet: e.target.checked } : l)) })} />
              wallet
            </label>
            <button onClick={() => setForm({ ...form, legs: form.legs.filter((_, idx) => idx !== i) })} disabled={form.legs.length <= 1}
              className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30 shrink-0"><Trash2 size={13} /></button>
          </div>
        ))}
        {form.withdrawFeeRevenue && [
          { side: "Dr", acct: form.feeReceivableAccountId || "acc_140101" },
          { side: "Cr", acct: form.feeAccountId || "acc_410101" },
        ].map((r, i) => (
          <div key={`fee-${i}`} className="flex items-center gap-2" title="Withdrawal fee - the flat per-coin fee from the Settings schedule (Dr fee receivable / Cr fee revenue); the monthly sweep later collects the receivable">
            <span className="border border-stone-200 bg-stone-50 rounded px-2 py-1 text-xs w-16 text-center text-slate-500">{r.side}</span>
            <div className="flex-1 border border-stone-200 bg-stone-50 rounded px-2 py-1 text-xs text-slate-600 truncate">{acctLabel(r.acct)}</div>
            <span className="w-20 text-right text-xs text-[#02B169] font-medium">fee</span>
            <span className="text-xs text-slate-400 w-3" />
            <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">from schedule</span>
            <span className="w-[13px] shrink-0" />
          </div>
        ))}
        <div className="flex items-center gap-3 pt-0.5">
          <button onClick={() => setForm({ ...form, legs: [...form.legs, { accountId: "", side: form.legs.some((l) => l.side === "credit") ? "credit" : "debit", pct: 0 }] })}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"><Plus size={12} /> Add leg</button>
          {(() => { const feDr = form.fullEntry ? form.legs.filter((l) => l.side === "debit").reduce((s, l) => s + (Number(l.pct) || 0), 0) : 0; const feCr = form.fullEntry ? form.legs.filter((l) => l.side === "credit").reduce((s, l) => s + (Number(l.pct) || 0), 0) : 0; const feBal = Math.abs(feDr - feCr) < 0.01; return (
          <span className={`text-xs ${form.fullEntry ? (feBal ? "text-[#02B169]" : "text-[#B45309]") : (form.kind === "trade" || dir ? "text-[#02B169]" : "text-[#B45309]")}`}>
            {form.fullEntry ? (feBal ? `Full journal entry → posts verbatim on ${form.appliesTo || "?"}s (no FIFO; must self-balance, Dr ${feDr}% = Cr ${feCr}%)` : `Full entry must self-balance - Dr ${feDr}% ≠ Cr ${feCr}%`)
              : form.kind === "trade" ? "Venue spot trade → swaps the two coins (fee is folded into cost basis; the engine adds one only if the price shows a spread)"
              : dir === "Transfer" ? "Wallet-to-wallet → applies to internal Transfers (FIFO moves the cost basis)"
              : dir ? `Contra nets ${net > 0 ? "+" : ""}${net}% → applies to ${dir}s`
              : `Contra nets ${net > 0 ? "+" : ""}${net}% - reference only (doesn't net to a crypto deposit/withdrawal)`}
          </span>
          ); })()}
        </div>
        {autoRouteNote(form.legs) && (
          <div className="flex items-center gap-1.5 text-xs text-[#0369A1] bg-[#EFF6FF] border border-[#BFDBFE] rounded px-2 py-1">
            <ArrowLeftRight size={12} className="shrink-0" />
            <span>Covers both asset types — the wallet leg auto-routes by coin: {autoRouteNote(form.legs)}.</span>
          </div>
        )}
        {form.withdrawFeeRevenue && (
          <div className="flex items-center gap-1.5 text-xs text-[#02B169] bg-[#E6FBF1] border border-[#A7F3D0] rounded px-2 py-1">
            <ArrowLeftRight size={12} className="shrink-0" />
            <span>Withdrawal fee auto-applied: the flat per-coin fee from the Settings schedule is carved out of the gross and booked to fee revenue - no fee leg needed here.</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm mb-5">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-3">New label</div>
        <label className="block text-[11px] text-slate-500 mb-1">Label Name</label>
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="e.g. Client custody deposit" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm mb-3" />
        <div className="text-[11px] text-slate-500 mb-1.5">Contra legs (the non-wallet side, as % of the transaction value):</div>
        {renderLegEditor(draft, setDraft)}
        <p className="text-[11px] text-slate-400 mt-2">The wallet/cost-basis side is posted automatically. A single Credit leg at 100% is a plain deposit contra; add more legs to split across accounts or add a fee pair.</p>
        <button onClick={submitNew} disabled={!valid(draft)}
          className="flex items-center gap-1.5 bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full mt-3">
          <Plus size={14} /> Add label
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Label Mapping ({q ? `${shownLabels.length} of ${cryptoLabels.length}` : cryptoLabels.length})
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search labels or accounts…"
          className="border border-stone-300 rounded px-2 py-1 text-xs w-56" />
      </div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden max-h-[520px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
              <th className="text-left px-3 py-2 font-medium">Label Name</th>
              <th className="text-left px-3 py-2 font-medium">Legs (Dr/Cr · % · account)</th>
              <th className="text-left px-3 py-2 font-medium w-24">Applies to</th>
              <th className="px-3 py-2 w-16" />
            </tr>
          </thead>
          <tbody>
            {shownLabels.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-sm text-slate-400">{cryptoLabels.length === 0 ? "No labels yet - add one above, then apply it to transactions in Needs review." : "No labels match your search."}</td></tr>
            )}
            {shownLabels.map((l) => (
              editingId === l.id ? (
                <tr key={l.id} className="border-b border-stone-100 last:border-0 bg-[#E6FBF1]/30">
                  <td className="px-3 py-2" colSpan={4}>
                    <input value={editForm.label} onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                      className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm mb-2" />
                    {renderLegEditor(editForm, setEditForm)}
                    <div className="flex gap-2 mt-2">
                      <button onClick={saveEdit} disabled={!valid(editForm)} className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-3 py-1 rounded-full">Save</button>
                      <button onClick={() => { setEditingId(null); setEditForm(null); }} className="text-xs text-slate-400 hover:text-slate-600 px-2">Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={l.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 font-medium align-top">
                    {l.label}
                    {autoRouteNote(l.legs) && (
                      <span title={`Covers both asset types — the wallet leg auto-routes by coin: ${autoRouteNote(l.legs)}`}
                        className="ml-2 inline-flex items-center gap-1 text-[10px] font-normal text-[#0369A1] bg-[#EFF6FF] border border-[#BFDBFE] rounded px-1.5 py-0.5 align-middle">
                        <ArrowLeftRight size={10} /> stablecoin + crypto
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs align-top">
                    {legsText(l.legs)}
                    {l.withdrawFeeRevenue && <span className="text-[#02B169]"> · Dr {acctCode(l.feeReceivableAccountId || "acc_140101")} · Cr {acctCode(l.feeAccountId || "acc_410101")} (fee, schedule)</span>}
                  </td>
                  <td className="px-3 py-2 text-xs align-top">{l.fullEntry ? `${l.appliesTo || "?"} (full entry)` : l.kind === "trade" ? "Trade" : (dirOf(l.legs || []) || <span className="text-[#B45309]">needs fix</span>)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap align-top">
                    <button onClick={() => startEdit(l)} className="text-slate-300 hover:text-slate-600 mr-2"><Pencil size={13} /></button>
                    <button onClick={() => onDelete(l.id)} className="text-slate-300 hover:text-[#B91C1C]"><Trash2 size={13} /></button>
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Lets someone start mapping a transaction type the app has never seen,
// rather than only being able to react to the three canned "Simulate" events.
// The result is pushed through the same tryPostEvent path as any real event -
// it'll land in "Needs mapping" (or auto-post if it happens to already match
// an active template).
function CustomEventForm({ onAddEvent }) {
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState("");
  const [venue, setVenue] = useState("");
  const [fields, setFields] = useState([{ key: "", value: "" }]);

  function updateField(i, patch) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields((prev) => [...prev, { key: "", value: "" }]);
  }
  function removeField(i) {
    setFields((prev) => prev.filter((_, idx) => idx !== i));
  }
  // Amount fields need to be actual numbers (not strings) to show up as
  // eligible "amount field" options later in the mapping builder.
  function inferValue(raw) {
    const trimmed = raw.trim();
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    return trimmed;
  }
  function reset() {
    setEventType("");
    setVenue("");
    setFields([{ key: "", value: "" }]);
  }
  function submit() {
    if (!eventType.trim()) return;
    const event = { eventType: eventType.trim() };
    if (venue.trim()) event.venue = venue.trim();
    fields.forEach((f) => {
      if (f.key.trim()) event[f.key.trim()] = inferValue(f.value);
    });
    onAddEvent(event);
    reset();
    setOpen(false);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs border border-dashed border-stone-300 rounded px-2.5 py-1.5 text-slate-500 hover:bg-stone-50 hover:text-slate-700 mb-6">
        <Plus size={12} /> Start mapping a new transaction type
      </button>
    );
  }

  return (
    <div className="bg-white border-2 border-[#03D47C]/30 rounded-lg p-4 shadow-sm mb-6">
      <div className="text-xs font-semibold uppercase tracking-wide text-[#02B169] mb-3">
        New transaction type - describe what a real one looks like
      </div>

      <div className="flex gap-3 mb-3">
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">Event type ID</label>
          <input value={eventType} onChange={(e) => setEventType(e.target.value)}
            placeholder="e.g. SWAP_EXECUTED"
            className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">Venue (optional)</label>
          <input value={venue} onChange={(e) => setVenue(e.target.value)}
            placeholder="e.g. OKX"
            className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" />
        </div>
      </div>

      <label className="block text-xs text-slate-500 mb-1">Other fields the mapping will need (at least one amount)</label>
      {fields.map((f, i) => (
        <div key={i} className="flex items-center gap-2 mb-1.5">
          <input value={f.key} onChange={(e) => updateField(i, { key: e.target.value })}
            placeholder="field name, e.g. feeAmount"
            className="flex-1 border border-stone-300 rounded px-2 py-1 text-xs font-mono" />
          <input value={f.value} onChange={(e) => updateField(i, { value: e.target.value })}
            placeholder="value, e.g. 4.20"
            className="flex-1 border border-stone-300 rounded px-2 py-1 text-xs font-mono" />
          <button onClick={() => removeField(i)} disabled={fields.length <= 1}
            className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30 shrink-0">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button onClick={addField} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mt-1 mb-3">
        <Plus size={12} /> Add field
      </button>

      <div className="flex gap-2">
        <button onClick={submit} disabled={!eventType.trim()}
          className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
          Create event
        </button>
        <button onClick={() => { reset(); setOpen(false); }} className="bg-[#F3F4F6] hover:bg-[#E5E7EB] text-black text-sm px-3 py-1.5 rounded-full">
          Cancel
        </button>
      </div>
    </div>
  );
}

function TemplateBuilder({ sampleTx, existingTemplate, accounts, registrySize, onCancel, onSave }) {
  const suggestion = !existingTemplate ? SUGGESTIONS[sampleTx.eventType] : null;
  const stringFields = Object.keys(sampleTx).filter((k) => typeof sampleTx[k] === "string" && k !== "id");
  const numericFields = Object.keys(sampleTx).filter((k) => typeof sampleTx[k] === "number");
  const sortedAccounts = accounts.slice().sort((a, b) => a.code.localeCompare(b.code));

  // A leg is "custom" (free-text) if its accountRef doesn't match a real
  // account name as-is - covers both an unresolved {field} placeholder and
  // any stale reference to an account that's since been renamed/deleted.
  const inferCustom = (ref) => !!ref && (ref.includes("{") || !accounts.some((a) => a.name === ref));

  const [code, setCode] = useState(existingTemplate?.code || `T${registrySize + 1}`);
  const [label, setLabel] = useState(existingTemplate?.label || suggestion?.label || sampleTx.eventType);
  const [matchFields, setMatchFields] = useState(
    existingTemplate ? (existingTemplate.matchRule.all || []).map((r) => r.field) : suggestion?.matchFields || ["eventType"]
  );
  const [legs, setLegs] = useState(
    (existingTemplate?.legs || suggestion?.legs || [
      { accountRef: "", side: "debit", mode: "pct", baseField: numericFields[0] || "", pct: 100 },
      { accountRef: "", side: "credit", mode: "pct", baseField: numericFields[0] || "", pct: 100 },
    ]).map((l) => ({
      ...l,
      mode: legMode(l),
      baseField: legBaseField(l),
      pct: legPct(l),
      fixedAmount: Number.isFinite(l.fixedAmount) ? l.fixedAmount : "",
      custom: inferCustom(l.accountRef),
    }))
  );

  function updateLeg(i, patch) {
    setLegs((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLeg() {
    setLegs((prev) => [...prev, { accountRef: "", side: "debit", mode: "pct", baseField: numericFields[0] || "", pct: 100, fixedAmount: "", custom: false }]);
  }
  function removeLeg(i) {
    setLegs((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function toggleMatchField(f) {
    if (f === "eventType") return; // always required - it's the primary signature
    setMatchFields((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  }

  const previewLegs = buildLegs({ legs }, sampleTx, accounts);
  const check = balanceCheck(previewLegs);
  // A leg is "missing its amount" differently depending on mode: a pct leg
  // needs a field to reference, a fixed leg needs a real typed-in number.
  const legAmountMissing = (l) => (l.mode === "fixed" ? !(Number.isFinite(Number(l.fixedAmount)) && Number(l.fixedAmount) > 0) : !l.baseField);
  const missingAmountField = legs.some(legAmountMissing);
  const missingAccount = legs.some((l) => !l.accountRef.trim());
  const allResolved = legsResolved(previewLegs) && legs.every((l) => l.accountRef.trim() && !legAmountMissing(l));
  const canActivate = code.trim() && label.trim() && matchFields.length > 0 && allResolved && check.balanced;

  function activate() {
    const matchRule = { all: matchFields.map((f) => ({ field: f, equals: sampleTx[f] })) };
    const cleanLegs = legs.map(({ custom, ...l }) => l); // "custom" is UI-only, don't persist it
    onSave({ id: existingTemplate?.id || uid("type"), code: code.trim(), label: label.trim(), matchRule, legs: cleanLegs, status: "active" });
  }

  return (
    <div className="bg-white border-2 border-[#03D47C]/30 rounded-lg p-4 shadow-sm mb-6">
      <div className="text-xs font-semibold uppercase tracking-wide text-[#02B169] mb-3">
        {existingTemplate ? "Fix mapping" : "Define mapping"} - sample event: {sampleTx.eventType}
      </div>

      <div className="flex gap-3 mb-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" />
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-xs text-slate-500 mb-1">This mapping applies when</label>
        <div className="flex flex-wrap gap-3">
          {stringFields.map((f) => (
            <label key={f} className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border ${matchFields.includes(f) ? "border-[#03D47C]/50 bg-[#E6FBF1] text-[#02B169]" : "border-stone-200 text-slate-500"}`}>
              <input type="checkbox" checked={matchFields.includes(f)} disabled={f === "eventType"} onChange={() => toggleMatchField(f)} />
              {f} = {String(sampleTx[f])}
            </label>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <label className="block text-xs text-slate-500 mb-1">Legs</label>
        {/* Field name is free text (not locked to the sample event's own
            fields) - the sample event is just today's example, real events
            from the same source may use a different shape. Suggestions
            below (its numeric fields + whatever's already typed into other
            legs) are there to speed typing, not to constrain it. */}
        <datalist id="baseFieldOptions">
          {[...new Set([...numericFields, ...legs.map((l) => l.baseField).filter(Boolean)])].map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {numericFields.length === 0 && (
          <div className="text-xs text-[#B45309] bg-[#FFFBEB] border border-[#F59E0B]/30 rounded px-2.5 py-1.5 mb-2">
            This sample event has no numeric field to suggest - "%" legs still work, just type the field name a real event will carry (e.g. "amount"). Switch to "$" instead for a flat amount that never varies.
          </div>
        )}
        {legs.map((leg, i) => {
          const resolved = previewLegs[i];
          return (
            <div key={i} className="mb-2">
              <div className="flex items-center gap-2">
                <select value={leg.side} onChange={(e) => updateLeg(i, { side: e.target.value })}
                  className="border border-stone-300 rounded px-1.5 py-1 text-xs w-20 shrink-0">
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
                {leg.custom ? (
                  <input
                    value={leg.accountRef}
                    onChange={(e) => updateLeg(i, { accountRef: e.target.value })}
                    placeholder="Account text, e.g. Client custody payable - {venue}"
                    className={`flex-1 border rounded px-2 py-1 text-xs font-mono ${leg.accountRef && !resolved?.accountId ? "border-[#EF4444]/50" : "border-stone-300"}`}
                  />
                ) : (
                  <div className="flex-1">
                    <AccountSelect
                      accounts={sortedAccounts}
                      valueKey="name"
                      value={leg.accountRef}
                      onChange={(name) => updateLeg(i, { accountRef: name })}
                      allowClear
                      clearLabel="- choose account -"
                      placeholder="- choose account -"
                      className={`w-full border rounded px-2 py-1.5 text-xs ${leg.accountRef && !resolved?.accountId ? "border-[#EF4444]/50" : "border-stone-300"}`}
                    />
                  </div>
                )}
                <div className="flex border border-stone-300 rounded overflow-hidden shrink-0" role="group" aria-label="Amount mode">
                  <button type="button" onClick={() => updateLeg(i, { mode: "pct" })}
                    className={`px-1.5 py-1 text-xs ${leg.mode === "pct" ? "bg-[#03D47C] text-white" : "bg-white text-slate-500 hover:bg-stone-50"}`}
                    title="A percentage of one of the event's numeric fields">%</button>
                  <button type="button" onClick={() => updateLeg(i, { mode: "fixed" })}
                    className={`px-1.5 py-1 text-xs border-l border-stone-300 ${leg.mode === "fixed" ? "bg-[#03D47C] text-white" : "bg-white text-slate-500 hover:bg-stone-50"}`}
                    title="A flat dollar amount, not tied to any event field">$</button>
                </div>
                {leg.mode === "pct" ? (
                  <>
                    <input
                      list="baseFieldOptions"
                      value={leg.baseField}
                      onChange={(e) => updateLeg(i, { baseField: e.target.value })}
                      placeholder="amount field..."
                      title="The field name on the real event this leg's amount will come from - pick a suggestion or type your own"
                      className="border border-stone-300 rounded px-1.5 py-1 text-xs w-28 shrink-0 font-mono"
                    />
                    <div className="flex items-center gap-0.5 shrink-0">
                      <input
                        type="number" min="0" step="1" value={leg.pct}
                        onChange={(e) => updateLeg(i, { pct: e.target.value === "" ? "" : Number(e.target.value) })}
                        title="Percentage of the amount field this leg takes - 100 for the whole thing, less to split it across several legs"
                        className="w-14 border border-stone-300 rounded px-1.5 py-1 text-xs font-mono text-right"
                      />
                      <span className="text-xs text-slate-400">%</span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <span className="text-xs text-slate-400">$</span>
                    <input
                      type="number" min="0" step="0.01" value={leg.fixedAmount}
                      onChange={(e) => updateLeg(i, { fixedAmount: e.target.value === "" ? "" : Number(e.target.value) })}
                      placeholder="0.00"
                      title="Flat amount every time this template fires, regardless of the event's own fields"
                      className="w-24 border border-stone-300 rounded px-1.5 py-1 text-xs font-mono text-right"
                    />
                  </div>
                )}
                <span className="font-mono text-xs w-20 text-right shrink-0">
                  {Number.isFinite(resolved?.amount) ? money(resolved.amount) : "-"}
                </span>
                <button onClick={() => removeLeg(i)} disabled={legs.length <= 2} className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30 shrink-0">
                  <Trash2 size={13} />
                </button>
              </div>
              <button
                onClick={() => updateLeg(i, { custom: !leg.custom, accountRef: leg.custom ? "" : leg.accountRef })}
                className="text-[11px] text-slate-400 hover:text-slate-600 mt-0.5 ml-[88px]"
              >
                {leg.custom ? "<- choose from account list instead" : "type custom text instead (supports {field} placeholders)"}
              </button>
            </div>
          );
        })}
        {legs.map((leg, i) => previewLegs[i]?.accountRef && leg.accountRef && !previewLegs[i]?.accountId && (
          <div key={`err_${i}`} className="text-xs text-[#EF4444] mb-1">
            No account named "{previewLegs[i].resolvedName}" - add it in Chart of Accounts first.
          </div>
        ))}
        <button onClick={addLeg} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mt-1">
          <Plus size={12} /> Add leg
        </button>
      </div>

      {/* $0.00 debit vs $0.00 credit trivially "balances" - that's only a
          real answer once every leg actually has an account and an amount
          field to pull a number from, so those gaps get their own message
          instead of a misleading green checkmark. */}
      <div className={`flex items-center gap-1.5 text-xs mt-3 mb-3 ${
        missingAccount || missingAmountField ? "text-[#B45309]" : check.balanced ? "text-[#02B169]" : "text-[#EF4444]"
      }`}>
        <AlertTriangle size={13} className={missingAccount || missingAmountField || !check.balanced ? "" : "hidden"} />
        <CheckCircle2 size={13} className={!missingAccount && !missingAmountField && check.balanced ? "" : "hidden"} />
        {missingAccount
          ? "Choose an account for every leg first."
          : missingAmountField
          ? "Every leg needs an amount - pick a field for \"%\" legs, or type a number for \"$\" legs."
          : `Debit ${money(check.debit)} - Credit ${money(check.credit)} ${check.balanced ? "- balances." : "- not balanced yet."}`}
      </div>

      <div className="flex gap-2">
        <button onClick={activate} disabled={!canActivate}
          className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
          Activate - post automatically from now on
        </button>
        <button onClick={onCancel} className="bg-[#F3F4F6] hover:bg-[#E5E7EB] text-black text-sm px-3 py-1.5 rounded-full">Cancel</button>
      </div>
    </div>
  );
}

// ---------- Coins (master asset reference list) ----------

function CoinsScreen({ coins, onAdd, onUpdateRate, onRefreshRates, cryptoTxs = [], wallets = [], accounts = [] }) {
  const { t } = useLang();
  const [form, setForm] = useState({ symbol: "", name: "", rateSymbol: "", isFiat: false, assetType: "Crypto", chain: "", category: "", marketRate: "" });
  const [rateEdits, setRateEdits] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [rateStatus, setRateStatus] = useState(null);
  // Live rates auto-refresh while the Coins screen is open: once on mount, then
  // on a fixed interval. CoinGecko's keyless limit is ~10-30 calls/min, and each
  // refresh is a single batched call, so 30s (2 calls/min) stays well inside it.
  // A ref holds the latest handler so the interval can be set up once (stable),
  // and an in-flight guard prevents overlapping fetches.
  const RATE_REFRESH_MS = 30000;
  const onRefreshRef = useRef(onRefreshRates);
  onRefreshRef.current = onRefreshRates;
  const inFlightRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!onRefreshRef.current || inFlightRef.current) return;
      inFlightRef.current = true; setRefreshing(true);
      try {
        const r = await onRefreshRef.current();
        if (!cancelled) setRateStatus({ ok: true, updated: r.updated, skipped: r.skipped || [], at: Date.now() });
      } catch (e) {
        if (!cancelled) setRateStatus({ error: e.message || String(e) });
      } finally {
        inFlightRef.current = false;
        if (!cancelled) setRefreshing(false);
      }
    };
    run();
    const iv = setInterval(run, RATE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [subTab, setSubTab] = useState("coins");
  const [asAt, setAsAt] = useState(todayStr());
  // Which wallets the inventory is filtered to (empty set = all wallets).
  const [invWallets, setInvWallets] = useState(() => new Set());

  function submit() {
    if (!form.symbol.trim() || !form.name.trim()) return;
    onAdd({ ...form, rateSymbol: form.rateSymbol.trim() || form.symbol.trim(), marketRate: parseFloat(form.marketRate) || 0 });
    setForm({ symbol: "", name: "", rateSymbol: "", isFiat: false, assetType: "Crypto", chain: "", category: "", marketRate: "" });
  }

  // Point-in-time holdings: the FIFO cost-basis lots remaining from all posted
  // transactions dated on or before the as-at date, filtered to the chosen
  // wallets and aggregated per coin (units + cost basis; market value at the
  // coin's current rate).
  const inventory = useMemo(() => {
    const upTo = cryptoTxs.filter((t) => t.posted && t.date && t.date <= asAt);
    const layers = computeCryptoLedger(upTo, wallets, accounts, coins).remainingLayers;
    const useAll = invWallets.size === 0;
    const byCoin = new Map();
    layers.forEach((l) => {
      if (!useAll && !invWallets.has(l.walletId)) return;
      const cur = byCoin.get(l.coinId) || { units: 0, cost: 0 };
      cur.units += l.remaining;
      cur.cost += l.remaining * l.unitCost;
      byCoin.set(l.coinId, cur);
    });
    const rows = [...byCoin.entries()].map(([coinId, v]) => {
      const coin = coins.find((c) => c.id === coinId);
      const rate = Number(coin?.marketRate) || 0;
      const marketValue = v.units * rate;
      return { coinId, symbol: coin?.symbol || "?", name: coin?.name || "", units: v.units, cost: v.cost, avgCost: v.units ? v.cost / v.units : 0, rate, marketValue, unrealized: marketValue - v.cost };
    }).filter((r) => Math.abs(r.units) > 1e-9).sort((a, b) => b.marketValue - a.marketValue);
    return rows;
  }, [cryptoTxs, wallets, accounts, coins, asAt, invWallets]);
  const invTotals = inventory.reduce((s, r) => ({ cost: s.cost + r.cost, market: s.market + r.marketValue, unreal: s.unreal + r.unrealized }), { cost: 0, market: 0, unreal: 0 });
  const toggleInvWallet = (id) => setInvWallets((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const units = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_coins")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        The master list of assets Money Buddy prices and moves - separate from any wallet or holding. A wallet's balance is still tracked on its Chart of Accounts entry; this is just "what is this asset, and what's it worth."
      </p>

      <div className="flex gap-1 mb-4 border-b border-stone-200">
        {[["coins", "Coins"], ["inventory", "Inventory"]].map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${subTab === k ? "border-[#03D47C] text-[#02B169] font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {subTab === "inventory" && (
        <div>
          <div className="flex flex-wrap items-end gap-4 mb-4">
            <label className="text-xs text-slate-500">Holdings as at
              <span className="ml-1.5"><DateField value={asAt} onChange={setAsAt}
                className="border border-stone-300 rounded px-2 py-1 text-sm w-28" /></span>
            </label>
            <div className="text-xs text-slate-500">
              Wallets
              <div className="flex items-center gap-2 mt-1">
                <button onClick={() => setInvWallets(new Set())} className={`text-xs px-2 py-0.5 rounded-full border ${invWallets.size === 0 ? "border-[#03D47C] text-[#02B169] bg-[#E6FBF1]" : "border-stone-300 text-slate-500 hover:bg-stone-50"}`}>All wallets</button>
                {invWallets.size > 0 && <button onClick={() => setInvWallets(new Set())} className="text-xs text-slate-400 hover:text-[#B91C1C]">clear ({invWallets.size})</button>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {wallets.map((w) => {
              const on = invWallets.has(w.id);
              return (
                <button key={w.id} onClick={() => toggleInvWallet(w.id)}
                  className={`text-xs px-2 py-1 rounded-full border ${on ? "border-[#03D47C] text-[#02B169] bg-[#E6FBF1]" : "border-stone-300 text-slate-500 hover:bg-stone-50"}`}>
                  {w.name}
                </button>
              );
            })}
          </div>
          <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
                  <th className="text-left px-3 py-2 font-medium">Coin</th>
                  <th className="text-right px-3 py-2 font-medium">Units held</th>
                  <th className="text-right px-3 py-2 font-medium">Cost basis</th>
                  <th className="text-right px-3 py-2 font-medium">Avg cost</th>
                  <th className="text-right px-3 py-2 font-medium">Market rate</th>
                  <th className="text-right px-3 py-2 font-medium">Market value</th>
                  <th className="text-right px-3 py-2 font-medium">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {inventory.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No holdings as at {asAt}{invWallets.size > 0 ? " for the selected wallets" : ""}.</td></tr>}
                {inventory.map((r) => (
                  <tr key={r.coinId} className="border-b border-stone-100 last:border-0">
                    <td className="px-3 py-2"><span className="font-mono font-medium">{r.symbol}</span> <span className="text-slate-400 text-xs">{r.name}</span></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{units(r.units)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.cost)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.avgCost)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.rate)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.marketValue)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${r.unrealized >= 0 ? "text-[#02B169]" : "text-[#EF4444]"}`}>{r.unrealized >= 0 ? "+" : ""}{money(r.unrealized)}</td>
                  </tr>
                ))}
              </tbody>
              {inventory.length > 0 && (
                <tfoot>
                  <tr className="border-t border-stone-200 font-medium">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right font-mono">{money(invTotals.cost)}</td>
                    <td className="px-3 py-2" /><td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right font-mono">{money(invTotals.market)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${invTotals.unreal >= 0 ? "text-[#02B169]" : "text-[#EF4444]"}`}>{invTotals.unreal >= 0 ? "+" : ""}{money(invTotals.unreal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-2">Holdings are the remaining FIFO cost-basis lots from posted transactions dated on or before the as-at date. Cost basis and market value are in USD; market value uses each coin's current rate on the Coins tab.</p>
        </div>
      )}

      {subTab === "coins" && (
      <>
      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-6 shadow-sm">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-3">Add coin</div>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Symbol</label>
            <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
              placeholder="BTC" className="w-24 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-500 mb-1">Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Bitcoin" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Asset Type</label>
            <select value={form.assetType} onChange={(e) => setForm({ ...form, assetType: e.target.value })}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm">
              {["Crypto", "Stablecoin", "Fiat"].map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Chain</label>
            <input value={form.chain} onChange={(e) => setForm({ ...form, chain: e.target.value })}
              placeholder="Ethereum" className="w-28 border border-stone-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Market Rate (USD)</label>
            <input value={form.marketRate} onChange={(e) => setForm({ ...form, marketRate: e.target.value })}
              placeholder="0.00" className="w-28 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2">
            <input type="checkbox" checked={form.isFiat} onChange={(e) => setForm({ ...form, isFiat: e.target.checked })} />
            Is fiat
          </label>
          <button onClick={submit} className="flex items-center gap-1.5 bg-black hover:bg-[#4D4D4D] text-white text-sm px-3 py-1.5 rounded-full">
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Coins</div>
        <div className="flex items-center gap-1.5 text-xs">
          <RefreshCw size={12} className={refreshing ? "animate-spin text-slate-500" : "text-slate-400"} />
          {refreshing ? (
            <span className="text-slate-500">Updating live rates…</span>
          ) : rateStatus?.error ? (
            <span className="text-rose-600" title={rateStatus.error}>Live rates: {rateStatus.error.length > 44 ? rateStatus.error.slice(0, 44) + "…" : rateStatus.error}</span>
          ) : rateStatus?.ok ? (
            <span className="text-slate-500">
              Live rates auto-update · {new Date(rateStatus.at).toLocaleTimeString()}
              {rateStatus.skipped.length ? <span className="text-slate-400"> · {rateStatus.skipped.length} unmatched</span> : null}
            </span>
          ) : (
            <span className="text-slate-400">Live rates auto-update every 30 seconds</span>
          )}
        </div>
      </div>
      <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
              <th className="text-left px-3 py-2 font-medium">Symbol</th>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-left px-3 py-2 font-medium">Chain</th>
              <th className="text-right px-3 py-2 font-medium">Market Rate (USD)</th>
            </tr>
          </thead>
          <tbody>
            {coins.map((c) => (
              <tr key={c.id} className="border-b border-stone-100 last:border-0">
                <td className="px-3 py-2 font-mono font-medium">{c.symbol}</td>
                <td className="px-3 py-2">{c.name}</td>
                <td className="px-3 py-2 text-slate-500">{c.assetType}</td>
                <td className="px-3 py-2 text-slate-500">{c.chain || "-"}</td>
                <td className="px-3 py-2 text-right">
                  <input
                    value={rateEdits[c.id] ?? c.marketRate}
                    onChange={(e) => setRateEdits({ ...rateEdits, [c.id]: e.target.value })}
                    onBlur={(e) => onUpdateRate(c.id, parseFloat(e.target.value) || 0)}
                    className="w-28 text-right border border-transparent hover:border-stone-300 focus:border-stone-300 rounded px-2 py-1 text-sm font-mono tabular-nums"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

// ---------- Wallets (custody register) ----------

const WALLET_TYPES = ["Hot Wallet", "Cold Wallet", "Gas Wallet", "Exchange Spot", "Exchange Margin", "Exchange Futures", "DeFi Pool", "Earn / Staking", "Other"];
const COMPLIANCE_STATUSES = ["Verified", "Pending Review", "Flagged"];

// Gas-tank manager: register a fee-wallet address per chain and pull its
// on-chain native activity straight from the block explorer (Etherscan V2 for
// EVM chains, TronScan for Tron), importing top-ups as Deposits and gas spends
// as Fees. Each tank remembers a cursor (last block / timestamp) so Sync only
// fetches new activity. Fetching runs in the browser and needs an API key.
function GasTanksScreen({ gasTanks, wallets, onAdd, onUpdate, onRemove, onSync }) {
  const { t } = useLang();
  const [busy, setBusy] = useState({});
  const [results, setResults] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);

  // Every gas tank posts to the one company gas wallet (Bitgo gas wallet -
  // Company, 112106) - it's not a per-tank choice, so it's resolved here
  // rather than asked for.
  const gasWallet = wallets.find((w) => w.accountId === "acc_112106");
  const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString() : "never");

  function startEdit(g) { setEditingId(g.id); setEditForm({ chain: GAS_TANK_CHAINS[g.chain]?.sym || g.chain, address: g.address }); }
  function cancelEdit() { setEditingId(null); setEditForm(null); }
  function saveEdit() {
    const chainKey = resolveGasChainKey(editForm.chain);
    if (!editForm.address.trim() || !gasWallet || !chainKey) return;
    // Changing the address or chain invalidates the sync cursor - reset it so
    // the next Sync re-scans from the start for the new address.
    const g = gasTanks.find((x) => x.id === editingId);
    const reset = g && (g.address !== editForm.address.trim() || g.chain !== chainKey);
    onUpdate(editingId, { chain: chainKey, name: `${GAS_TANK_CHAINS[chainKey].sym} gas tank`, address: editForm.address.trim(), walletId: gasWallet.id, ...(reset ? { cursor: 0, lastSyncedAt: 0 } : {}) });
    setEditingId(null); setEditForm(null);
  }

  // Serialized across manual and auto runs: only one sync at a time (onSync
  // itself fetches each tank one after another), so calls never approach the
  // free plans' 5 req/sec limit.
  const inFlightRef = useRef(false);
  async function runSync(ids, tag) {
    if (!ids.length || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy((b) => ({ ...b, [tag]: true }));
    try {
      const res = await onSync(ids);
      setResults((r) => ({ ...r, ...res }));
    } catch (e) {
      const err = { error: e.message || String(e) };
      setResults((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, err])) }));
    } finally {
      inFlightRef.current = false;
      setBusy((b) => ({ ...b, [tag]: false }));
    }
  }
  const anyBusy = Object.values(busy).some(Boolean);

  // Auto-sync all tanks on an interval while this screen is open. Budget check
  // on the free plans (5 req/sec, 100k/day, per Etherscan & TronScan): a cycle
  // is ~2 calls per EVM tank + a short Tron page loop, run sequentially. At one
  // cycle every 3 minutes that's well under 5/sec and only a few thousand
  // calls/day even with the screen left open all day. Cursors mean each cycle
  // only pulls genuinely new activity. Refs keep the interval stable.
  const AUTO_SYNC_MS = 180000; // 3 minutes
  const [autoAt, setAutoAt] = useState(0);
  const syncRef = useRef(onSync); syncRef.current = onSync;
  const tanksRef = useRef(gasTanks); tanksRef.current = gasTanks;
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const ids = tanksRef.current.map((g) => g.id);
      if (!ids.length || inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy((b) => ({ ...b, all: true }));
      try {
        const res = await syncRef.current(ids);
        if (!cancelled) setResults((r) => ({ ...r, ...res }));
      } catch (e) {
        const err = { error: e.message || String(e) };
        if (!cancelled) setResults((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, err])) }));
      } finally {
        inFlightRef.current = false;
        if (!cancelled) { setBusy((b) => ({ ...b, all: false })); setAutoAt(Date.now()); }
      }
    };
    const iv = setInterval(tick, AUTO_SYNC_MS);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_gasTanks")}</h1>
      <p className="text-sm text-slate-500 mb-5">{t("subtitle_gasTanks")} API keys are set in Settings.</p>

      {/* Tank list */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Registered gas tanks</div>
        {gasTanks.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">
              {busy.all ? "Auto-syncing…" : autoAt ? `Auto-syncs every 3 min · last ${new Date(autoAt).toLocaleTimeString()}` : "Auto-syncs every 3 min"}
            </span>
            <button onClick={() => runSync(gasTanks.map((g) => g.id), "all")} disabled={anyBusy}
              className="flex items-center gap-1.5 bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-full">
              <RefreshCw size={13} className={busy.all ? "animate-spin" : ""} /> {busy.all ? "Syncing..." : "Sync now"}
            </button>
          </div>
        )}
      </div>

      {gasTanks.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-lg p-6 text-sm text-slate-500 shadow-sm">
          No gas tanks registered.
        </div>
      ) : (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
                <th className="text-left px-3 py-2 font-medium">Chain</th>
                <th className="text-left px-3 py-2 font-medium">Address</th>
                <th className="text-left px-3 py-2 font-medium">Post to</th>
                <th className="text-left px-3 py-2 font-medium">Last sync</th>
                <th className="text-left px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 w-40" />
              </tr>
            </thead>
            <tbody>
              {gasTanks.map((g) => {
                const cfg = GAS_TANK_CHAINS[g.chain];
                const res = results[g.id];
                if (editingId === g.id) {
                  return (
                    <tr key={g.id} className="border-b border-stone-100 last:border-0 bg-[#E6FBF1]/30">
                      <td className="px-3 py-1.5">
                        <input value={editForm.chain} onChange={(e) => setEditForm({ ...editForm, chain: e.target.value })}
                          placeholder="ETH, Polygon…" className="w-32 border border-stone-300 rounded px-2 py-1 text-sm" />
                      </td>
                      <td className="px-3 py-1.5"><input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} className="w-full border border-stone-300 rounded px-2 py-1 text-sm font-mono" /></td>
                      <td className="px-3 py-1.5 text-slate-500" colSpan={3}>{gasWallet?.name || "-"}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <button onClick={saveEdit} className="text-xs bg-black hover:bg-[#4D4D4D] text-white px-2.5 py-1 rounded-full mr-1">Save</button>
                        <button onClick={cancelEdit} className="text-xs border border-stone-300 px-2.5 py-1 rounded-full">Cancel</button>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={g.id} className="border-b border-stone-100 last:border-0">
                    <td className="px-3 py-2 whitespace-nowrap font-medium">{cfg ? `${cfg.label} (${cfg.sym})` : g.chain}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500" title={g.address}>{g.address.slice(0, 8)}…{g.address.slice(-6)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{gasWallet?.name || wallets.find((w) => w.id === g.walletId)?.name || "-"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{fmtWhen(g.lastSyncedAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {busy[g.id] ? <span className="text-slate-400">Syncing…</span>
                        : res?.error ? <span className="text-rose-600" title={res.error}>{res.error.length > 40 ? res.error.slice(0, 40) + "…" : res.error}</span>
                        : res ? <span className="text-emerald-600">+{res.added} added{res.dupes ? `, ${res.dupes} dup` : ""}{res.skipped ? `, ${res.skipped} skip` : ""}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => runSync([g.id], g.id)} disabled={anyBusy}
                        className="inline-flex items-center gap-1 text-xs bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white px-2.5 py-1 rounded-full mr-1">
                        <RefreshCw size={12} className={busy[g.id] ? "animate-spin" : ""} /> Sync
                      </button>
                      <button onClick={() => startEdit(g)} className="text-slate-400 hover:text-black p-1"><Pencil size={14} /></button>
                      <button onClick={() => onRemove(g.id)} className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400 mt-3">
        Sync pulls only native-coin activity since the last sync: coin received = a Deposit (cost basis), coin sent + gas = a Fee. Imported rows land in Crypto Transactions › Needs review, where the gas-fee label posts them (Dr Gas fee / Cr the tank's wallet). Set an ETH and TRX market rate so those fees carry a USD value; Avalanche and Polygon include a price on-chain.
      </p>
    </div>
  );
}

function WalletsScreen({ wallets, accounts, onAdd, onUpdate, onDelete }) {
  const { t } = useLang();
  const eligibleAccounts = accounts.filter((a) => a.type === "Asset" && !a.isBank);
  const [form, setForm] = useState({ accountId: "", name: "", address: "", walletType: "Hot Wallet", venue: "", blockchain: "", complianceStatus: "Verified" });
  // Editing one row at a time - a copy of that wallet's fields, only
  // written back (via onUpdate) on Save; Cancel just drops the copy.
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);

  function submit() {
    if (!form.accountId) return;
    onAdd(form);
    setForm({ accountId: "", name: "", address: "", walletType: "Hot Wallet", venue: "", blockchain: "", complianceStatus: "Verified" });
  }

  function startEdit(w) {
    setEditingId(w.id);
    setEditForm({ accountId: w.accountId, name: w.name, walletType: w.walletType, venue: w.venue || "", address: w.address || "", complianceStatus: w.complianceStatus });
  }
  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
  }
  function saveEdit() {
    if (!editForm.name.trim() || !editForm.accountId) return;
    onUpdate(editingId, editForm);
    setEditingId(null);
    setEditForm(null);
  }

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_wallets")}</h1>
      <p className="text-sm text-slate-500 mb-5">
        Custody locations - each wallet links to an existing Asset account in the Chart of Accounts, which stays the source of truth for its balance. This adds address, custody type, and compliance metadata on top, without creating a second parallel account.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-6 shadow-sm">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-3">Add wallet</div>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-slate-500 mb-1">Linked account</label>
            <AccountSelect
              accounts={eligibleAccounts.filter((a) => !wallets.some((w) => w.accountId === a.id))}
              value={form.accountId}
              onChange={(val) => {
                const acc = eligibleAccounts.find((a) => a.id === val);
                setForm({ ...form, accountId: val, name: form.name || acc?.name || "" });
              }}
              allowClear
              clearLabel="- choose account -"
              placeholder="- choose account -"
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Wallet Type</label>
            <select value={form.walletType} onChange={(e) => setForm({ ...form, walletType: e.target.value })}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm">
              {WALLET_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Venue</label>
            <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })}
              placeholder="Bitgo, Binance..." className="w-32 border border-stone-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Address</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="0x... (optional)" className="w-40 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Compliance</label>
            <select value={form.complianceStatus} onChange={(e) => setForm({ ...form, complianceStatus: e.target.value })}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm">
              {COMPLIANCE_STATUSES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <button onClick={submit} disabled={!form.accountId}
            className="flex items-center gap-1.5 bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Linked Account</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-left px-3 py-2 font-medium">Venue</th>
              <th className="text-left px-3 py-2 font-medium">Address</th>
              <th className="text-left px-3 py-2 font-medium">Compliance</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => {
              const acc = accounts.find((a) => a.id === w.accountId);
              if (editingId === w.id) {
                // The linked-account dropdown offers every unlinked account
                // plus whichever one this wallet already has (otherwise its
                // own current value would vanish from the list).
                const accountOptions = eligibleAccounts.filter(
                  (a) => a.id === editForm.accountId || !wallets.some((ow) => ow.accountId === a.id)
                );
                return (
                  <tr key={w.id} className="border-b border-stone-100 last:border-0 bg-[#E6FBF1]/30">
                    <td className="px-3 py-1.5">
                      <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        className="w-full border border-stone-300 rounded px-2 py-1 text-sm" />
                    </td>
                    <td className="px-3 py-1.5">
                      <AccountSelect
                        accounts={accountOptions}
                        value={editForm.accountId}
                        onChange={(val) => setEditForm({ ...editForm, accountId: val })}
                        className="w-full border border-stone-300 rounded px-2 py-1 text-xs"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <select value={editForm.walletType} onChange={(e) => setEditForm({ ...editForm, walletType: e.target.value })}
                        className="w-full border border-stone-300 rounded px-2 py-1 text-sm">
                        {WALLET_TYPES.map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={editForm.venue} onChange={(e) => setEditForm({ ...editForm, venue: e.target.value })}
                        placeholder="Bitgo, Binance..." className="w-full border border-stone-300 rounded px-2 py-1 text-sm" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                        placeholder="0x... (optional)" className="w-full border border-stone-300 rounded px-2 py-1 text-xs font-mono" />
                    </td>
                    <td className="px-3 py-1.5">
                      <select value={editForm.complianceStatus} onChange={(e) => setEditForm({ ...editForm, complianceStatus: e.target.value })}
                        className="w-full border border-stone-300 rounded px-2 py-1 text-sm">
                        {COMPLIANCE_STATUSES.map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button onClick={saveEdit} disabled={!editForm.name.trim() || !editForm.accountId}
                          className="text-[#03B469] enabled:hover:text-[#02B169] disabled:opacity-30" title="Save">
                          <CheckCircle2 size={15} />
                        </button>
                        <button onClick={cancelEdit} className="text-slate-300 hover:text-slate-600" title="Cancel">
                          <XCircle size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={w.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 font-medium">
                    <div className="flex items-center gap-1.5">
                      <WalletIcon size={13} className="text-slate-400" /> {w.name}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-500 font-mono text-xs">{acc ? `${acc.code} - ${acc.name}` : "-"}</td>
                  <td className="px-3 py-2 text-slate-500">{w.walletType}</td>
                  <td className="px-3 py-2 text-slate-500">{w.venue || "-"}</td>
                  <td className="px-3 py-2 text-slate-400 font-mono text-xs truncate max-w-[160px]">{w.address || "-"}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      w.complianceStatus === "Verified" ? "bg-[#E6FBF1] text-[#02B169]" :
                      w.complianceStatus === "Flagged" ? "bg-[#FEF2F2] text-[#EF4444]" : "bg-[#FFFBEB] text-[#B45309]"
                    }`}>{w.complianceStatus}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => startEdit(w)} className="text-slate-300 hover:text-slate-600" title="Edit">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => onDelete(w.id)} className="text-slate-300 hover:text-[#B91C1C]" title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {wallets.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No wallets yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Crypto Transactions ----------

function CryptoTransactions({ cryptoTxs, coins, wallets, accounts, cryptoLedger, cryptoRules, cryptoLabels = [], cryptoFilters = [], onAddFilter, onDeleteFilter, walletLabelRules, onAdd, onUpdate, onDelete, onBuildJournals, onPostReady, onLoadSample, onImportCsv, onPostOne, onBulkPost, onBulkLabelPost, onRemember, onRememberLabel, onAutoMapFilter }) {
  const { t } = useLang();
  const [showForm, setShowForm] = useState(false);
  const [subTab, setSubTab] = useState("transactions");
  // Transaction filter (Cryptio-style) - a set of AND conditions applied to
  // all three sections, plus a panel toggle and a save-as-favorite name.
  const [filterOpen, setFilterOpen] = useState(false);
  const [conditions, setConditions] = useState([]);
  const [favName, setFavName] = useState("");
  const [sampleResult, setSampleResult] = useState(null);
  // Needs Review state - same shape as Categorize: a per-row chosen account,
  // a "remember this" flag, and a split editor (open + its rows) keyed by tx id.
  const [choice, setChoice] = useState({});
  // A label staged on a row - selecting one from the dropdown only stages it
  // (nothing is written to the ledger yet); it's applied and posted when the
  // row's Post button is clicked. Choosing a label and choosing an account are
  // mutually exclusive per row.
  const [labelChoice, setLabelChoice] = useState({});
  const [remember, setRemember] = useState({});
  const [splitMode, setSplitMode] = useState({});
  const [splitRows, setSplitRows] = useState({});
  const [postError, setPostError] = useState({});
  // Which Needs Review rows have their full-detail panel expanded (so a row
  // whose one-line summary is truncated - or blank - can be inspected in full
  // without leaving the list).
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpanded = (id) => setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Bulk-post state - a set of selected Needs Review row ids (only the
  // "pick one ledger account" rows are eligible; Transfer-needing-wallet and
  // split rows aren't, since neither fits "one account for every selected
  // row"), plus the one account/remember choice applied to all of them.
  const [bulkSelected, setBulkSelected] = useState(() => new Set());
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [bulkRemember, setBulkRemember] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkLabelId, setBulkLabelId] = useState("");
  // When rows are selected, the Needs Review list narrows to just the selection
  // so you can focus on the batch you're about to label/post. "Show all" reveals
  // the rest without dropping the selection.
  const [showAllReview, setShowAllReview] = useState(false);
  // Complete/Incomplete COA filter (Cryptio-style) - which of the three
  // stacked sections to show. "incomplete" = only the Needs review bucket
  // (transactions whose ledger mapping isn't resolved yet); "complete" =
  // only Ready to build + Posted (mapping resolved). Handy once an import
  // drops hundreds of rows and you want to focus on just the unresolved ones.
  const [coaFilter, setCoaFilter] = useState("all");
  // Asset Roll Forward date range - defaults to the full span of posted
  // activity, editable per report run.
  const postedDates = cryptoTxs.filter((t) => t.posted).map((t) => t.date).sort();
  const [rfStart, setRfStart] = useState("");
  const [rfEnd, setRfEnd] = useState("");
  const rfStartEff = rfStart || postedDates[0] || todayStr();
  const rfEndEff = rfEnd || postedDates[postedDates.length - 1] || todayStr();
  const rollForward = useMemo(
    () => computeAssetRollForward(cryptoTxs, wallets, accounts, coins, rfStartEff, rfEndEff),
    [cryptoTxs, wallets, accounts, coins, rfStartEff, rfEndEff]
  );

  // Active filter conditions (blank-value rows are ignored by the predicate).
  const filterCtx = { coins, wallets };
  const activeConditions = conditions.filter((c) => c.value !== undefined && c.value !== "");
  const passesFilter = (tx) => matchesCryptoFilter(tx, activeConditions, filterCtx);

  const drafts = cryptoTxs.filter((t) => !t.posted && passesFilter(t)).sort((a, b) => a.date.localeCompare(b.date));
  const posted = cryptoTxs.filter((t) => t.posted && passesFilter(t)).sort((a, b) => b.date.localeCompare(a.date));

  // What would happen if we built journals right now - used to split Drafts
  // into "needs review" (missing a field, or otherwise doesn't resolve) vs
  // "ready to build" (fully specified, just waiting on Build Journals).
  const attempt = useMemo(() => computeCryptoLedger(cryptoTxs, wallets, accounts, coins), [cryptoTxs, wallets, accounts, coins]);
  const needsReview = drafts.filter((t) => !attempt.linesByTx.has(t.id));
  const readyDrafts = drafts.filter((t) => attempt.linesByTx.has(t.id));
  // Build Journals posts every resolvable draft regardless of the current
  // filter, so its button count comes from the full (unfiltered) set.
  const buildableCount = cryptoTxs.filter((t) => !t.posted && attempt.linesByTx.has(t.id)).length;

  // Data-quality health metric - what share of all crypto transactions still
  // need a human to finish their COA mapping (mirrors Cryptio's "Needs
  // review 47%" badge). Everything not in Needs review is considered
  // complete (ready to build or already posted).
  // Health metric reflects the whole ledger, not the filtered view.
  const totalTx = cryptoTxs.length;
  const unfilteredNeedsReview = cryptoTxs.filter((t) => !t.posted && !attempt.linesByTx.has(t.id)).length;
  const needsReviewPct = totalTx ? Math.round((unfilteredNeedsReview / totalTx) * 100) : 0;

  // Only the "pick one ledger account" rows are eligible for bulk-post - a
  // Transfer needing its destination wallet, and a row already split across
  // several accounts, don't fit "one account applied to every selected row".
  const bulkEligible = needsReview.filter((t) => t.type !== "Transfer" && !splitMode[t.id]);
  const bulkEligibleIds = bulkEligible.map((t) => t.id);
  const bulkSelectedTxs = bulkEligible.filter((t) => bulkSelected.has(t.id));
  // Not enforced (a user might genuinely want one account for a mixed batch)
  // but surfaced - the ask was specifically "the same type at a time", so a
  // mixed selection gets a visible heads-up rather than silently proceeding.
  const bulkSelectedTypes = new Set(bulkSelectedTxs.map((t) => t.type));

  function coinSymbol(id) { return coins.find((c) => c.id === id)?.symbol || "-"; }
  function coinName(id) { return coins.find((c) => c.id === id)?.name || ""; }
  function walletName(id) { return wallets.find((w) => w.id === id)?.name || "-"; }
  function accountLabel(id) { const a = accounts.find((x) => x.id === id); return a ? `${a.code} - ${a.name}` : "-"; }
  // Full-detail panel for a Needs Review row - every field on the transaction
  // plus the exact reason it hasn't resolved, so the whole record is inspectable
  // in place even when its one-line summary is truncated or blank.
  function renderTxDetail(t) {
    const value = coinValue(t.quantity, t.perCoinPrice);
    const feeValue = t.feeQuantity ? coinValue(t.feeQuantity, t.feePerCoinPrice) : 0;
    const cp = !t.counterparty ? "-"
      : t.counterparty.startsWith("self:") ? `Own wallet: ${t.counterparty.slice(5)}`
      : t.counterparty.startsWith("external:") ? t.counterparty.slice(9)
      : t.counterparty;
    const reason = attempt.errors.get(t.id);
    const cn = coinName(t.coinId);
    const Field = ({ label, mono, children }) => (
      <div>
        <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
        <div className={`text-slate-700 ${mono ? "font-mono break-all" : ""}`}>{children ?? "-"}</div>
      </div>
    );
    return (
      <div className="bg-stone-50/70 rounded-md px-3 py-2.5 mb-1 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
        <Field label="Date">{t.date || "-"}</Field>
        <Field label="Type">{t.type}</Field>
        <Field label="Coin">{coinSymbol(t.coinId)}{cn ? ` - ${cn}` : ""}</Field>
        <Field label="Quantity" mono>{t.quantity}</Field>
        <Field label="Price / coin" mono>{money(t.perCoinPrice)}</Field>
        <Field label="Value" mono>{money(value)}</Field>
        {t.feeQuantity ? <Field label="Fee" mono>{t.feeQuantity} {coinSymbol(t.coinId)} ({money(feeValue)})</Field> : null}
        <Field label={t.type === "Transfer" ? "From wallet" : "Wallet"}>{walletName(t.walletId)}</Field>
        {t.type === "Transfer" ? <Field label="To wallet">{t.toWalletId ? walletName(t.toWalletId) : "— not set —"}</Field> : null}
        <Field label="Counterparty">{cp}</Field>
        {t.reference ? <Field label="Reference">{t.reference}</Field> : null}
        {t.txHash ? <Field label="Tx hash" mono>{t.txHash}</Field> : null}
        {t.notes ? <Field label="Notes">{t.notes}</Field> : null}
        {reason ? (
          <div className="col-span-full">
            <div className="text-[10px] uppercase tracking-wide text-[#B45309]">Why it needs review</div>
            <div className="text-[#B45309]">{reason}</div>
          </div>
        ) : null}
      </div>
    );
  }
  // The posted journal entry - every Dr/Cr line the FIFO engine generated for
  // this transaction, with a balancing total, so you can see exactly how it hit
  // the ledger (wallet at cost, contra, realized gain/loss, fee...).
  function renderJournalEntry(t, legs) {
    const fmt = (a) => (Math.abs(a) < 0.005 && a !== 0 ? `$${a.toFixed(8)}` : money(a));
    const ordered = [...legs.filter((l) => l.side === "debit"), ...legs.filter((l) => l.side === "credit")];
    const totalDr = legs.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
    const totalCr = legs.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
    return (
      <div className="bg-stone-50/70 rounded-md px-3 py-2 mb-1 text-xs">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400 pb-1 border-b border-stone-200">
          <span className="w-7 shrink-0">Dr/Cr</span><span className="flex-1 min-w-0">Account</span>
          <span className="w-24 text-right shrink-0">Debit</span><span className="w-24 text-right shrink-0">Credit</span>
        </div>
        {ordered.length === 0 && <div className="py-1 text-slate-400">No journal lines.</div>}
        {ordered.map((l, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <span className="w-7 shrink-0 text-slate-400">{l.side === "debit" ? "Dr" : "Cr"}</span>
            <span className="flex-1 min-w-0 truncate" title={`${accountLabel(l.accountId)}${l.label ? " — " + l.label : ""}`}>
              {accountLabel(l.accountId)}{l.label ? <span className="text-slate-400"> · {l.label}</span> : null}
            </span>
            <span className="w-24 text-right shrink-0 font-mono">{l.side === "debit" ? fmt(l.amount) : ""}</span>
            <span className="w-24 text-right shrink-0 font-mono">{l.side === "credit" ? fmt(l.amount) : ""}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1 border-t border-stone-200 font-medium text-slate-600">
          <span className="w-7 shrink-0" /><span className="flex-1 min-w-0">Total</span>
          <span className="w-24 text-right shrink-0 font-mono">{fmt(totalDr)}</span>
          <span className="w-24 text-right shrink-0 font-mono">{fmt(totalCr)}</span>
        </div>
      </div>
    );
  }
  // Edit which wallets/accounts a still-unposted transaction will post to, so a
  // mis-routed row (e.g. a company trade that landed on a client wallet) can be
  // corrected before posting. Changing a field re-points the draft immediately.
  function renderPostingEdit(t) {
    const walletSel = (label, value, patchKey) => (
      <label className="flex items-center gap-2">
        <span className="text-slate-500 w-28 shrink-0">{label}</span>
        <select value={value || ""} onChange={(e) => onUpdate(t.id, { [patchKey]: e.target.value })}
          className="border border-stone-300 rounded px-2 py-1 flex-1 min-w-0">
          <option value="">- choose wallet -</option>
          {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
    );
    const tradeLabels = activeCryptoLabels.filter(labelIsTrade);
    return (
      <div className="mt-1.5 space-y-1.5 text-xs">
        <div className="text-[10px] uppercase tracking-wide text-slate-400">Edit posting</div>
        {t.type === "Trade" ? (<>
          {tradeLabels.length > 0 && (
            <label className="flex items-center gap-2">
              <span className="text-slate-500 w-28 shrink-0">Label mapping</span>
              <select value={t.matchedLabelId || ""}
                onChange={(e) => { const l = cryptoLabels.find((x) => x.id === e.target.value); const patch = l && labelTradeApply(l, wallets); if (patch) onUpdate(t.id, { ...patch, matchedLabelId: l.id }); }}
                className="border border-stone-300 rounded px-2 py-1 flex-1 min-w-0">
                <option value="">- choose trade label -</option>
                {tradeLabels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
          )}
          {walletSel("Acquired wallet", t.walletId, "walletId")}
          {walletSel("Disposed wallet", t.disposedWalletId, "disposedWalletId")}
        </>) : t.type === "Transfer" ? (<>
          {walletSel("From wallet", t.walletId, "walletId")}
          {walletSel("To wallet", t.toWalletId, "toWalletId")}
        </>) : (<>
          {walletSel("Wallet", t.walletId, "walletId")}
          {t.type !== "Fee" && (
            <label className="flex items-center gap-2">
              <span className="text-slate-500 w-28 shrink-0">Ledger account</span>
              <div className="flex-1 min-w-0">
                <AccountSelect accounts={accounts} value={t.ledgerAccountId || ""}
                  onChange={(v) => onUpdate(t.id, { ledgerAccountId: v, ledgerLegs: null, ledgerSplits: null })}
                  allowClear clearLabel="- choose account -" placeholder="- choose account -"
                  className="w-full border border-stone-300 rounded px-2 py-1 text-xs" />
              </div>
            </label>
          )}
        </>)}
      </div>
    );
  }

  function toggleBulkSelected(id) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllOfType(type) {
    setBulkSelected(new Set(bulkEligible.filter((t) => t.type === type).map((t) => t.id)));
  }
  // Selects every eligible row in the current (filtered) Needs Review set -
  // the bridge from the transaction filter to a one-click bulk label & post.
  function selectAllFiltered() {
    setBulkSelected(new Set(bulkEligibleIds));
  }
  function clearBulkSelection() {
    setBulkSelected(new Set());
    setBulkAccountId("");
    setBulkLabelId("");
    setBulkRemember(false);
  }
  function runBulkPost() {
    if (!bulkAccountId || bulkSelected.size === 0) return;
    const result = onBulkPost([...bulkSelected], bulkAccountId, bulkRemember);
    setBulkResult({ posted: result.posted.length, failed: result.failed.length });
    // Leave anything that didn't resolve still selected, so a shortfall (e.g.
    // not enough recorded cost basis yet) is easy to spot and retry rather
    // than silently vanishing back into the full list.
    setBulkSelected(new Set(result.failed.map((f) => f.id)));
    setBulkAccountId("");
    setBulkRemember(false);
  }
  function runBulkLabelPost() {
    if (!bulkLabelId || bulkSelected.size === 0 || !onBulkLabelPost) return;
    const result = onBulkLabelPost([...bulkSelected], bulkLabelId, bulkRemember);
    setBulkResult({ posted: result.posted.length, failed: result.failed.length });
    setBulkSelected(new Set(result.failed.map((f) => f.id)));
    setBulkLabelId("");
    setBulkRemember(false);
  }

  function startSplit(t, currentAccountId, value) {
    setSplitMode((prev) => ({ ...prev, [t.id]: true }));
    setSplitRows((prev) => ({
      ...prev,
      [t.id]: [
        { accountId: currentAccountId || "", amount: value },
        { accountId: "", amount: 0 },
      ],
    }));
  }
  function cancelSplit(t) { setSplitMode((prev) => ({ ...prev, [t.id]: false })); }
  function updateSplitRow(txId, i, patch) {
    setSplitRows((prev) => ({ ...prev, [txId]: prev[txId].map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));
  }
  function addSplitRow(txId) {
    setSplitRows((prev) => ({ ...prev, [txId]: [...prev[txId], { accountId: "", amount: 0 }] }));
  }
  function removeSplitRow(txId, i) {
    setSplitRows((prev) => ({ ...prev, [txId]: prev[txId].length > 2 ? prev[txId].filter((_, idx) => idx !== i) : prev[txId] }));
  }

  function post(t) {
    const accountId = choice[t.id] || t.ledgerAccountId;
    if (!accountId) return;
    // Clear any label legs so a single-account pick fully overrides an earlier
    // label mapping (the contra resolver prefers ledgerLegs when present).
    const result = onPostOne(t.id, { ledgerAccountId: accountId, ledgerSplits: null, ledgerLegs: null, matchedLabelId: undefined });
    if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
    setPostError((prev) => ({ ...prev, [t.id]: undefined }));
    // A row that carried counterparty info remembers a rule scoped to that
    // exact counterparty (more precise); a row with none remembers the
    // old-style wildcard rule for the type+coin.
    if (remember[t.id]) onRemember(t.type, t.coinId, accountId, t.counterparty);
  }
  function postSplit(t, value) {
    const rows = (splitRows[t.id] || []).map((r) => ({ accountId: r.accountId, amount: Number(r.amount) || 0 }));
    if (rows.some((r) => !r.accountId || !(r.amount > 0))) return;
    if (Math.abs(rows.reduce((s, r) => s + r.amount, 0) - value) > 0.005) return;
    const result = onPostOne(t.id, { ledgerAccountId: null, ledgerSplits: rows, ledgerLegs: null, matchedLabelId: undefined });
    if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
    setPostError((prev) => ({ ...prev, [t.id]: undefined }));
    setSplitMode((prev) => ({ ...prev, [t.id]: false }));
  }
  function postToWallet(t) {
    const toWalletId = choice[t.id];
    if (!toWalletId) return;
    const result = onPostOne(t.id, { toWalletId });
    setPostError((prev) => ({ ...prev, [t.id]: result.ok ? undefined : result.reason }));
  }
  // Post a Needs Review row by applying a label mapping - the label's legs
  // (its contra, one or more accounts on either side) become this entry's
  // ledger legs. The FIFO engine still supplies the wallet/cost-basis/gain-loss
  // side. A label only applies to the direction its legs net to.
  function postWithLabel(t, labelId) {
    const label = cryptoLabels.find((l) => l.id === labelId);
    const coin = coins.find((c) => c.id === t.coinId);
    // Full-entry label (e.g. gas fee + company top-up): post its complete
    // self-balancing journal scaled to this transaction's value, verbatim.
    if (labelIsFullEntry(label)) {
      const legs = resolveFullEntryLegs(label, coinValue(t.quantity, t.perCoinPrice));
      if (!legs) { setPostError((prev) => ({ ...prev, [t.id]: "This gas-fee label needs a value and self-balancing legs." })); return; }
      const result = onPostOne(t.id, { fullEntryLegs: legs, ledgerLegs: null, ledgerAccountId: null, ledgerSplits: null, matchedLabelId: labelId });
      if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
      setPostError((prev) => ({ ...prev, [t.id]: undefined }));
      if (remember[t.id] && onRememberLabel) onRememberLabel(t.type, t.coinId, labelId, t.counterparty);
      return;
    }
    // Trade label: the label's two wallet legs determine the acquired/disposed
    // venue wallets (and any fee account); the engine posts the swap + gain/loss.
    if (labelIsTrade(label)) {
      const patch = labelTradeApply(label, wallets);
      if (!patch) { setPostError((prev) => ({ ...prev, [t.id]: "This trade label's wallets couldn't be resolved." })); return; }
      const result = onPostOne(t.id, { ...patch, type: "Trade", matchedLabelId: labelId });
      if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
      setPostError((prev) => ({ ...prev, [t.id]: undefined }));
      if (remember[t.id] && onRememberLabel) onRememberLabel(t.type, t.coinId, labelId, t.counterparty);
      return;
    }
    // Internal-transfer label: re-type the row to a Transfer between the two
    // company wallets and let the FIFO engine carry the cost basis over.
    const destWallet = labelTransferDestWallet(label, wallets, t.walletId, coin);
    if (destWallet) {
      if (destWallet.id === t.walletId) { setPostError((prev) => ({ ...prev, [t.id]: "This transfer label's other wallet is the same as this transaction's wallet." })); return; }
      const result = onPostOne(t.id, { type: "Transfer", toWalletId: destWallet.id, ledgerAccountId: null, ledgerSplits: null, ledgerLegs: null });
      if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
      setPostError((prev) => ({ ...prev, [t.id]: undefined }));
      if (remember[t.id] && onRememberLabel) onRememberLabel(t.type, t.coinId, labelId, t.counterparty);
      return;
    }
    const value = coinValue(t.quantity, t.perCoinPrice);
    // A zero/again-missing value (the coin's price/market rate isn't set) can't
    // be posted - call that out specifically rather than blaming the label's
    // direction, which is the other reason resolveLabelLegs returns null.
    if (!(value > 0)) { setPostError((prev) => ({ ...prev, [t.id]: `This ${t.type.toLowerCase()} has no value yet - set ${coinSymbol(t.coinId)}'s market rate on the Coins tab (or fix this row's price), then apply the label.` })); return; }
    const legs = resolveLabelLegs(label, t.type, value);
    if (!legs) { setPostError((prev) => ({ ...prev, [t.id]: `This label doesn't apply to a ${t.type.toLowerCase()} (its legs net the wrong way).` })); return; }
    // For a single-account label, reflect it in the account field so the two
    // stay visibly linked; a multi-account label can't be shown there.
    if (legs.length === 1) setChoice((prev) => ({ ...prev, [t.id]: legs[0].accountId }));
    // The label's wallet leg is the accounting wallet (auto-routed to the coin's
    // stablecoin/crypto sibling) - re-point the row onto it.
    const labelWallet = labelPostWallet(label, wallets, coin);
    const result = onPostOne(t.id, { ledgerLegs: legs, ledgerAccountId: null, ledgerSplits: null, ...(labelWallet ? { walletId: labelWallet.id } : {}) });
    if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
    setPostError((prev) => ({ ...prev, [t.id]: undefined }));
    if (remember[t.id] && onRememberLabel) onRememberLabel(t.type, t.coinId, labelId, t.counterparty);
  }
  const activeCryptoLabels = cryptoLabels.filter((l) => l.status !== "inactive");

  // ---- transaction filter helpers ----
  const FILTER_FIELDS = [
    { field: "type", label: "Type" },
    { field: "source", label: "Source" },
    { field: "coin", label: "Coin" },
    { field: "wallet", label: "Wallet" },
    { field: "label", label: "Label" },
    { field: "dateFrom", label: "Date from" },
    { field: "dateTo", label: "Date to" },
    { field: "search", label: "Search text" },
  ];
  function addCondition() { setConditions((prev) => [...prev, { field: "type", value: "" }]); }
  function updateCondition(i, patch) { setConditions((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c))); }
  function removeCondition(i) { setConditions((prev) => prev.filter((_, idx) => idx !== i)); }
  function clearFilter() { setConditions([]); }
  // Quick source filter (chips): keep at most one source condition.
  const currentSourceFilter = conditions.find((c) => c.field === "source" && c.value)?.value || "";
  function setSourceFilter(src) {
    setConditions((prev) => { const others = prev.filter((c) => c.field !== "source"); return src ? [...others, { field: "source", value: src }] : others; });
  }
  function applyFavorite(f) { setConditions(f.conditions.map((c) => ({ ...c }))); setFilterOpen(true); }
  function saveFavorite() {
    const name = favName.trim();
    if (!name || activeConditions.length === 0 || !onAddFilter) return;
    onAddFilter(name, activeConditions.map((c) => ({ field: c.field, value: c.value })));
    setFavName("");
  }
  // Filter -> label rule: turn the current Type(+Coin/counterparty) filter into
  // a crypto label rule, so every future matching import auto-applies the label.
  const ruleTypeCond = activeConditions.find((c) => c.field === "type");
  const ruleCoinCond = activeConditions.find((c) => c.field === "coin");
  // A crypto label rule is keyed on (type, coin), so both must be pinned by the
  // filter. Transfers post via wallet, not a label, so they're excluded.
  const canCreateRule = !!ruleTypeCond && ruleTypeCond.value && ruleTypeCond.value !== "Transfer" && !!ruleCoinCond && !!ruleCoinCond.value;
  function createLabelRule(labelId) {
    if (!canCreateRule || !onRememberLabel || !labelId) return;
    onRememberLabel(ruleTypeCond.value, ruleCoinCond.value, labelId, undefined);
  }
  function valueEditor(c, i) {
    const cls = "border border-stone-300 rounded px-2 py-1 text-xs";
    if (c.field === "type") return (
      <select value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} className={cls}>
        <option value="">any</option>
        {CRYPTO_TX_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
      </select>
    );
    if (c.field === "source") return (
      <select value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} className={cls}>
        <option value="">any</option>
        {CRYPTO_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    );
    if (c.field === "coin") return (
      <select value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} className={cls}>
        <option value="">any</option>
        {coins.map((co) => <option key={co.id} value={co.id}>{co.symbol}</option>)}
      </select>
    );
    if (c.field === "wallet") return (
      <select value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} className={cls}>
        <option value="">any</option>
        {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
    );
    if (c.field === "label") return (
      <select value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} className={cls}>
        <option value="">any</option>
        {activeCryptoLabels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    );
    if (c.field === "dateFrom" || c.field === "dateTo") return (
      <DateField value={c.value} onChange={(v) => updateCondition(i, { value: v })} className={cls} />
    );
    return <input value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} placeholder="text…" className={cls} />;
  }

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_cryptoTx")}</h1>
      <p className="text-sm text-slate-500 mb-5">
        Deposits, withdrawals, and transfers between wallets. Every transaction is saved as a draft first - resolve each row's account or destination wallet (or apply a label), then <b>Post</b> it into the real ledger via FIFO cost-basis matching. Trade isn't available yet: matching one coin sold to another bought, both drawing on cost-basis lots, is riskier to guess at than it's worth right now.
      </p>

      <div className="flex gap-1 mb-4 border-b border-stone-200">
        {[["transactions", "Transactions"], ["rollforward", "Asset Roll Forward"], ["layers", "Unused Cost Layers"]].map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${subTab === k ? "border-[#03D47C] text-[#02B169] font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {subTab === "transactions" && (
        <>
          <div className="mb-4">
            <button onClick={() => setShowForm((s) => !s)}
              className="flex items-center gap-1.5 bg-black hover:bg-[#4D4D4D] text-white text-sm px-3 py-1.5 rounded-full">
              <Plus size={14} /> {showForm ? "Close" : "Add transaction"}
            </button>
            {showForm && (
              <div className="mt-4">
                <AddCryptoTxForm
                  coins={coins} wallets={wallets} accounts={accounts} cryptoTxs={cryptoTxs}
                  onCancel={() => setShowForm(false)}
                  onSave={(tx) => { onAdd(tx); setShowForm(false); }}
                />
              </div>
            )}
          </div>
          {/* Transaction filter (Cryptio-style) */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <button onClick={() => setFilterOpen((o) => !o)}
              className={`flex items-center gap-1.5 text-sm border rounded-full px-3 py-1.5 ${activeConditions.length ? "border-[#03D47C] text-[#02B169] bg-[#E6FBF1]" : "border-stone-300 text-slate-600 hover:bg-stone-50"}`}>
              <ListChecks size={14} /> Filter{activeConditions.length ? ` (${activeConditions.length})` : ""}
            </button>
            {activeConditions.length > 0 && (
              <>
                <span className="text-xs text-slate-500">
                  showing {needsReview.length + readyDrafts.length + posted.length} of {totalTx}
                </span>
                <button onClick={clearFilter} className="text-xs text-slate-400 hover:text-[#B91C1C]">clear</button>
              </>
            )}
            {cryptoFilters.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs text-slate-400 ml-1">Saved:</span>
                {cryptoFilters.map((f) => (
                  <span key={f.id} className="flex items-center gap-1 text-xs bg-stone-100 rounded-full pl-2 pr-1 py-0.5">
                    <button onClick={() => applyFavorite(f)} className="text-slate-600 hover:text-black">{f.name}</button>
                    <button onClick={() => onDeleteFilter(f.id)} className="text-slate-300 hover:text-[#B91C1C]"><XCircle size={12} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {filterOpen && (
            <div className="bg-white border border-stone-200 rounded-lg p-3 shadow-sm mb-3">
              <div className="space-y-1.5">
                {conditions.length === 0 && <div className="text-xs text-slate-400">No conditions - add one to narrow the list. Conditions combine with AND.</div>}
                {conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 flex-wrap">
                    <select value={c.field} onChange={(e) => updateCondition(i, { field: e.target.value, value: "" })}
                      className="border border-stone-300 rounded px-2 py-1 text-xs w-28">
                      {FILTER_FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                    </select>
                    <span className="text-xs text-slate-400">is</span>
                    {valueEditor(c, i)}
                    <button onClick={() => removeCondition(i)} className="text-slate-300 hover:text-[#B91C1C]"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 flex-wrap mt-2.5 pt-2.5 border-t border-stone-100">
                <button onClick={addCondition} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"><Plus size={12} /> Add condition</button>
                <button onClick={clearFilter} className="text-xs text-slate-400 hover:text-slate-600">Clear</button>
                <div className="flex-1" />
                {onAddFilter && (
                  <>
                    <input value={favName} onChange={(e) => setFavName(e.target.value)} placeholder="favorite name"
                      className="border border-stone-300 rounded px-2 py-1 text-xs w-32" />
                    <button onClick={saveFavorite} disabled={!favName.trim() || activeConditions.length === 0}
                      className="text-xs bg-[#F3F4F6] enabled:hover:bg-[#E5E7EB] disabled:opacity-40 text-black px-2.5 py-1 rounded-full">Save favorite</button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Data-quality health + Complete/Incomplete COA filter (Phase 1) */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2 text-xs">
              <span className={`font-semibold px-2 py-1 rounded-full ${needsReviewPct === 0 ? "bg-[#E6FBF1] text-[#02B169]" : "bg-[#FFFBEB] text-[#B45309]"}`}>
                Needs review {needsReviewPct}%
              </span>
              <span className="text-slate-400">{unfilteredNeedsReview} of {totalTx} transaction{totalTx === 1 ? "" : "s"} incomplete</span>
            </div>
            <div className="flex border border-stone-300 rounded-full overflow-hidden text-xs shrink-0">
              {[["all", "All"], ["incomplete", "Incomplete COA"], ["complete", "Complete COA"]].map(([k, l]) => (
                <button key={k} onClick={() => setCoaFilter(k)}
                  className={`px-3 py-1 ${coaFilter === k ? "bg-black text-white" : "bg-white text-slate-500 hover:bg-stone-50"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          {coaFilter !== "complete" && (
          <>
          <div className="flex items-center gap-3 mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Needs review ({needsReview.length})</div>
            {bulkEligible.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {activeConditions.length > 0 && (
                  <button onClick={selectAllFiltered}
                    className="text-xs text-[#02B169] hover:text-[#02B169] underline decoration-dotted font-medium">
                    Select all filtered ({bulkEligible.length})
                  </button>
                )}
                {[...new Set(bulkEligible.map((t) => t.type))].map((type) => (
                  <button key={type} onClick={() => selectAllOfType(type)}
                    className="text-xs text-slate-400 hover:text-slate-600 underline decoration-dotted">
                    Select all {type}{bulkEligible.filter((t) => t.type === type).length > 1 ? "s" : ""} ({bulkEligible.filter((t) => t.type === type).length})
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Source filter chips - only shown when Needs Review mixes origins
              (e.g. a Bitgo client CSV alongside gas-tank syncs), so each set can
              be filtered out and labeled correctly. */}
          {(() => {
            const draftSources = new Set(cryptoTxs.filter((t) => !t.posted).map((t) => t.source || "manual"));
            if (draftSources.size < 2) return null;
            const countOf = (v) => cryptoTxs.filter((t) => !t.posted && (t.source || "manual") === v).length;
            const chips = [["", "All"], ...CRYPTO_SOURCES.filter((s) => draftSources.has(s.value)).map((s) => [s.value, s.label])];
            return (
              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                <span className="text-[11px] text-slate-400">Source:</span>
                {chips.map(([v, l]) => (
                  <button key={v || "all"} onClick={() => setSourceFilter(v)}
                    className={`text-xs px-2 py-0.5 rounded-full border ${currentSourceFilter === v ? "border-[#03D47C] text-[#02B169] bg-[#E6FBF1]" : "border-stone-300 text-slate-500 hover:bg-stone-50"}`}>
                    {l}{v ? ` (${countOf(v)})` : ""}
                  </button>
                ))}
              </div>
            );
          })()}

          {bulkSelected.size > 0 && (
            <div className="bg-[#E6FBF1] border border-[#03D47C]/30 rounded-lg px-3 py-2.5 mb-3">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <span className="text-sm font-medium text-[#02B169]">{bulkSelected.size} selected</span>
                <label className="flex items-center gap-1 text-xs text-slate-600">
                  <input type="checkbox" checked={bulkRemember} onChange={(e) => setBulkRemember(e.target.checked)} />
                  remember for future imports
                </label>
                <div className="flex-1" />
                <button onClick={clearBulkSelection} className="text-xs text-slate-400 hover:text-slate-600">Clear</button>
              </div>
              {/* Option A: apply one label (contra by direction) - the filter -> label -> post bridge */}
              {activeCryptoLabels.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-xs text-slate-500 w-16 shrink-0">Label:</span>
                  <select value={bulkLabelId} onChange={(e) => setBulkLabelId(e.target.value)}
                    className="border border-stone-300 rounded px-2 py-1.5 text-sm bg-white max-w-xs flex-1">
                    <option value="">- choose label for all selected -</option>
                    {activeCryptoLabels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                  <button onClick={runBulkLabelPost} disabled={!bulkLabelId}
                    className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-full shrink-0">
                    Label &amp; post {bulkSelected.size}
                  </button>
                </div>
              )}
              {/* Option B: apply one account to all */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500 w-16 shrink-0">Account:</span>
                <div className="max-w-xs flex-1">
                  <AccountSelect
                    accounts={accounts}
                    value={bulkAccountId}
                    onChange={setBulkAccountId}
                    allowClear
                    clearLabel="- choose account -"
                    placeholder="- one account for all selected -"
                    className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm bg-white"
                  />
                </div>
                {bulkSelectedTypes.size > 1 && (
                  <span className="text-[11px] text-[#B45309] shrink-0">spans {bulkSelectedTypes.size} types - same account for all</span>
                )}
                <button onClick={runBulkPost} disabled={!bulkAccountId}
                  className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-full shrink-0">
                  Post {bulkSelected.size}
                </button>
              </div>
            </div>
          )}

          {bulkResult && (
            <div className="text-sm bg-stone-50 border border-stone-200 rounded px-3 py-2 mb-3">
              Posted <b>{bulkResult.posted}</b> transaction{bulkResult.posted === 1 ? "" : "s"}.
              {bulkResult.failed > 0 && <> <b>{bulkResult.failed}</b> still {bulkResult.failed === 1 ? "needs" : "need"} review (didn't resolve - still selected above, check the reason on each row) and stayed as drafts.</>}
            </div>
          )}

          {bulkSelected.size > 0 && (
            <div className="flex items-center gap-2 mb-2 text-xs">
              <span className="text-[#02B169] font-medium">Showing {bulkSelected.size} selected</span>
              <button onClick={() => setShowAllReview((v) => !v)} className="text-slate-500 hover:text-slate-700 underline decoration-dotted">
                {showAllReview ? "Show only selected" : `Show all ${needsReview.length}`}
              </button>
            </div>
          )}
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-visible">
            {needsReview.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing to review - transactions with a remembered rule resolve automatically.</div>}
            {(bulkSelected.size > 0 && !showAllReview ? needsReview.filter((t) => bulkSelected.has(t.id)) : needsReview).map((t) => {
              const reason = attempt.errors.get(t.id);
              const needsToWallet = t.type === "Transfer" && !t.toWalletId;
              // A Deposit/Withdrawal needs review either because it has no
              // ledger account/split picked yet, or because a pick it already
              // has doesn't resolve (e.g. an unbalanced split) - either way,
              // the account picker + split editor is the way to fix it.
              const needsLedgerSide = t.type !== "Transfer";
              const value = coinValue(t.quantity, t.perCoinPrice);
              const selected = choice[t.id] ?? t.ledgerAccountId ?? "";
              const isSplit = !!splitMode[t.id];
              const rows = splitRows[t.id] || [];
              const splitTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
              const remaining = value - splitTotal;
              const splitBalanced = Math.abs(remaining) < 0.005;
              const splitReady = splitBalanced && rows.every((r) => r.accountId && Number(r.amount) > 0);
              const rowError = postError[t.id];

              const summary = (
                <span className="flex-1 min-w-0 flex items-center gap-2">
                  {t.source && t.source !== "manual" && (
                    <span className={`shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${t.source === "gastank" ? "bg-[#EEF2FF] text-[#4338CA]" : "bg-[#ECFDF5] text-[#047857]"}`}
                      title={cryptoSourceLabel(t.source)}>
                      {t.source === "gastank" ? "Gas tank" : "Client"}
                    </span>
                  )}
                  <span className="truncate">
                    {t.quantity} {coinSymbol(t.coinId)} - {t.type === "Transfer" && !needsToWallet ? `${walletName(t.walletId)} -> ${walletName(t.toWalletId)}` : walletName(t.walletId)}
                    {needsLedgerSide && t.ledgerAccountId && !isSplit && <span className="text-slate-400"> - {accountLabel(t.ledgerAccountId)}</span>}
                  </span>
                </span>
              );

              if (needsToWallet) {
                const isOpen = expanded.has(t.id);
                return (
                  <div key={t.id} className="border-b border-stone-100 last:border-0">
                  <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <button onClick={() => toggleExpanded(t.id)} title="Show full transaction details"
                      className="text-slate-300 hover:text-slate-600 shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                    <span className="text-xs uppercase tracking-wide bg-[#FFFBEB] text-[#B45309] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                    <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                    {summary}
                    <select
                      value={selected}
                      onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}
                      className={`border rounded px-2 py-1 text-xs w-48 shrink-0 ${selected ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                    >
                      <option value="">- choose wallet -</option>
                      {wallets.filter((w) => w.id !== t.walletId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                    <button onClick={() => postToWallet(t)} disabled={!selected}
                      className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
                    <button onClick={() => onDelete(t.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0"><Trash2 size={13} /></button>
                  </div>
                  {isOpen && <div className="px-3 pb-2.5 pl-11">{renderTxDetail(t)}{renderPostingEdit(t)}</div>}
                  </div>
                );
              }

              if (needsLedgerSide && !isSplit) {
                const isOpen = expanded.has(t.id);
                return (
                  <div key={t.id} className={`border-b border-stone-100 last:border-0 ${bulkSelected.has(t.id) ? "bg-[#E6FBF1]/40" : ""}`}>
                  <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <input type="checkbox" checked={bulkSelected.has(t.id)} onChange={() => toggleBulkSelected(t.id)} className="shrink-0" />
                    <button onClick={() => toggleExpanded(t.id)} title="Show full transaction details"
                      className="text-slate-300 hover:text-slate-600 shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                    <span className="text-xs uppercase tracking-wide bg-[#FFFBEB] text-[#B45309] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                    <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                    {summary}
                    <AccountSelect
                      accounts={accounts}
                      value={selected}
                      onChange={(val) => { setChoice({ ...choice, [t.id]: val }); setPostError((prev) => ({ ...prev, [t.id]: undefined })); if (val) setLabelChoice((prev) => ({ ...prev, [t.id]: "" })); }}
                      allowClear
                      clearLabel="- choose account -"
                      placeholder="- choose account -"
                      className={`border rounded px-2 py-1 text-xs w-40 shrink-0 ${selected ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                    />
                    {(() => {
                      // Only offer labels that actually apply to this row's
                      // direction - a deposit label credits a contra (+100%),
                      // a withdrawal label debits it (-100%), and a transfer
                      // label (wallet-to-wallet) applies to either. Showing the
                      // rest just invites the "doesn't apply" error.
                      const effType = t.type === "Fee" ? "Withdrawal" : t.type; // a fee takes withdrawal-direction labels (Dr expense / Cr wallet)
                      const applicable = t.type === "Trade"
                        ? activeCryptoLabels.filter(labelIsTrade)
                        : activeCryptoLabels.filter((l) => labelIsFullEntry(l) ? l.appliesTo === t.type : (labelDirection(l) === effType || labelTransferDestWallet(l, wallets, t.walletId)));
                      return applicable.length > 0 && (
                        <select
                          value={labelChoice[t.id] || ""}
                          onChange={(e) => { const v = e.target.value; setLabelChoice((prev) => ({ ...prev, [t.id]: v })); setPostError((prev) => ({ ...prev, [t.id]: undefined })); if (v) setChoice((prev) => ({ ...prev, [t.id]: "" })); }}
                          title={`Stage a label mapping, then click Post (only labels valid for a ${t.type.toLowerCase()} are listed)`}
                          className={`border rounded px-2 py-1 text-xs w-32 shrink-0 ${labelChoice[t.id] ? "border-stone-300 text-slate-700" : "border-stone-300 text-slate-500"}`}
                        >
                          <option value="">or label…</option>
                          {applicable.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                        </select>
                      );
                    })()}
                    <label className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
                      <input type="checkbox" checked={!!remember[t.id]} onChange={(e) => setRemember({ ...remember, [t.id]: e.target.checked })} />
                      remember
                    </label>
                    <button onClick={() => startSplit(t, selected, value)} title="Split across multiple accounts"
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 shrink-0">
                      <Layers size={13} />
                    </button>
                    <button onClick={() => { if (labelChoice[t.id]) postWithLabel(t, labelChoice[t.id]); else post(t); }} disabled={!selected && !labelChoice[t.id]}
                      className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
                    <button onClick={() => onDelete(t.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0"><Trash2 size={13} /></button>
                    {rowError && <span className="w-full text-xs text-[#EF4444] pl-[7.5rem]">{rowError}</span>}
                  </div>
                  {isOpen && <div className="px-3 pb-2.5 pl-11">{renderTxDetail(t)}{renderPostingEdit(t)}</div>}
                  </div>
                );
              }

              if (needsLedgerSide && isSplit) {
                return (
                  <div key={t.id} className="px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm bg-stone-50/50">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xs uppercase tracking-wide bg-[#FFFBEB] text-[#B45309] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                      <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                      {summary}
                      <span className="text-[10px] uppercase tracking-wide text-[#02B169] bg-[#E6FBF1] px-1.5 py-0.5 rounded shrink-0">split</span>
                    </div>
                    {rows.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 mb-1.5 pl-3">
                        <AccountSelect
                          accounts={accounts}
                          value={r.accountId}
                          onChange={(val) => updateSplitRow(t.id, i, { accountId: val })}
                          allowClear
                          clearLabel="- choose account -"
                          placeholder="- choose account -"
                          className={`flex-1 border rounded px-2 py-1 text-xs ${r.accountId ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                        />
                        <input
                          type="number" step="0.01" value={r.amount}
                          onChange={(e) => updateSplitRow(t.id, i, { amount: e.target.value })}
                          className="w-28 border border-stone-300 rounded px-2 py-1 text-xs font-mono text-right"
                        />
                        <button onClick={() => removeSplitRow(t.id, i)} disabled={rows.length <= 2}
                          className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30 shrink-0">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center gap-3 pl-3 mt-1.5">
                      <button onClick={() => addSplitRow(t.id)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
                        <Plus size={12} /> Add split
                      </button>
                      <span className={`text-xs ${splitBalanced ? "text-[#02B169]" : "text-[#B45309]"}`}>
                        {splitBalanced ? "Splits balance." : `Remaining: ${money(remaining)}`}
                      </span>
                      <div className="flex-1" />
                      <button onClick={() => cancelSplit(t)} className="text-xs text-slate-400 hover:text-slate-600">Cancel split</button>
                      <button onClick={() => postSplit(t, value)} disabled={!splitReady}
                        className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
                    </div>
                    {rowError && <div className="text-xs text-[#EF4444] pl-3 mt-1">{rowError}</div>}
                  </div>
                );
              }

              // Fully specified but still doesn't resolve (e.g. not enough
              // recorded cost basis yet) - nothing to pick, just the reason
              // and the option to delete and re-time it.
              return (
                <div key={t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
                  <span className="text-xs uppercase tracking-wide bg-[#FFFBEB] text-[#B45309] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                  <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                  {summary}
                  <span className="flex items-center gap-1 text-xs text-[#EF4444] shrink-0" title={reason}><AlertTriangle size={12} /> {reason || "incomplete"}</span>
                  <button onClick={() => onDelete(t.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0"><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
          </>
          )}

          {coaFilter !== "incomplete" && (
          <>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Ready to build ({readyDrafts.length})</div>
            {readyDrafts.length > 0 && onPostReady && (
              <button onClick={() => onPostReady(readyDrafts.map((t) => t.id))}
                className="flex items-center gap-1.5 bg-black hover:bg-[#4D4D4D] text-white text-xs px-3 py-1.5 rounded-full">
                <CheckCircle2 size={13} /> Post all ({readyDrafts.length})
              </button>
            )}
          </div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
            {readyDrafts.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing ready yet - resolve items in Needs review, or add a transaction above.</div>}
            {readyDrafts.map((t) => {
              const isOpen = expanded.has(t.id);
              const previewLegs = attempt.linesByTx.get(t.id) || [];
              return (
              <div key={t.id} className="border-b border-stone-100 last:border-0">
              <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <button onClick={() => toggleExpanded(t.id)} title="Show details, preview the journal entry, and edit the posting"
                  className="text-slate-300 hover:text-slate-600 shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                <span className="text-xs uppercase tracking-wide bg-stone-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                <span className="flex-1 truncate">
                  {t.quantity} {coinSymbol(t.coinId)} - {t.type === "Transfer" ? `${walletName(t.walletId)} -> ${walletName(t.toWalletId)}` : walletName(t.walletId)}
                  {t.type !== "Transfer" && t.type !== "Trade" && (
                    <span className="text-slate-400">
                      {" "}- {t.ledgerSplits?.length > 1 ? `${t.ledgerSplits.length} accounts (split)` : accountLabel(t.ledgerAccountId)}
                    </span>
                  )}
                </span>
                {t.matchedByRule && <span className="text-[10px] uppercase tracking-wide text-[#02B169] bg-[#E6FBF1] px-1.5 py-0.5 rounded shrink-0">rule</span>}
                <span className="flex items-center gap-1 text-xs text-[#02B169] shrink-0"><CheckCircle2 size={12} /> ready</span>
                <button onClick={() => onPostOne(t.id, {})}
                  className="bg-black hover:bg-[#4D4D4D] text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
                <button onClick={() => onDelete(t.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0"><Trash2 size={13} /></button>
              </div>
              {isOpen && (
                <div className="px-3 pb-2.5 pl-10 space-y-2">
                  {renderTxDetail(t)}
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Will post as</div>
                    {renderJournalEntry(t, previewLegs)}
                  </div>
                  {renderPostingEdit(t)}
                </div>
              )}
              </div>
              );
            })}
          </div>

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Posted ({posted.length})</div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
            {posted.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing posted yet - post a row above.</div>}
            {posted.map((t) => {
              const legs = cryptoLedger.linesByTx.get(t.id) || [];
              const gainLeg = legs.find((l) => l.label.startsWith("Realized"));
              const isSplit = t.ledgerSplits && t.ledgerSplits.length > 1;
              const isOpen = expanded.has(t.id);
              return (
                <div key={t.id} className="border-b border-stone-100 last:border-0">
                <div className="flex items-center gap-3 px-3 py-2 text-sm">
                  <button onClick={() => toggleExpanded(t.id)} title="Show the posted journal entry"
                    className="text-slate-300 hover:text-slate-600 shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                  <span className="text-xs uppercase tracking-wide bg-[#E6FBF1] text-[#02B169] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                  <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                  <span className="flex-1 truncate text-slate-600">
                    {t.quantity} {coinSymbol(t.coinId)} - {t.type === "Transfer" ? `${walletName(t.walletId)} -> ${walletName(t.toWalletId)}` : walletName(t.walletId)}
                  </span>
                  {isSplit ? (
                    <span className="text-xs text-slate-500 w-40 truncate" title={t.ledgerSplits.map((s) => accountLabel(s.accountId)).join(", ")}>
                      {t.ledgerSplits.length} accounts (split)
                    </span>
                  ) : t.type !== "Transfer" && t.type !== "Trade" ? (
                    <span className="text-xs text-slate-500 w-40 truncate">{accountLabel(t.ledgerAccountId)}</span>
                  ) : null}
                  {t.matchedByRule && <span className="text-[10px] uppercase tracking-wide text-[#02B169] bg-[#E6FBF1] px-1.5 py-0.5 rounded shrink-0">rule</span>}
                  {gainLeg && (
                    <span className={`text-xs font-mono shrink-0 ${gainLeg.label.includes("gain") ? "text-[#02B169]" : "text-[#EF4444]"}`}>
                      {gainLeg.label.includes("gain") ? "+" : "-"}{money(gainLeg.amount)}
                    </span>
                  )}
                  <span className="font-mono text-xs text-slate-500 shrink-0">{money(coinValue(t.quantity, t.perCoinPrice))}</span>
                </div>
                {isOpen && <div className="px-3 pb-2.5 pl-10">{renderJournalEntry(t, legs)}</div>}
                </div>
              );
            })}
          </div>
          </>
          )}
        </>
      )}

      {subTab === "rollforward" && (() => {
        const units = (n) => (n ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 }) : "-");
        const allTie = rollForward.every((r) => r.tie);
        return (
          <>
            <p className="text-sm text-slate-500 mb-4">
              Movement of each asset's holdings across a period, from posted transactions only - beginning balance, deposits and withdrawals in the period, fees, and ending balance. Beginning and ending USD are at FIFO cost basis (they tie to the balance sheet); deposit/withdrawal USD are at each transaction's own price. Units reconcile exactly (beginning + deposits − withdrawals − fees = ending); the USD gap between them is realized/unrealized P&L.
            </p>
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <label className="text-xs text-slate-500">From
                <span className="ml-1.5"><DateField value={rfStartEff} onChange={setRfStart}
                  className="border border-stone-300 rounded px-2 py-1 text-sm w-28" /></span>
              </label>
              <label className="text-xs text-slate-500">To
                <span className="ml-1.5"><DateField value={rfEndEff} onChange={setRfEnd}
                  className="border border-stone-300 rounded px-2 py-1 text-sm w-28" /></span>
              </label>
              <span className={`flex items-center gap-1 text-xs ${allTie ? "text-[#02B169]" : "text-[#EF4444]"}`}>
                {allTie ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                {allTie ? "Units reconcile." : "Units don't reconcile - check for edits mid-period."}
              </span>
            </div>
            <div className="-mx-6 px-6 overflow-x-auto">
              <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden min-w-[860px]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
                      <th className="text-left px-3 py-2 font-medium">Asset</th>
                      <th className="text-right px-3 py-2 font-medium">Begin (units)</th>
                      <th className="text-right px-3 py-2 font-medium">Begin (USD)</th>
                      <th className="text-right px-3 py-2 font-medium">Deposits</th>
                      <th className="text-right px-3 py-2 font-medium">Withdrawals</th>
                      <th className="text-right px-3 py-2 font-medium">Fees (units)</th>
                      <th className="text-right px-3 py-2 font-medium">End (units)</th>
                      <th className="text-right px-3 py-2 font-medium">End (USD)</th>
                      <th className="px-2 py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {rollForward.length === 0 && (
                      <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No posted crypto activity in this range yet.</td></tr>
                    )}
                    {rollForward.map((r) => (
                      <tr key={r.coinId} className="border-b border-stone-100 last:border-0">
                        <td className="px-3 py-2 font-medium">{r.symbol}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-600">{units(r.beginUnits)}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-600">{money(r.beginUsd)}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          <div className="text-[#02B169]">{units(r.depUnits)}</div>
                          <div className="text-[10px] text-slate-400">{money(r.depUsd)}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          <div className="text-[#B45309]">{units(r.wdUnits)}</div>
                          <div className="text-[10px] text-slate-400">{money(r.wdUsd)}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-500">{units(r.feeUnits)}</td>
                        <td className="px-3 py-2 text-right font-mono font-medium">{units(r.endUnits)}</td>
                        <td className="px-3 py-2 text-right font-mono font-medium">{money(r.endUsd)}</td>
                        <td className="px-2 py-2 text-center">
                          {r.tie
                            ? <CheckCircle2 size={13} className="text-[#02B169] inline" />
                            : <AlertTriangle size={13} className="text-[#EF4444] inline" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        );
      })()}

      {subTab === "layers" && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
                <th className="text-left px-3 py-2 font-medium">Acquired</th>
                <th className="text-left px-3 py-2 font-medium">Coin</th>
                <th className="text-left px-3 py-2 font-medium">Wallet</th>
                <th className="text-right px-3 py-2 font-medium">Remaining Qty</th>
                <th className="text-right px-3 py-2 font-medium">Unit Cost</th>
                <th className="text-right px-3 py-2 font-medium">Cost Basis Remaining</th>
              </tr>
            </thead>
            <tbody>
              {cryptoLedger.remainingLayers.map((l) => (
                <tr key={l.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 font-mono text-slate-500">{l.acquiredDate}</td>
                  <td className="px-3 py-2 font-mono">{coinSymbol(l.coinId)}</td>
                  <td className="px-3 py-2">{walletName(l.walletId)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{l.remaining.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(l.unitCost)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(l.remaining * l.unitCost)}</td>
                </tr>
              ))}
              {cryptoLedger.remainingLayers.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No cost-basis lots yet - post a Deposit to create one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Crypto Import (per-wallet CSV, mirrors the fiat Import screen) ----------
// One import path for wallet activity, whatever the source. parseCryptoCsvRow
// (above) already does the "figure out what this raw row means" work -
// normalizing the source's own type vocabulary and resolving a counterparty
// against this app's own Wallets - so this screen just needs to accept the
// CSV and show what happened.

function CryptoImportScreen({ wallets, walletLabelRules, onImport }) {
  const [walletId, setWalletId] = useState(wallets[0]?.id || "");
  const [csvText, setCsvText] = useState("");
  const [result, setResult] = useState(null);
  // label -> chosen walletId ("" = not mapped yet, falls back to the wallet
  // picked above). Reset whenever the pasted/uploaded CSV text changes, so a
  // fresh file always gets its own prompt rather than reusing a previous
  // file's picks.
  const [labelMap, setLabelMap] = useState({});
  const fileRef = useRef(null);

  useEffect(() => {
    if (!walletId && wallets[0]) setWalletId(wallets[0].id);
  }, [wallets, walletId]);

  useEffect(() => {
    setLabelMap({});
  }, [csvText]);

  // A source's own wallet name essentially never matches this app's Wallet
  // name exactly ("Production Bitcoin Hot Wallet" vs. "Bitgo hot wallet -
  // Company #Crypto") - real downloaded exports won't carry a name that
  // lines up on their own. This is the one-time prompt that closes that gap:
  // every label the pasted/uploaded file mentions that doesn't already
  // resolve (by exact match or a previously saved mapping) gets listed here
  // so it can be pointed at one of this app's Wallets once.
  const unresolvedLabels = useMemo(
    () => findUnresolvedWalletLabels(csvText, wallets, walletLabelRules),
    [csvText, wallets, walletLabelRules]
  );

  // The "Import into wallet" fallback only matters for rows that don't route to
  // a wallet on their own. For a multi-wallet export where every row carries a
  // wallet label that resolves (or has been mapped), it's dead weight - so it's
  // only shown when there's actually a row that will use it, or before anything
  // has been pasted.
  const needsFallback = useMemo(
    () => importNeedsFallbackWallet(csvText, wallets, walletLabelRules, labelMap),
    [csvText, wallets, walletLabelRules, labelMap]
  );
  // With wallet-label routing + stablecoin/crypto auto-routing, the manual
  // fallback picker is only relevant when a pasted file actually has a row that
  // can't route on its own. Otherwise it's hidden entirely.
  const showFallback = csvText.trim() && needsFallback;

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ""));
    reader.readAsText(file);
  }

  function runImport() {
    if (!csvText.trim() || !walletId) return;
    const extraLabelRules = unresolvedLabels
      .filter((label) => labelMap[label])
      .map((label) => ({ label, walletId: labelMap[label] }));
    setResult(onImport(csvText, walletId, extraLabelRules));
  }

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-slate-500 mb-4">
        Works with a raw exchange/wallet export as-is - its own column names don't have to match exactly (Bitgo's own "DATETIME/TX_TYPE/ASSET/AMOUNT/FEE" style is recognized alongside "Date/Type/Coin/Quantity/Price"), and its "Deposit/Withdrawal/Transfer" wording doesn't have to match exactly either (common variants like Receive/Send/Sweep are recognized). An account-level export spanning multiple wallets in one file is fine too: a wallet label/id column gets checked against your own Wallets and each row routes to the right one automatically - a source's own naming essentially never lines up with your Wallets on its own, so anything unrecognized gets a one-time "map this wallet" prompt below instead of silently falling back. An optional Counterparty/Address/To/From column also gets checked against your own Wallets - a match auto-fills a Transfer's destination wallet, no ToWallet column needed. Duplicates (same date + type + coin + quantity + price) are skipped automatically. A row still missing its Ledger Account (or a Transfer's destination wallet) still imports - it lands in Drafts needing that one field, fixable right there, and "remember this" saves a rule scoped to that counterparty so the same kind of row from the same counterparty resolves on its own next time.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm">
        {showFallback && (
          <div className="bg-[#FFFBEB] border border-[#F59E0B]/40 rounded px-3 py-2.5 mb-3">
            <label className="block text-xs font-semibold text-[#B45309] mb-1">Some rows don't carry a wallet - import those into:</label>
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm w-72">
              {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        )}

        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder="Paste CSV here..."
          rows={8}
          className="w-full border border-stone-300 rounded px-3 py-2 text-sm font-mono mb-3"
        />

        {unresolvedLabels.length > 0 && (
          <div className="bg-[#FFFBEB] border border-[#F59E0B]/40 rounded px-3 py-2.5 mb-3">
            <div className="text-xs font-semibold text-[#B45309] mb-1.5">
              This file mentions {unresolvedLabels.length} wallet{unresolvedLabels.length === 1 ? "" : "s"} not yet in your Wallets list - map {unresolvedLabels.length === 1 ? "it" : "them"} once and every future row with the same name routes automatically:
            </div>
            <div className="space-y-1.5">
              {unresolvedLabels.map((label) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-600 w-64 truncate shrink-0" title={label}>{label}</span>
                  <span className="text-xs text-slate-400 shrink-0">-&gt;</span>
                  <select
                    value={labelMap[label] || ""}
                    onChange={(e) => setLabelMap((prev) => ({ ...prev, [label]: e.target.value }))}
                    className="border border-stone-300 rounded px-2 py-1 text-xs flex-1 max-w-xs"
                  >
                    <option value="">Skip (use wallet selected above)</option>
                    {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 mb-4">
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" id="crypto-csv-file" />
          <label htmlFor="crypto-csv-file" className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 cursor-pointer hover:bg-stone-50">
            <FileUp size={14} /> Upload CSV file
          </label>
          <button onClick={() => setCsvText(SAMPLE_CRYPTO_CSV)} className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 hover:bg-stone-50">
            <Sparkles size={14} /> Load sample data
          </button>
          <button onClick={() => setCsvText(SAMPLE_BITGO_CSV)} className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 hover:bg-stone-50">
            <Sparkles size={14} /> Load Bitgo-style sample
          </button>
          <div className="flex-1" />
          <button
            onClick={runImport}
            className="bg-black hover:bg-[#4D4D4D] text-white text-sm px-4 py-1.5 rounded-full"
          >
            Import
          </button>
        </div>

        {result && (
          <div className="text-sm bg-stone-50 border border-stone-200 rounded px-3 py-2">
            Imported <b>{result.added}</b> transaction{result.added === 1 ? "" : "s"} as drafts.
            {result.autoRouted > 0 && <> <b>{result.autoRouted}</b> auto-routed to a wallet by name or a saved mapping; the rest used the wallet selected above.</>}
            {result.newCoins && result.newCoins.length > 0 && <> Added <b>{result.newCoins.length}</b> new coin{result.newCoins.length === 1 ? "" : "s"} to your Coins list ({result.newCoins.join(", ")}) - set their market rate on the <b>Coins</b> tab.</>}
            {result.dupes > 0 && <> Skipped <b>{result.dupes}</b> duplicate{result.dupes === 1 ? "" : "s"}.</>}
            {result.skipped > 0 && <> Skipped <b>{result.skipped}</b> row{result.skipped === 1 ? "" : "s"} (zero or negligible-dust amount, missing date/coin/quantity/price, or an unsupported type).</>}
            {" "}Check the <b>Transactions</b> tab - anything missing a Ledger Account or destination wallet needs a quick pick before you can post it.
          </div>
        )}
      </div>
    </div>
  );
}

function AddCryptoTxForm({ coins, wallets, accounts, cryptoTxs, onCancel, onSave }) {
  const [tx, setTx] = useState({
    type: "Deposit", date: todayStr(), coinId: coins[0]?.id || "", walletId: "", toWalletId: "",
    quantity: "", perCoinPrice: "", feeQuantity: "", feePerCoinPrice: "",
    ledgerAccountId: "", reference: "", txHash: "", notes: "",
  });
  const draftId = useRef(uid("preview")).current;

  const coin = coins.find((c) => c.id === tx.coinId);
  const numeric = { ...tx, id: draftId, quantity: parseFloat(tx.quantity), perCoinPrice: parseFloat(tx.perCoinPrice), feeQuantity: parseFloat(tx.feeQuantity), feePerCoinPrice: parseFloat(tx.feePerCoinPrice) };

  // Preview against everything that's already posted, plus this draft, so
  // the balance check (and any shortfall) reflects real available cost basis.
  const preview = useMemo(
    () => computeCryptoLedger([...cryptoTxs, numeric], wallets, accounts, coins),
    [cryptoTxs, numeric.type, numeric.date, numeric.coinId, numeric.walletId, numeric.toWalletId, numeric.quantity, numeric.perCoinPrice, numeric.feeQuantity, numeric.feePerCoinPrice, numeric.ledgerAccountId, wallets, accounts, coins]
  );
  const legs = preview.linesByTx.get(draftId) || [];
  const check = cryptoLegsCheck(legs);
  const shortfallReason = preview.errors.get(draftId);
  const gainLeg = legs.find((l) => l.label.startsWith("Realized"));
  // Computed as a plain variable rather than a nested inline ternary in the
  // JSX below (a couple of build setups choke parsing a 3-way ternary with a
  // template literal in the middle branch directly inside a JSX expression).
  let balanceMessage = "- fill in wallet, quantity, price, and ledger account.";
  if (check.balanced) balanceMessage = "- balances.";
  else if (shortfallReason) balanceMessage = "- " + shortfallReason;

  function getRate() {
    if (coin) setTx({ ...tx, perCoinPrice: String(coin.marketRate) });
  }

  function submit() {
    if (!check.balanced) return;
    onSave(numeric);
  }

  return (
    <div className="bg-white border-2 border-[#03D47C]/30 rounded-lg p-4 shadow-sm mb-6">
      <div className="flex gap-3 mb-3 flex-wrap">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Type</label>
          <select value={tx.type} onChange={(e) => setTx({ ...tx, type: e.target.value })}
            className="border border-stone-300 rounded px-2 py-1.5 text-sm">
            {CRYPTO_TX_TYPES.map((t) => <option key={t}>{t}</option>)}
            {CRYPTO_TX_TYPES_DISABLED.map((t) => <option key={t} disabled>{t} (needs cost-basis lots)</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Date</label>
          <DateField value={tx.date} onChange={(v) => setTx({ ...tx, date: v })}
            className="border border-stone-300 rounded px-2 py-1.5 text-sm w-32" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Coin</label>
          <select value={tx.coinId} onChange={(e) => setTx({ ...tx, coinId: e.target.value })}
            className="border border-stone-300 rounded px-2 py-1.5 text-sm">
            {coins.map((c) => <option key={c.id} value={c.id}>{c.symbol} - {c.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-3 mb-3 flex-wrap items-end">
        <div>
          <label className="block text-xs text-slate-500 mb-1">{tx.type === "Transfer" ? "From Wallet" : "Wallet"}</label>
          <select value={tx.walletId} onChange={(e) => setTx({ ...tx, walletId: e.target.value })}
            className="border border-stone-300 rounded px-2 py-1.5 text-sm w-48">
            <option value="">- choose wallet -</option>
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        {tx.type === "Transfer" && (
          <div>
            <label className="block text-xs text-slate-500 mb-1">To Wallet</label>
            <select value={tx.toWalletId} onChange={(e) => setTx({ ...tx, toWalletId: e.target.value })}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm w-48">
              <option value="">- choose wallet -</option>
              {wallets.filter((w) => w.id !== tx.walletId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Quantity</label>
          <input value={tx.quantity} onChange={(e) => setTx({ ...tx, quantity: e.target.value })}
            placeholder="0" className="w-28 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Per Coin Price (USD)</label>
          <div className="flex gap-1">
            <input value={tx.perCoinPrice} onChange={(e) => setTx({ ...tx, perCoinPrice: e.target.value })}
              placeholder="0.00" className="w-28 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
            <button onClick={getRate} title="Use this coin's stored market rate" className="border border-stone-300 rounded px-2 hover:bg-stone-50">
              <RefreshCw size={13} className="text-slate-500" />
            </button>
          </div>
        </div>
        {tx.type !== "Transfer" && (
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-slate-500 mb-1">Ledger Account (the other side of this entry)</label>
            <AccountSelect
              accounts={accounts}
              value={tx.ledgerAccountId}
              onChange={(val) => setTx({ ...tx, ledgerAccountId: val })}
              allowClear
              clearLabel="- choose account -"
              placeholder="- choose account -"
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
        )}
      </div>

      <div className="text-xs text-slate-500 mb-1.5">Fee (optional, drawn from the same wallet/coin)</div>
      <div className="flex gap-3 mb-3 flex-wrap">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Fee Quantity</label>
          <input value={tx.feeQuantity} onChange={(e) => setTx({ ...tx, feeQuantity: e.target.value })}
            placeholder="0" className="w-28 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Fee Per Coin Price (USD)</label>
          <input value={tx.feePerCoinPrice} onChange={(e) => setTx({ ...tx, feePerCoinPrice: e.target.value })}
            placeholder="0.00" className="w-28 border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-xs text-slate-500 mb-1">Reference</label>
          <input value={tx.reference} onChange={(e) => setTx({ ...tx, reference: e.target.value })}
            className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-xs text-slate-500 mb-1">TX Hash</label>
          <input value={tx.txHash} onChange={(e) => setTx({ ...tx, txHash: e.target.value })}
            className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
        </div>
      </div>

      <div className={`flex items-center gap-1.5 text-xs mb-1 ${check.balanced ? "text-[#02B169]" : "text-[#EF4444]"}`}>
        {check.balanced ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
        Debit {money(check.debit || 0)} - Credit {money(check.credit || 0)}{" "}
        {balanceMessage}
      </div>
      {gainLeg && (
        <div className={`text-xs mb-3 ${gainLeg.label.includes("gain") ? "text-[#02B169]" : "text-[#EF4444]"}`}>
          Will realize {gainLeg.label.includes("gain") ? "a gain" : "a loss"} of {money(gainLeg.amount)} against FIFO cost basis.
        </div>
      )}
      {!gainLeg && <div className="mb-3" />}

      <div className="flex gap-2">
        <button onClick={submit} disabled={!check.balanced}
          className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
          Save as draft
        </button>
        <button onClick={onCancel} className="bg-[#F3F4F6] hover:bg-[#E5E7EB] text-black text-sm px-3 py-1.5 rounded-full">Cancel</button>
      </div>
    </div>
  );
}

// ---------- Ledger Connection (bridge to an existing accounting system) ----------

// Client-side-only file download - no server, so a Blob + object URL + a
// synthetic anchor click is the standard way to hand the browser a file to
// save, same pattern every "export CSV" button in a static web app uses.
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const OPENING_BALANCE_SAMPLE_CSV = `code,name,type,balance
101,Cash - Operating,Asset,42500
120,Accounts Receivable,Asset,8200
310101,Common Stock,Equity,25000`;

function LedgerConnectionScreen({ accounts, journal, onImportOpeningBalances }) {
  const { t } = useLang();
  const [csvText, setCsvText] = useState("");
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState([]);
  const [parseError, setParseError] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  function parseRows(text) {
    const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    const rows = parsed.data
      .map((row) => {
        const code = (row.code || row.Code || row.AccountCode || "").trim();
        const name = (row.name || row.Name || row.AccountName || "").trim();
        const type = (row.type || row.Type || row.AccountType || "").trim();
        const balance = parseFloat(row.balance ?? row.Balance ?? row.OpeningBalance ?? row["Opening Balance"]);
        return { code, name, type, balance };
      })
      .filter((r) => r.code && Number.isFinite(r.balance));
    return rows;
  }

  function handleTextChange(text) {
    setCsvText(text);
    setResult(null);
    if (!text.trim()) { setPreview([]); setParseError(""); return; }
    const rows = parseRows(text);
    if (rows.length === 0) {
      setParseError("No usable rows found - each row needs at least code, type, and balance.");
      setPreview([]);
    } else {
      setParseError("");
      setPreview(rows);
    }
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => handleTextChange(String(ev.target.result || ""));
    reader.readAsText(file);
  }

  function loadSample() {
    handleTextChange(OPENING_BALANCE_SAMPLE_CSV);
  }

  function runImport() {
    if (preview.length === 0) return;
    const outcome = onImportOpeningBalances(preview, asOfDate);
    setResult(outcome);
    setCsvText("");
    setPreview([]);
    if (fileRef.current) fileRef.current.value = "";
  }

  // Groups journal lines back into the entry they came from by stripping
  // the trailing "_<index>" this app always appends to line ids, then emits
  // one row per line in a generic QuickBooks/Xero-style General Journal
  // layout - the lowest-common-denominator format virtually every
  // accounting system can re-import.
  function exportJournalCsv() {
    const byEntry = new Map();
    journal.forEach((r) => {
      const entryId = r.id.replace(/_\d+$/, "");
      if (!byEntry.has(entryId)) byEntry.set(entryId, []);
      byEntry.get(entryId).push(r);
    });
    const entryIds = [...byEntry.keys()].sort((a, b) => {
      const linesA = byEntry.get(a), linesB = byEntry.get(b);
      return (linesA[0]?.date || "").localeCompare(linesB[0]?.date || "");
    });
    const header = ["JournalNo", "Date", "AccountCode", "AccountName", "Debit", "Credit", "Memo"];
    const rows = [header.join(",")];
    entryIds.forEach((entryId, idx) => {
      const journalNo = `JE-${String(idx + 1).padStart(5, "0")}`;
      byEntry.get(entryId).forEach((line) => {
        const acc = accounts.find((a) => a.id === line.accountId);
        const memo = (line.description || "").replace(/"/g, '""');
        rows.push([
          journalNo,
          line.date,
          acc?.code || "",
          `"${(acc?.name || "").replace(/"/g, '""')}"`,
          line.debit ? line.debit.toFixed(2) : "",
          line.credit ? line.credit.toFixed(2) : "",
          `"${memo}"`,
        ].join(","));
      });
    });
    downloadTextFile(`primmys-ledger-journal-export-${new Date().toISOString().slice(0, 10)}.csv`, rows.join("\n"));
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_ledgerSync")}</h1>
      <p className="text-sm text-slate-500 mb-6">
        This app runs entirely in your browser, so it can't sync live with QuickBooks, Xero, or any other
        system - but it can bring an existing ledger's balances in to get started, and export everything
        it posts back out as a file your existing system can import.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 mb-6">
        <h2 className="text-sm font-semibold text-black mb-1 flex items-center gap-1.5"><Upload size={15} /> Import existing ledger</h2>
        <p className="text-xs text-slate-500 mb-3">
          Paste or upload a CSV with columns <span className="font-mono">code, name, type, balance</span>.
          Enter each balance as a positive number in that account's normal side (assets/expenses as debit
          balances, liabilities/equity/income as credit balances) - only use a negative number for a
          genuine contra balance, like an overdrawn account. An existing account code is matched and left
          as-is; a new code creates the account. Every stated balance posts once, as of the date below,
          against a new "Opening Balance Equity" account, picking up whatever the trial balance doesn't
          otherwise account for (e.g. retained earnings) - the same bridging convention QuickBooks and
          Xero use for their own opening-balance entries.
        </p>

        <div className="flex items-center gap-2 mb-3">
          <label className="text-xs text-slate-500">As of</label>
          <DateField value={asOfDate} onChange={setAsOfDate}
            className="border border-stone-300 rounded px-2 py-1 text-sm w-28" />
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="text-xs" />
          <button onClick={loadSample} className="text-xs text-slate-500 underline ml-auto">Load sample CSV</button>
        </div>

        <textarea value={csvText} onChange={(e) => handleTextChange(e.target.value)} rows={5}
          placeholder="code,name,type,balance&#10;101,Cash - Operating,Asset,42500"
          className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono mb-3" />

        {parseError && <div className="text-xs text-[#EF4444] mb-3 flex items-center gap-1"><AlertTriangle size={13} />{parseError}</div>}

        {preview.length > 0 && (
          <div className="border border-stone-200 rounded mb-3 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-stone-200">
                  <th className="text-left px-2 py-1.5 font-medium">Code</th>
                  <th className="text-left px-2 py-1.5 font-medium">Name</th>
                  <th className="text-left px-2 py-1.5 font-medium">Type</th>
                  <th className="text-right px-2 py-1.5 font-medium">Balance</th>
                  <th className="text-left px-2 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => {
                  const exists = accounts.some((a) => a.code === r.code);
                  return (
                    <tr key={i} className="border-b border-stone-100 last:border-0">
                      <td className="px-2 py-1.5 font-mono">{r.code}</td>
                      <td className="px-2 py-1.5">{r.name}</td>
                      <td className="px-2 py-1.5">{r.type}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(r.balance)}</td>
                      <td className="px-2 py-1.5 text-slate-500">{exists ? "matches existing account" : "will create new account"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <button onClick={runImport} disabled={preview.length === 0}
          className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
          Import opening balances
        </button>

        {result && (
          <div className="text-xs text-slate-500 mt-3 flex items-center gap-1">
            {result.status === "posted" ? <CheckCircle2 size={13} className="text-[#03D47C]" /> : <AlertTriangle size={13} className="text-[#EF4444]" />}
            {result.status === "posted"
              ? `Posted one balanced entry: ${result.accountsMatched} account${result.accountsMatched === 1 ? "" : "s"} matched, ${result.accountsCreated} created, ${result.legCount} lines.`
              : `Could not post: ${result.reason || "unknown error"}.`}
          </div>
        )}
      </div>

      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4">
        <h2 className="text-sm font-semibold text-black mb-1 flex items-center gap-1.5"><FileUp size={15} /> Export journal entries</h2>
        <p className="text-xs text-slate-500 mb-3">
          Downloads every posted entry across bank, event, and crypto activity as one General Journal CSV
          (JournalNo, Date, AccountCode, AccountName, Debit, Credit, Memo) - a format QuickBooks, Xero, and
          most other systems can import directly.
        </p>
        <button onClick={exportJournalCsv} disabled={journal.length === 0}
          className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
          Export {journal.length} journal line{journal.length === 1 ? "" : "s"} as CSV
        </button>
      </div>
    </div>
  );
}

// ---------- Revaluation (period-end mark-to-market) ----------

function RevaluationScreen({ cryptoTxs, wallets, accounts, coins, revaluations, lockDate, isLocked, onBook, onDelete, onFetchDatedPrices }) {
  const { t } = useLang();
  const [date, setDate] = useState(todayStr());
  const [markPrices, setMarkPrices] = useState({}); // coinId -> string user override (blank = use the fetched mark)
  const [histPrices, setHistPrices] = useState({}); // coinId -> price fetched for the selected date
  const [result, setResult] = useState(null);
  const [loadingMarks, setLoadingMarks] = useState(false);
  // The marks actually used: a user override wins, otherwise the price fetched
  // for the revaluation date.
  const effectiveMarks = { ...histPrices, ...markPrices };

  const { gainAccountId, lossAccountId } = resolveUnrealizedAccounts(accounts);
  const hasAccounts = !!gainAccountId && !!lossAccountId;
  const latest = revaluations.reduce((m, r) => (r.date > m ? r.date : m), "");

  const preview = useMemo(
    () => computeRevaluation(cryptoTxs, wallets, accounts, coins, revaluations, date, effectiveMarks),
    [cryptoTxs, wallets, accounts, coins, revaluations, date, effectiveMarks]
  );
  const bookable = preview.filter((ln) => Math.abs(ln.adjustment) >= 0.005);
  const totalAdj = bookable.reduce((s, ln) => s + ln.adjustment, 0);

  // Distinct coins in view - the mark price is per coin, so it's edited once
  // up top rather than per wallet+coin row.
  const coinsInView = [];
  const seenCoins = new Set();
  preview.forEach((ln) => { if (!seenCoins.has(ln.coinId)) { seenCoins.add(ln.coinId); coinsInView.push({ coinId: ln.coinId, symbol: ln.symbol }); } });

  // Auto-fetch each coin's price as of the selected revaluation date. Which
  // coins are in view doesn't depend on price, so this doesn't loop. A change of
  // date also drops manual overrides so the marks re-default to that date.
  const symbolsKey = coinsInView.map((c) => c.symbol).join(",");
  async function fetchMarks() {
    if (!onFetchDatedPrices || !date || coinsInView.length === 0) return;
    setLoadingMarks(true);
    try {
      const bySym = await onFetchDatedPrices(coinsInView.map((c) => c.symbol), date);
      const byCoin = {};
      coinsInView.forEach((c) => { if (bySym[c.symbol] != null) byCoin[c.coinId] = String(bySym[c.symbol]); });
      setHistPrices(byCoin);
    } catch { /* keep whatever we have */ }
    finally { setLoadingMarks(false); }
  }
  useEffect(() => { fetchMarks(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date, symbolsKey]);

  const dateAfterLatest = !latest || date > latest;
  const locked = isLocked(date);
  const canBook = hasAccounts && dateAfterLatest && !locked && bookable.length > 0;

  const units = (n) => (n ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 }) : "0");
  const walletName = (id) => wallets.find((w) => w.id === id)?.name || "-";
  const markValue = (coinId) => {
    const coin = coins.find((c) => c.id === coinId);
    return effectiveMarks[coinId] !== undefined ? effectiveMarks[coinId] : (coin?.marketRate ?? "");
  };

  function book() {
    const r = onBook(date, effectiveMarks);
    setResult(r);
    if (r.ok) { setMarkPrices({}); setHistPrices({}); }
  }

  const pastRevals = revaluations.slice().sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_revaluation")}</h1>
      <p className="text-sm text-slate-500 mb-5">{t("subtitle_revaluation")}</p>

      {!hasAccounts && (
        <div className="flex items-center gap-1.5 text-xs bg-[#FEF2F2] text-[#B91C1C] border border-[#EF4444]/30 rounded px-3 py-2 mb-4">
          <AlertTriangle size={13} /> No unrealised gain/loss accounts found in the Chart of Accounts. Add an Income account named "Unrealised gain..." and an Expense account named "Unrealised loss..." (Money Buddy's default COA already has both) to enable booking.
        </div>
      )}
      {lockDate && (
        <div className="flex items-center gap-1.5 text-xs bg-[#FFFBEB] text-[#B45309] border border-[#F59E0B]/40 rounded px-3 py-1.5 mb-4">
          <Power size={13} /> Period locked through <b>{lockDate}</b> - revaluations must be dated after it.
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Revaluation date</label>
            <DateField value={date} onChange={(v) => { setDate(v); setResult(null); setMarkPrices({}); setHistPrices({}); }}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm w-32" />
            {!dateAfterLatest && <div className="text-[11px] text-[#B45309] mt-1">Must be after the last revaluation ({latest}).</div>}
          </div>
          {coinsInView.length > 0 && (
            <div className="flex-1 min-w-[240px]">
              <label className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
                Mark prices (USD)
                <span className="text-slate-400">· as of {date}</span>
                <button type="button" onClick={fetchMarks} disabled={loadingMarks} title="Re-fetch prices for this date"
                  className="text-slate-400 hover:text-slate-600 disabled:opacity-40">
                  <RefreshCw size={11} className={loadingMarks ? "animate-spin" : ""} />
                </button>
              </label>
              <div className="flex flex-wrap gap-2">
                {coinsInView.map((c) => (
                  <div key={c.coinId} className="flex items-center gap-1">
                    <span className="text-xs font-medium text-slate-600 w-12 text-right">{c.symbol}</span>
                    <input type="number" step="any" value={markValue(c.coinId)}
                      onChange={(e) => { setMarkPrices((p) => ({ ...p, [c.coinId]: e.target.value })); setResult(null); }}
                      className="w-24 border border-stone-300 rounded px-2 py-1 text-xs font-mono" />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">{loadingMarks ? "Fetching prices for this date…" : <>Auto-filled with each coin's market price on {date}. Edit a value to override it for this revaluation.</>}</p>
            </div>
          )}
          <button onClick={book} disabled={!canBook}
            className="flex items-center gap-1.5 bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
            <Scale size={14} /> Book revaluation
          </button>
        </div>

        {result && (
          <div className={`text-sm rounded px-3 py-2 mt-3 ${result.ok ? "bg-[#E6FBF1] text-[#02B169]" : "bg-[#FEF2F2] text-[#B91C1C]"}`}>
            {result.ok
              ? <>Booked a revaluation across <b>{result.count}</b> holding{result.count === 1 ? "" : "s"} - net unrealized {result.total >= 0 ? "gain" : "loss"} of <b>{money(Math.abs(result.total))}</b>.</>
              : result.reason}
          </div>
        )}
      </div>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Holdings as of {date}</div>
      <div className="-mx-6 px-6 overflow-x-auto">
        <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden min-w-[820px]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200">
                <th className="text-left px-3 py-2 font-medium">Wallet</th>
                <th className="text-left px-3 py-2 font-medium">Asset</th>
                <th className="text-right px-3 py-2 font-medium">Units</th>
                <th className="text-right px-3 py-2 font-medium">Cost basis</th>
                <th className="text-right px-3 py-2 font-medium">Market value</th>
                <th className="text-right px-3 py-2 font-medium">Prior unrealized</th>
                <th className="text-right px-3 py-2 font-medium">Adjustment</th>
              </tr>
            </thead>
            <tbody>
              {preview.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No posted crypto holdings as of this date.</td></tr>
              )}
              {preview.map((ln) => (
                <tr key={`${ln.walletId}|${ln.coinId}`} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 truncate max-w-[200px]">{walletName(ln.walletId)}</td>
                  <td className="px-3 py-2 font-medium">{ln.symbol}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{units(ln.units)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{money(ln.costBasis)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(ln.marketValue)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{money(ln.priorUnrealized)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-medium ${Math.abs(ln.adjustment) < 0.005 ? "text-slate-300" : ln.adjustment > 0 ? "text-[#02B169]" : "text-[#EF4444]"}`}>
                    {ln.adjustment >= 0 ? "+" : "-"}{money(Math.abs(ln.adjustment))}
                  </td>
                </tr>
              ))}
              {preview.length > 0 && (
                <tr className="bg-stone-50 font-medium">
                  <td className="px-3 py-2" colSpan={6}>Net unrealized adjustment to book</td>
                  <td className={`px-3 py-2 text-right font-mono ${totalAdj >= 0 ? "text-[#02B169]" : "text-[#EF4444]"}`}>
                    {totalAdj >= 0 ? "+" : "-"}{money(Math.abs(totalAdj))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pastRevals.length > 0 && (
        <>
          <div className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Booked revaluations ({pastRevals.length})</div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
            {pastRevals.map((r) => {
              const net = r.lines.reduce((s, ln) => s + ln.adjustment, 0);
              const isLatest = r.date === latest;
              return (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
                  <span className="text-slate-400 font-mono w-24 shrink-0">{r.date}</span>
                  <span className="flex-1 text-slate-600">{r.lines.length} holding{r.lines.length === 1 ? "" : "s"} marked</span>
                  <span className={`font-mono shrink-0 ${net >= 0 ? "text-[#02B169]" : "text-[#EF4444]"}`}>
                    {net >= 0 ? "+" : "-"}{money(Math.abs(net))} unrealized
                  </span>
                  {isLatest && !isLocked(r.date)
                    ? <button onClick={() => onDelete(r.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0" title="Remove latest revaluation"><Trash2 size={13} /></button>
                    : <span className="w-[13px] shrink-0" />}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-1.5">Only the most recent revaluation can be removed - earlier ones are the baseline later ones build on.</p>
        </>
      )}
    </div>
  );
}

// ---------- Settings ----------

// App-wide preferences - currently just language, but a natural home for
// any future personal/display setting that isn't part of a tenant's books
// (same reasoning as putting language on LanguageContext instead of
// per-tenant state).
function SettingsScreen({ lockDate = "", onSetLock, explorerKeys = { etherscan: "", tronscan: "", coingecko: "" }, onSetKeys, withdrawFees = [], coins = [], onAddWithdrawFee, onUpdateWithdrawFee, onRemoveWithdrawFee, hasCrypto = false }) {
  const { lang, t, setLang } = useLang();
  const [draftLock, setDraftLock] = useState(lockDate);
  useEffect(() => { setDraftLock(lockDate); }, [lockDate]);
  const setKey = (k, v) => onSetKeys && onSetKeys({ ...explorerKeys, [k]: v.trim() });
  const [newFee, setNewFee] = useState({ coin: "", network: "", fee: "" });
  // Crypto settings (API keys, withdrawal fees) only apply to crypto companies,
  // so they live under their own sub-tab that only shows when this company has
  // crypto. Non-crypto companies see just General.
  const [subTab, setSubTab] = useState("general");
  const activeSub = subTab === "crypto" && !hasCrypto ? "general" : subTab;
  function addFeeRow() {
    if (!newFee.coin.trim() || !(parseFloat(newFee.fee) > 0)) return;
    onAddWithdrawFee({ coin: newFee.coin.trim().toUpperCase(), network: newFee.network.trim(), fee: parseFloat(newFee.fee) });
    setNewFee({ coin: "", network: "", fee: "" });
  }
  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-black mb-1">{t("title_settings")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("subtitle_settings")}</p>

      <div className="flex gap-1 mb-5 border-b border-stone-200">
        {[["general", "General"], ...(hasCrypto ? [["crypto", "Crypto"]] : [])].map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${activeSub === k ? "border-[#03D47C] text-[#02B169] font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {hasCrypto && activeSub === "crypto" && (<>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 mb-4">
        <h2 className="text-sm font-semibold text-black mb-1 flex items-center gap-1.5">
          <SettingsIcon size={15} /> API keys
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          Used to fetch on-chain gas-tank activity and coin prices. Saved with this company and reused every time - enter them once. Prices come from CoinGecko when its key is set (covers every coin incl. TRX), otherwise from Coinbase (keyless, major coins only).
        </p>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs text-slate-500 mb-1">Etherscan API key <span className="text-slate-400">(covers ETH, Polygon, Avalanche)</span></label>
            <input type="password" value={explorerKeys.etherscan || ""} onChange={(e) => setKey("etherscan", e.target.value)}
              placeholder="Free key from etherscan.io/apis" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs text-slate-500 mb-1">TronScan API key <span className="text-slate-400">(optional, for TRX)</span></label>
            <input type="password" value={explorerKeys.tronscan || ""} onChange={(e) => setKey("tronscan", e.target.value)}
              placeholder="Optional - from tronscan.org" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs text-slate-500 mb-1">CoinGecko API key <span className="text-slate-400">(for coin prices)</span></label>
            <input type="password" value={explorerKeys.coingecko || ""} onChange={(e) => setKey("coingecko", e.target.value)}
              placeholder="Free Demo key from coingecko.com" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-stone-100">
          <div className="text-xs font-medium text-slate-500 mb-2">Kraken (via your signing proxy)</div>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[280px]">
              <label className="block text-xs text-slate-500 mb-1">Kraken proxy URL</label>
              <input value={explorerKeys.krakenUrl || ""} onChange={(e) => setKey("krakenUrl", e.target.value)}
                placeholder="https://kraken-proxy.you.workers.dev" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-slate-500 mb-1">Proxy token</label>
              <input type="password" value={explorerKeys.krakenToken || ""} onChange={(e) => setKey("krakenToken", e.target.value)}
                placeholder="PROXY_TOKEN" className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm font-mono" />
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2">Kraken's API needs a signed request, which can't be done from the browser. Deploy the kraken-proxy Worker (holds your read-only Kraken key), then sync from Data Sources.</p>
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 mb-4">
        <h2 className="text-sm font-semibold text-black mb-1 flex items-center gap-1.5">
          <ArrowLeftRight size={15} /> Client withdrawal fees
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          The flat fee Money Buddy charges (and keeps as revenue) on each client withdrawal, per token. On a client withdrawal the fee is carved out of the gross amount: only the net leaves the wallet, and the fee posts to Revenue - withdraw fee (410101). Matched by token symbol; where a token has more than one network, the first row is used.
        </p>
        <div className="overflow-hidden border border-stone-200 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400 border-b border-stone-200 bg-stone-50">
                <th className="text-left px-3 py-2 font-medium">Token</th>
                <th className="text-left px-3 py-2 font-medium">Network</th>
                <th className="text-right px-3 py-2 font-medium">Fee (coin units)</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {withdrawFees.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-xs text-slate-400">No fees configured - add one below.</td></tr>}
              {withdrawFees.map((f) => (
                <tr key={f.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-1.5">
                    <input value={f.coin} onChange={(e) => onUpdateWithdrawFee(f.id, { coin: e.target.value.toUpperCase() })}
                      className="w-20 border border-stone-300 rounded px-2 py-1 text-sm font-mono" />
                  </td>
                  <td className="px-3 py-1.5">
                    <input value={f.network || ""} onChange={(e) => onUpdateWithdrawFee(f.id, { network: e.target.value })}
                      placeholder="e.g. Ethereum (ERC20)" className="w-full border border-stone-300 rounded px-2 py-1 text-sm" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <input type="number" step="any" min="0" value={f.fee}
                      onChange={(e) => onUpdateWithdrawFee(f.id, { fee: parseFloat(e.target.value) || 0 })}
                      className="w-28 text-right border border-stone-300 rounded px-2 py-1 text-sm font-mono tabular-nums" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button onClick={() => onRemoveWithdrawFee(f.id)} className="text-slate-300 hover:text-[#B91C1C]"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
              <tr className="bg-stone-50/50">
                <td className="px-3 py-1.5">
                  <input value={newFee.coin} onChange={(e) => setNewFee({ ...newFee, coin: e.target.value.toUpperCase() })}
                    placeholder="BTC" list="wf-coins" className="w-20 border border-stone-300 rounded px-2 py-1 text-sm font-mono" />
                  <datalist id="wf-coins">{coins.filter((c) => !c.isFiat).map((c) => <option key={c.id} value={c.symbol} />)}</datalist>
                </td>
                <td className="px-3 py-1.5">
                  <input value={newFee.network} onChange={(e) => setNewFee({ ...newFee, network: e.target.value })}
                    placeholder="network (optional)" className="w-full border border-stone-300 rounded px-2 py-1 text-sm" />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input type="number" step="any" min="0" value={newFee.fee} onChange={(e) => setNewFee({ ...newFee, fee: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") addFeeRow(); }}
                    placeholder="0.00" className="w-28 text-right border border-stone-300 rounded px-2 py-1 text-sm font-mono" />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={addFeeRow} disabled={!newFee.coin.trim() || !(parseFloat(newFee.fee) > 0)}
                    className="text-[#02B169] enabled:hover:text-[#02B169] disabled:opacity-30"><Plus size={16} /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      </>)}

      {activeSub === "general" && (<>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4 mb-4">
        <h2 className="text-sm font-semibold text-black mb-1 flex items-center gap-1.5">
          <Languages size={15} /> {t("settings_language")}
        </h2>
        <p className="text-xs text-slate-500 mb-3">{t("settings_languageHelp")}</p>
        <div className="flex gap-2">
          {Object.keys(LANGUAGES).map((code) => (
            <button
              key={code}
              onClick={() => setLang(code)}
              className={`px-3 py-1.5 rounded-full text-sm border ${
                lang === code
                  ? "bg-black text-white border-black"
                  : "bg-white text-slate-600 border-stone-300 hover:border-stone-400"
              }`}
            >
              {LANGUAGES[code]}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-lg shadow-sm p-4">
        <h2 className="text-sm font-semibold text-black mb-1 flex items-center gap-1.5">
          <Power size={15} /> Period lock
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          Close the books through a chosen date. Once locked, no transaction dated on or before it can be posted, edited, or deleted on either the bank or crypto side - an internal control that keeps a finished period from being changed after the fact. This is per-company and applies to everyone using this workspace.
        </p>
        {lockDate ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5 text-sm bg-[#FFFBEB] text-[#B45309] border border-[#F59E0B]/40 rounded-full px-3 py-1">
              Locked through <b>{lockDate}</b>
            </span>
            <DateField value={draftLock} min={lockDate} onChange={setDraftLock}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm w-32" />
            <button onClick={() => draftLock && onSetLock(draftLock)} disabled={!draftLock || draftLock === lockDate}
              className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
              Extend lock
            </button>
            <button
              onClick={() => { if (window.confirm("Unlock the period? Transactions in this range will become editable again.")) onSetLock(""); }}
              className="text-sm text-slate-500 hover:text-[#B91C1C] px-2">
              Unlock
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <DateField value={draftLock} onChange={setDraftLock}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm w-32" />
            <button onClick={() => draftLock && onSetLock(draftLock)} disabled={!draftLock}
              className="flex items-center gap-1.5 bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-full">
              <Power size={13} /> Lock through this date
            </button>
          </div>
        )}
      </div>
      </>)}
    </div>
  );
}
