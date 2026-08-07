import { useState, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  BookOpen, Upload, ListChecks, ScrollText, BarChart3, Plus, Trash2,
  CheckCircle2, AlertTriangle, Landmark, Pencil, FileUp, Sparkles,
  Layers, Wand2, XCircle, Power, Zap, Coins as CoinsIcon, Wallet as WalletIcon,
  ArrowLeftRight, RefreshCw
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
  { id: "acc_112101", code: "112101", name: "Bitgo - Company #USD", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112102", code: "112102", name: "Bitgo hot wallet - Company #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112103", code: "112103", name: "Bitgo hot wallet - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112104", code: "112104", name: "Bitgo cold wallet - Company #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112105", code: "112105", name: "Bitgo cold wallet - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_112106", code: "112106", name: "Bitgo gas wallet - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113101", code: "113101", name: "Bitgo hot wallet - for Client #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113102", code: "113102", name: "Bitgo hot wallet - for Client #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113103", code: "113103", name: "Bitgo cold wallet - for Client #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113104", code: "113104", name: "Bitgo cold wallet - for Client #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113105", code: "113105", name: "Bitgo earn wallet - for Client", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_113201", code: "113201", name: "Defi pool - for Client", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_121102", code: "121102", name: "Binance spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_121103", code: "121103", name: "Binance spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_131101", code: "131101", name: "Binance margin - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_132101", code: "132101", name: "Binance - Futures position MTM (asset side)", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_122102", code: "122102", name: "Kinesis spot - Company #USD", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_122103", code: "122103", name: "Kinesis spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_122104", code: "122104", name: "Kinesis spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_123102", code: "123102", name: "Kraken spot - Company #USD", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_123103", code: "123103", name: "Kraken spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_123104", code: "123104", name: "Kraken spot - Company #Crypto", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_131102", code: "131102", name: "Kraken margin - Company", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_132102", code: "132102", name: "Kraken - Futures position MTM (asset side)", type: "Asset", isBank: false, cf: "operating" },
  { id: "acc_124102", code: "124102", name: "OKX spot - Company #Stablecoin", type: "Asset", isBank: false, cf: "operating" },
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
  // ---- Equity ----
  { id: "acc_310101", code: "310101", name: "Share capital", type: "Equity", isBank: false, cf: "financing" },
  { id: "acc_310201", code: "310201", name: "Net profit", type: "Equity", isBank: false, cf: "financing" },
  { id: "acc_310202", code: "310202", name: "Retained Earnings", type: "Equity", isBank: false, cf: "financing" },
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
  { id: "acc_520302", code: "520302", name: "Binance fee", type: "Expense", isBank: false },
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
// actual on-chain or exchange balance, so they're left out.
function deriveDefaultWallets(accounts) {
  return accounts
    .filter((a) => a.type === "Asset" && !a.isBank && /^1[123]/.test(a.code))
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
const SAMPLE_CRYPTO_CSV = `Date,Type,Coin,Quantity,Price,FeeQuantity,FeePerCoinPrice,ToWallet,LedgerAccount,Reference,TxHash
2026-05-01,Deposit,BTC,1,58000,,,,310101,In-kind capital contribution,0xabc123
2026-05-10,Deposit,BTC,0.4,61000,,,,210302,Client custody deposit,0xdef456
2026-05-15,Transfer,BTC,0.5,63000,0.001,63000,Bitgo cold wallet - Company #Crypto,,Routine hot-to-cold sweep,0xghi789
2026-05-20,Withdrawal,BTC,0.3,65000,0.0005,65000,,140301,Converted to fiat for payout,0xjkl012
2026-06-01,Withdrawal,BTC,0.1,66000,,,,,Unmatched wire out,0xmno345`;

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
const CRYPTO_TX_TYPES = ["Deposit", "Withdrawal", "Transfer"];
const CRYPTO_TX_TYPES_DISABLED = ["Trade"];

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
  const gainLossLegs = (diff) => {
    if (Math.abs(diff) <= 0.005) return [];
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

  const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));

  for (const t of sorted) {
    const wallet = wallets.find((w) => w.id === t.walletId);
    const toWallet = wallets.find((w) => w.id === t.toWalletId);
    const value = coinValue(t.quantity, t.perCoinPrice);
    const feeValue = coinValue(t.feeQuantity, t.feePerCoinPrice);
    const hasFee = Number.isFinite(feeValue) && feeValue > 0;

    if (t.type === "Deposit") {
      if (!wallet || !Number.isFinite(value) || value <= 0) {
        errors.set(t.id, "Missing wallet or quantity/price.");
        continue;
      }
      const splits = resolveLedgerSplits(t, value);
      if (!splits) { errors.set(t.id, "Missing ledger account, or splits don't add up to the deposit value."); continue; }
      const netQty = t.quantity - (hasFee ? t.feeQuantity : 0);
      if (netQty <= 0) { errors.set(t.id, "Fee quantity can't exceed the deposited quantity."); continue; }
      addLot(t.walletId, t.coinId, netQty, t.perCoinPrice, t.date);
      const legs = [{ side: "debit", accountId: wallet.accountId, amount: value, label: "Wallet (received)" }];
      splits.forEach((s) => legs.push({ side: "credit", accountId: s.accountId, amount: s.amount, label: "Ledger account" }));
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
      const splits = resolveLedgerSplits(t, value);
      if (!splits) { errors.set(t.id, "Missing ledger account, or splits don't add up to the withdrawal value."); continue; }
      const totalOut = t.quantity + (hasFee ? t.feeQuantity : 0);
      const result = consumeFifo(t.walletId, t.coinId, totalOut);
      if (!result) { errors.set(t.id, "Not enough recorded cost basis in this wallet for this quantity."); continue; }
      const feeShare = hasFee ? t.feeQuantity / totalOut : 0;
      const feeCostBasis = result.costBasis * feeShare;
      const withdrawalCostBasis = result.costBasis - feeCostBasis;
      const legs = [];
      splits.forEach((s) => legs.push({ side: "debit", accountId: s.accountId, amount: s.amount, label: "Ledger account (proceeds)" }));
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
      if (!result) { errors.set(t.id, "Not enough recorded cost basis in this wallet for this quantity."); continue; }
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
function parseCryptoCsvRow(row, walletId, coins, accounts, wallets) {
  const type = (row.Type || row.type || "").trim();
  if (!CRYPTO_TX_TYPES.includes(type)) return null;
  const date = (row.Date || row.date || "").trim();
  const coinSymbol = (row.Coin || row.coin || "").trim().toUpperCase();
  const coin = coins.find((c) => c.symbol === coinSymbol);
  const quantity = parseFloat(row.Quantity ?? row.quantity);
  const perCoinPrice = parseFloat(row.Price ?? row.price);
  const feeQuantityRaw = parseFloat(row.FeeQuantity ?? row.feeQuantity);
  const feePerCoinPriceRaw = parseFloat(row.FeePerCoinPrice ?? row.feePerCoinPrice);
  // A row with no recognizable date/coin/quantity/price isn't a transaction
  // at all - skip it entirely rather than creating an empty draft.
  if (!date || !coin || !Number.isFinite(quantity) || !Number.isFinite(perCoinPrice)) return null;

  const tx = {
    type, date, coinId: coin.id, walletId,
    quantity, perCoinPrice,
    feeQuantity: Number.isFinite(feeQuantityRaw) ? feeQuantityRaw : undefined,
    feePerCoinPrice: Number.isFinite(feePerCoinPriceRaw) ? feePerCoinPriceRaw : undefined,
    reference: (row.Reference || row.reference || "").trim(),
    txHash: (row.TxHash || row.txHash || "").trim(),
    notes: (row.Notes || row.notes || "").trim(),
  };
  if (type === "Transfer") {
    const toWalletName = (row.ToWallet || row.toWallet || "").trim();
    const toWallet = wallets.find((w) => w.name === toWalletName);
    tx.toWalletId = toWallet?.id; // left undefined if unresolved - fixable inline
  } else {
    const acctRef = (row.LedgerAccount || row.ledgerAccount || "").trim();
    const acct = accounts.find((a) => a.code === acctRef || a.name === acctRef);
    tx.ledgerAccountId = acct?.id; // left undefined if unresolved - fixable inline
  }
  return tx;
}

// A "remembered" rule for crypto: since CSV rows don't have free-text
// description the way a bank line does, the closest natural match key is
// (transaction type, coin) - e.g. "BTC deposits always go to Share
// capital." Applied only when a row didn't already resolve a ledger
// account on its own (Transfer's ToWallet is never rule-matched - it's a
// specific destination, not a category).
function applyCryptoRule(tx, rules) {
  if (tx.type === "Transfer" || tx.ledgerAccountId) return undefined;
  const rule = rules.find((r) => r.type === tx.type && r.coinId === tx.coinId);
  return rule?.ledgerAccountId;
}

function importCryptoCsv(text, walletId, wallets, coins, accounts, existingTxs, rules = []) {
  const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  const existingHashes = new Set(existingTxs.map((t) => t.hash).filter(Boolean));
  let added = 0, dupes = 0, skipped = 0;
  const next = [];
  parsed.data.forEach((row) => {
    const tx = parseCryptoCsvRow(row, walletId, coins, accounts, wallets);
    if (!tx) { skipped++; return; }
    const hash = `${tx.date}|${tx.type}|${tx.walletId}|${tx.coinId}|${tx.quantity}|${tx.perCoinPrice}`;
    if (existingHashes.has(hash)) { dupes++; return; }
    existingHashes.add(hash);
    const ruleAccountId = applyCryptoRule(tx, rules);
    if (ruleAccountId) { tx.ledgerAccountId = ruleAccountId; tx.matchedByRule = true; }
    next.push({ ...tx, hash });
    added++;
  });
  return { added, dupes, skipped, txs: next };
}

function useJournal(transactions) {
  return useMemo(() => {
    const lines = [];
    transactions.filter((t) => t.posted).forEach((t) => {
      journalLinesFor(t).forEach((l, i) =>
        lines.push({ id: `${t.id}_${i}`, transactionId: t.id, date: t.date, description: t.description, ...l })
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

async function loadData() {
  try {
    if (!window.storage) return null;
    const res = await window.storage.get(STORAGE_KEY, false);
    return res ? JSON.parse(res.value) : null;
  } catch {
    return null;
  }
}
async function saveData(data) {
  try {
    if (!window.storage) return;
    await window.storage.set(STORAGE_KEY, JSON.stringify(data), false);
  } catch {
    /* best-effort */
  }
}

// ---------- UI ----------

// Grouped for the sidebar - Bank and Crypto both "bring in external
// transactions and post them" but work differently under the hood (free-text
// rule-matching vs. structured FIFO cost basis), so they stay separate
// screens; grouping just makes the relationship visible in the nav.
const NAV_GROUPS = [
  {
    label: "General",
    items: [{ key: "coa", label: "Chart of Accounts", icon: BookOpen }],
  },
  {
    label: "Bank",
    items: [
      { key: "import", label: "Import", icon: Upload },
      { key: "categorize", label: "Categorize", icon: ListChecks },
    ],
  },
  {
    label: "Crypto",
    items: [
      { key: "coins", label: "Coins", icon: CoinsIcon },
      { key: "wallets", label: "Wallets", icon: WalletIcon },
      { key: "cryptoTx", label: "Crypto Transactions", icon: ArrowLeftRight },
    ],
  },
  {
    // Referral payouts and gas fees - today's two sample event types - are
    // both crypto-side activity, so this sits right after Crypto rather
    // than up near Bank.
    label: "Automation",
    items: [{ key: "types", label: "Transaction Types", icon: Layers }],
  },
  {
    label: "Reporting",
    items: [
      { key: "ledger", label: "Ledger", icon: ScrollText },
      { key: "reports", label: "Reports", icon: BarChart3 },
    ],
  },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

export default function App() {
  const [ready, setReady] = useState(false);
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [transactions, setTransactions] = useState([]);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [events, setEvents] = useState([]);
  const [registry, setRegistry] = useState(DEFAULT_REGISTRY);
  const [coins, setCoins] = useState(DEFAULT_COINS);
  const [wallets, setWallets] = useState(() => deriveDefaultWallets(DEFAULT_ACCOUNTS));
  const [cryptoTxs, setCryptoTxs] = useState([]);
  const [cryptoRules, setCryptoRules] = useState([]);
  const [tab, setTab] = useState("coa");
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      const saved = await loadData();
      if (saved) {
        setAccounts(saved.accounts || DEFAULT_ACCOUNTS);
        setTransactions(saved.transactions || []);
        setRules(saved.rules || DEFAULT_RULES);
        setEvents(saved.events || []);
        setRegistry(saved.registry || DEFAULT_REGISTRY);
        setCoins(saved.coins || DEFAULT_COINS);
        setWallets(saved.wallets || deriveDefaultWallets(saved.accounts || DEFAULT_ACCOUNTS));
        setCryptoTxs(saved.cryptoTxs || []);
        setCryptoRules(saved.cryptoRules || []);
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveData({ accounts, transactions, rules, events, registry, coins, wallets, cryptoTxs, cryptoRules });
  }, [accounts, transactions, rules, events, registry, coins, wallets, cryptoTxs, cryptoRules, ready]);

  const bankJournal = useJournal(transactions);
  const eventJournal = useMemo(() => {
    const lines = [];
    events.filter((e) => e.status === "posted").forEach((e) => {
      const label = registry.find((t) => t.id === e.templateId)?.label || e.eventType;
      e.legs.forEach((l, i) =>
        lines.push({
          id: `${e.id}_${i}`, date: e.date, description: label,
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
          id: `${t.id}_${i}`, date: t.date, description: `${t.type} ${coin?.symbol || ""} - ${l.label}`,
          accountId: l.accountId, debit: l.side === "debit" ? l.amount : 0, credit: l.side === "credit" ? l.amount : 0,
        })
      );
    });
    return lines;
  }, [cryptoTxs, cryptoLedger, coins]);
  const journal = useMemo(() => [...bankJournal, ...eventJournal, ...cryptoJournal], [bankJournal, eventJournal, cryptoJournal]);

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
  function updateAccount(id, patch) {
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  function deleteAccount(id) {
    if (journal.some((j) => j.accountId === id)) return;
    setAccounts((prev) => prev.filter((a) => a.id !== id));
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

  function addCoin(coin) {
    setCoins((prev) => [...prev, { ...coin, id: uid("coin") }]);
  }
  function updateCoinRate(id, marketRate) {
    setCoins((prev) => prev.map((c) => (c.id === id ? { ...c, marketRate } : c)));
  }

  function addWallet(wallet) {
    setWallets((prev) => [...prev, { ...wallet, id: uid("wal") }]);
  }
  function deleteWallet(id) {
    if (cryptoTxs.some((t) => t.walletId === id || t.toWalletId === id)) return;
    setWallets((prev) => prev.filter((w) => w.id !== id));
  }

  // A new crypto transaction is always saved as a draft (posted: false) -
  // "Build Journals" is the separate, explicit step that pushes drafts into
  // the real ledger, mirroring the reference's two-phase build-then-post flow.
  function addCryptoTx(tx) {
    setCryptoTxs((prev) => [...prev, { ...tx, id: uid("ctx"), posted: false }]);
  }
  function importCryptoCsvHandler(text, walletId) {
    const result = importCryptoCsv(text, walletId, wallets, coins, accounts, cryptoTxs, cryptoRules);
    setCryptoTxs((prev) => [...prev, ...result.txs.map((tx) => ({ ...tx, id: uid("ctx"), posted: false }))]);
    return { added: result.added, dupes: result.dupes, skipped: result.skipped };
  }
  // The one thing a Drafts-list row can be fixed up after the fact - a
  // missing Ledger Account or destination wallet, same "one field short"
  // gap a CSV-imported bank row has before Categorize. Posted transactions
  // are immutable for the same FIFO-history reason deletion is restricted.
  function updateCryptoTx(id, patch) {
    setCryptoTxs((prev) => prev.map((t) => (t.id === id && !t.posted ? { ...t, ...patch } : t)));
  }
  // Needs Review's per-row Post - the crypto equivalent of Categorize's
  // Post button. Applies the chosen account (or split, or destination
  // wallet) to just this one draft, then checks - via the same FIFO engine
  // the live ledger uses - whether it actually resolves before marking it
  // posted. Other drafts sitting in the queue are untouched; they still
  // wait for either their own Post or a batch Build Journals.
  function postCryptoTx(id, patch) {
    const updated = cryptoTxs.map((t) => (t.id === id ? { ...t, ...patch } : t));
    const attempt = computeCryptoLedger(updated, wallets, accounts, coins);
    if (!attempt.linesByTx.has(id)) return { ok: false, reason: attempt.errors.get(id) };
    setCryptoTxs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch, posted: true } : t)));
    return { ok: true };
  }
  // "remember" on a Needs Review row - saves a (type, coin) -> account rule
  // so future CSV imports of the same kind resolve automatically instead of
  // needing review again. A newer rule for the same (type, coin) replaces
  // the old one.
  function rememberCryptoRule(type, coinId, ledgerAccountId) {
    setCryptoRules((prev) => [...prev.filter((r) => !(r.type === type && r.coinId === coinId)), { id: uid("crule"), type, coinId, ledgerAccountId }]);
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
      prev.map((t) => (!t.posted && attempt.linesByTx.has(t.id) ? { ...t, posted: true } : t))
    );
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
          <div className="text-[11px] uppercase tracking-widest text-slate-500 mt-0.5">double-entry, automated</div>
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                {group.label}
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
                    {n.label}
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
            {balanced ? "Ledger balanced" : "Out of balance"}
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
            onDelete={deleteAccount}
          />
        )}
        {tab === "import" && (
          <ImportScreen
            bankAccounts={bankAccounts}
            accounts={accounts}
            onImport={importCsv}
            onUpdateAccount={updateAccount}
            fileRef={fileRef}
          />
        )}
        {tab === "categorize" && (
          <Categorize
            transactions={transactions}
            accounts={accounts}
            rules={rules}
            setTransactions={setTransactions}
            setRules={setRules}
          />
        )}
        {tab === "types" && (
          <TransactionTypes
            accounts={accounts}
            events={events}
            registry={registry}
            onAddEvent={addEvent}
            onSaveTemplate={saveTemplate}
            onToggleTemplate={toggleTemplateStatus}
          />
        )}
        {tab === "coins" && (
          <CoinsScreen coins={coins} onAdd={addCoin} onUpdateRate={updateCoinRate} />
        )}
        {tab === "wallets" && (
          <WalletsScreen wallets={wallets} accounts={accounts} onAdd={addWallet} onDelete={deleteWallet} />
        )}
        {tab === "cryptoTx" && (
          <CryptoTransactions
            cryptoTxs={cryptoTxs}
            coins={coins}
            wallets={wallets}
            accounts={accounts}
            cryptoLedger={cryptoLedger}
            cryptoRules={cryptoRules}
            onAdd={addCryptoTx}
            onUpdate={updateCryptoTx}
            onDelete={deleteCryptoTx}
            onBuildJournals={buildJournals}
            onLoadSample={loadSampleCryptoTxs}
            onImportCsv={importCryptoCsvHandler}
            onPostOne={postCryptoTx}
            onRemember={rememberCryptoRule}
          />
        )}
        {tab === "ledger" && <LedgerView accounts={accounts} journal={journal} />}
        {tab === "reports" && <Reports accounts={accounts} journal={journal} />}
      </div>
    </div>
  );
}

// ---------- Chart of Accounts ----------

function ChartOfAccounts({ accounts, journal, onAdd, onDelete }) {
  const [form, setForm] = useState({ code: "", name: "", type: "Expense", isBank: false, cf: undefined });
  const [similarId, setSimilarId] = useState("");

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

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">Chart of Accounts</h1>
      <p className="text-sm text-slate-500 mb-5">Set up once, edit as your business changes. History-bearing accounts can't be deleted.</p>

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
            <Plus size={14} /> Add
          </button>
        </div>
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
                  {rows.map((a) => (
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
                      <td className="px-3 py-2 w-10 text-right">
                        <button onClick={() => onDelete(a.id)}
                          disabled={journal.some((j) => j.accountId === a.id)}
                          title={journal.some((j) => j.accountId === a.id) ? "Has transaction history" : "Delete"}
                          className="text-slate-300 enabled:hover:text-[#B91C1C] disabled:opacity-30">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
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

// ---------- Import ----------

function ImportScreen({ bankAccounts, accounts, onImport, onUpdateAccount, fileRef }) {
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
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-black mb-1">Import transactions</h1>
      <p className="text-sm text-slate-500 mb-5">
        CSV with <span className="font-mono">Date, Description, Amount</span> columns. Duplicates (same date + amount + description) are skipped automatically.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm">
        <div className="flex items-end gap-3 mb-1">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Import into</label>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm w-64">
              {bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
            </select>
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
                  <select value={candidateId} onChange={(e) => setCandidateId(e.target.value)}
                    className="w-full border border-stone-300 rounded px-2 py-1.5 text-xs">
                    {candidates.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                  </select>
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

function Categorize({ transactions, accounts, rules, setTransactions, setRules }) {
  const pending = transactions.filter((t) => !t.posted).sort((a, b) => a.date.localeCompare(b.date));
  const posted = transactions.filter((t) => t.posted).sort((a, b) => b.date.localeCompare(a.date));
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
    const accountId = choice[tx.id] || tx.mappedAccountId;
    if (!accountId) return; // real COA has no generic "other income" bucket - a choice is required
    setTransactions((prev) => prev.map((t) => (t.id === tx.id ? { ...t, mappedAccountId: accountId, splits: null, posted: true } : t)));
    if (remember[tx.id]) {
      setRules((prev) => [...prev, { id: uid("rule"), pattern: tx.description, accountId }]);
    }
  }

  function unpost(tx) {
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
    const rows = (splitRows[t.id] || []).map((r) => ({ accountId: r.accountId, amount: Number(r.amount) || 0 }));
    if (rows.some((r) => !r.accountId || !(r.amount > 0))) return;
    const total = rows.reduce((s, r) => s + r.amount, 0);
    if (Math.abs(total - Math.abs(t.amount)) > 0.005) return;
    setTransactions((prev) => prev.map((tx) => (tx.id === t.id ? { ...tx, splits: rows, mappedAccountId: rows[0].accountId, posted: true } : tx)));
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">Categorize</h1>
      <p className="text-sm text-slate-500 mb-5">
        The bank side of every entry is automatic - you're only ever picking the other account(s). Outflows debit the category and credit the bank; inflows do the reverse.
        One transaction spanning more than one category? Split it across several accounts instead of picking just one.
      </p>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Needs review ({pending.length})</div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
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
                <select
                  value={selected}
                  onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}
                  className={`border rounded px-2 py-1 text-xs w-48 ${selected ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                >
                  <option value="">- choose account -</option>
                  {accounts.filter((a) => !a.isBank).map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                </select>
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
                  <select
                    value={r.accountId}
                    onChange={(e) => updateSplitRow(t.id, i, { accountId: e.target.value })}
                    className={`flex-1 border rounded px-2 py-1 text-xs ${r.accountId ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                  >
                    <option value="">- choose account -</option>
                    {accounts.filter((a) => !a.isBank).map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                  </select>
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

function LedgerView({ accounts, journal }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const acc = accounts.find((a) => a.id === accountId);
  const rows = journal.filter((j) => j.accountId === accountId).sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-black mb-1">General Ledger</h1>
      <p className="text-sm text-slate-500 mb-4">Every posted entry for one account, with a running balance.</p>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
        className="border border-stone-300 rounded px-2 py-1.5 text-sm mb-4 w-64">
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
      </select>

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

function Reports({ accounts, journal }) {
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
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-black mb-1">Reports</h1>
      <p className="text-sm text-slate-500 mb-4">Computed live from the journal - never stored, never stale.</p>

      <div className="flex gap-1 mb-5 border-b border-stone-200">
        {[["trial", "Trial Balance"], ["income", "Income Statement"], ["balance", "Balance Sheet"], ["cashflow", "Cash Flow"]].map(([k, l]) => (
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
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const d = journal.filter((j) => j.accountId === a.id).reduce((s, j) => s + j.debit, 0);
                const c = journal.filter((j) => j.accountId === a.id).reduce((s, j) => s + j.credit, 0);
                if (!d && !c) return null;
                return (
                  <tr key={a.id} className="border-b border-stone-100 last:border-0">
                    <td className="px-3 py-2">{a.code} - {a.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{d ? money(d) : ""}</td>
                    <td className="px-3 py-2 text-right font-mono">{c ? money(c) : ""}</td>
                  </tr>
                );
              })}
              <tr className="bg-stone-50 font-medium">
                <td className="px-3 py-2">Totals</td>
                <td className="px-3 py-2 text-right font-mono">{money(totalDebits)}</td>
                <td className="px-3 py-2 text-right font-mono">{money(totalCredits)}</td>
              </tr>
            </tbody>
          </table>
          <div className={`flex items-center gap-1.5 px-3 py-2 text-xs ${Math.abs(totalDebits - totalCredits) < 0.005 ? "text-[#02B169]" : "text-[#EF4444]"}`}>
            {Math.abs(totalDebits - totalCredits) < 0.005 ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {Math.abs(totalDebits - totalCredits) < 0.005 ? "Debits equal credits." : "Out of balance - this should never happen."}
          </div>
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

function TransactionTypes({ accounts, events, registry, onAddEvent, onSaveTemplate, onToggleTemplate }) {
  const [builderFor, setBuilderFor] = useState(null); // { event, existingTemplate } | null

  const needsMapping = events.filter((e) => e.status === "unmapped");
  const needsReview = events.filter((e) => e.status === "error");
  const posted = events.filter((e) => e.status === "posted").slice().reverse().slice(0, 12);

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">Transaction Types</h1>
      <p className="text-sm text-slate-500 mb-5">
        A new kind of transaction gets mapped once - which accounts it debits/credits and where each amount comes from.
        Once that mapping is saved, every future transaction of the same type posts automatically.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-3 shadow-sm mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-xs text-slate-400 mr-1">Simulate incoming event:</span>
        <button onClick={() => onAddEvent(makeReferralEvent())}
          className="flex items-center gap-1.5 text-xs border border-stone-300 rounded px-2.5 py-1 hover:bg-stone-50">
          <Zap size={12} /> Referral payout
        </button>
        <button onClick={() => onAddEvent(makeGasFeeEvent("direct"))}
          className="flex items-center gap-1.5 text-xs border border-stone-300 rounded px-2.5 py-1 hover:bg-stone-50">
          <Zap size={12} /> Gas fee - direct (hot wallet)
        </button>
        <button onClick={() => onAddEvent(makeGasFeeEvent("prepaid"))}
          className="flex items-center gap-1.5 text-xs border border-stone-300 rounded px-2.5 py-1 hover:bg-stone-50">
          <Zap size={12} /> Gas fee - prepaid (gas wallet)
        </button>
        <button onClick={() => onAddEvent(makeCryptoSellEvent("OKX"))}
          className="flex items-center gap-1.5 text-xs border border-stone-300 rounded px-2.5 py-1 hover:bg-stone-50">
          <Zap size={12} /> Crypto sell - OKX
        </button>
      </div>

      <CustomEventForm onAddEvent={onAddEvent} />

      {builderFor && (
        <TemplateBuilder
          sampleTx={builderFor.event}
          existingTemplate={builderFor.existingTemplate}
          accounts={accounts}
          registrySize={registry.length}
          onCancel={() => setBuilderFor(null)}
          onSave={(t) => { onSaveTemplate(t); setBuilderFor(null); }}
        />
      )}

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Needs mapping - new type ({needsMapping.length})
      </div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
        {needsMapping.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing unrecognized right now.</div>}
        {needsMapping.map((e) => (
          <div key={e.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
            <span className="text-xs uppercase tracking-wide bg-[#FFFBEB] text-[#B45309] px-1.5 py-0.5 rounded shrink-0">{e.eventType}</span>
            <span className="flex-1 text-slate-500 truncate">
              {Object.entries(e).filter(([k]) => !["id", "date", "status", "reason", "templateId", "legs"].includes(k))
                .map(([k, v]) => `${k}: ${v}`).join("  -  ")}
            </span>
            <button
              onClick={() => setBuilderFor({ event: e, existingTemplate: null })}
              className="flex items-center gap-1.5 bg-black hover:bg-[#4D4D4D] text-white text-xs px-2.5 py-1 rounded-full shrink-0"
            >
              <Wand2 size={12} /> Define mapping
            </button>
          </div>
        ))}
      </div>

      {needsReview.length > 0 && (
        <>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Needs review - mapping broke down ({needsReview.length})
          </div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
            {needsReview.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
                <XCircle size={14} className="text-[#EF4444] shrink-0" />
                <span className="flex-1 text-slate-600">
                  <span className="text-slate-400">{e.eventType}</span> - {e.reason}
                </span>
                <button
                  onClick={() => setBuilderFor({ event: e, existingTemplate: registry.find((t) => t.id === e.templateId) || null })}
                  className="flex items-center gap-1.5 border border-stone-300 text-xs px-2.5 py-1 rounded shrink-0 hover:bg-stone-50"
                >
                  <Pencil size={12} /> Fix mapping
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Active templates ({registry.length})</div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
        {registry.length === 0 && <div className="p-4 text-sm text-slate-400">No mappings defined yet - map a new type above to create one.</div>}
        {registry.map((t) => (
          <div key={t.id} className="px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-400 w-10 shrink-0">{t.code}</span>
              <span className="font-medium flex-1">{t.label}</span>
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${t.status === "active" ? "bg-[#E6FBF1] text-[#02B169]" : "bg-stone-100 text-stone-500"}`}>
                {t.status}
              </span>
              <button
                onClick={() => setBuilderFor({ event: sampleTxFromTemplate(t), existingTemplate: t })}
                className="text-slate-300 hover:text-slate-600 shrink-0"
                title="Edit this mapping - accounts, field names, percentages"
              >
                <Pencil size={13} />
              </button>
              <button onClick={() => onToggleTemplate(t.id)} className="text-slate-300 hover:text-slate-600 shrink-0" title={t.status === "active" ? "Deactivate" : "Reactivate"}>
                <Power size={13} />
              </button>
            </div>
            <div className="text-xs text-slate-400 mt-1">Matches: {matchLabel(t)}</div>
            <div className="text-xs text-slate-500 font-mono mt-0.5">{t.legs.map(legLabel).join("   /   ")}</div>
          </div>
        ))}
      </div>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Auto-posted</div>
      <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
        {posted.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing posted yet.</div>}
        {posted.map((e) => {
          const t = registry.find((r) => r.id === e.templateId);
          return (
            <div key={e.id} className="flex items-center gap-3 px-3 py-2 border-b border-stone-100 last:border-0 text-sm">
              <span className="text-slate-400 font-mono w-24 shrink-0">{e.date}</span>
              <span className="text-xs uppercase tracking-wide bg-[#E6FBF1] text-[#02B169] px-1.5 py-0.5 rounded shrink-0">{t?.code || "-"}</span>
              <span className="flex-1 text-slate-600 truncate">{t?.label || e.eventType}</span>
              <span className="text-xs font-mono text-slate-500">
                {e.legs.map((l) => `${l.side === "debit" ? "Dr" : "Cr"} ${money(l.amount)}`).join(" / ")}
              </span>
            </div>
          );
        })}
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
                  <select
                    value={leg.accountRef}
                    onChange={(e) => updateLeg(i, { accountRef: e.target.value })}
                    className={`flex-1 border rounded px-2 py-1.5 text-xs ${leg.accountRef && !resolved?.accountId ? "border-[#EF4444]/50" : "border-stone-300"}`}
                  >
                    <option value="">- choose account -</option>
                    {sortedAccounts.map((a) => <option key={a.id} value={a.name}>{a.code} - {a.name}</option>)}
                  </select>
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

function CoinsScreen({ coins, onAdd, onUpdateRate }) {
  const [form, setForm] = useState({ symbol: "", name: "", rateSymbol: "", isFiat: false, assetType: "Crypto", chain: "", category: "", marketRate: "" });
  const [rateEdits, setRateEdits] = useState({});

  function submit() {
    if (!form.symbol.trim() || !form.name.trim()) return;
    onAdd({ ...form, rateSymbol: form.rateSymbol.trim() || form.symbol.trim(), marketRate: parseFloat(form.marketRate) || 0 });
    setForm({ symbol: "", name: "", rateSymbol: "", isFiat: false, assetType: "Crypto", chain: "", category: "", marketRate: "" });
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-black mb-1">Coins</h1>
      <p className="text-sm text-slate-500 mb-5">
        The master list of assets Money Buddy prices and moves - separate from any wallet or holding. A wallet's balance is still tracked on its Chart of Accounts entry; this is just "what is this asset, and what's it worth."
      </p>

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
    </div>
  );
}

// ---------- Wallets (custody register) ----------

function WalletsScreen({ wallets, accounts, onAdd, onDelete }) {
  const eligibleAccounts = accounts.filter((a) => a.type === "Asset" && !a.isBank);
  const [form, setForm] = useState({ accountId: "", name: "", address: "", walletType: "Hot Wallet", venue: "", blockchain: "", complianceStatus: "Verified" });

  function submit() {
    if (!form.accountId) return;
    onAdd(form);
    setForm({ accountId: "", name: "", address: "", walletType: "Hot Wallet", venue: "", blockchain: "", complianceStatus: "Verified" });
  }

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">Wallets</h1>
      <p className="text-sm text-slate-500 mb-5">
        Custody locations - each wallet links to an existing Asset account in the Chart of Accounts, which stays the source of truth for its balance. This adds address, custody type, and compliance metadata on top, without creating a second parallel account.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-6 shadow-sm">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-3">Add wallet</div>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-slate-500 mb-1">Linked account</label>
            <select
              value={form.accountId}
              onChange={(e) => {
                const acc = eligibleAccounts.find((a) => a.id === e.target.value);
                setForm({ ...form, accountId: e.target.value, name: form.name || acc?.name || "" });
              }}
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="">- choose account -</option>
              {eligibleAccounts.filter((a) => !wallets.some((w) => w.accountId === a.id)).map((a) => (
                <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Wallet Type</label>
            <select value={form.walletType} onChange={(e) => setForm({ ...form, walletType: e.target.value })}
              className="border border-stone-300 rounded px-2 py-1.5 text-sm">
              {["Hot Wallet", "Cold Wallet", "Gas Wallet", "Exchange Spot", "Exchange Margin", "Exchange Futures", "DeFi Pool", "Earn / Staking", "Other"].map((t) => <option key={t}>{t}</option>)}
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
              {["Verified", "Pending Review", "Flagged"].map((t) => <option key={t}>{t}</option>)}
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
              return (
                <tr key={w.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 font-medium flex items-center gap-1.5">
                    <WalletIcon size={13} className="text-slate-400" /> {w.name}
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
                    <button onClick={() => onDelete(w.id)} className="text-slate-300 hover:text-[#B91C1C]">
                      <Trash2 size={14} />
                    </button>
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

function CryptoTransactions({ cryptoTxs, coins, wallets, accounts, cryptoLedger, cryptoRules, onAdd, onUpdate, onDelete, onBuildJournals, onLoadSample, onImportCsv, onPostOne, onRemember }) {
  const [showForm, setShowForm] = useState(false);
  const [subTab, setSubTab] = useState("transactions");
  const [sampleResult, setSampleResult] = useState(null);
  // Needs Review state - same shape as Categorize: a per-row chosen account,
  // a "remember this" flag, and a split editor (open + its rows) keyed by tx id.
  const [choice, setChoice] = useState({});
  const [remember, setRemember] = useState({});
  const [splitMode, setSplitMode] = useState({});
  const [splitRows, setSplitRows] = useState({});
  const [postError, setPostError] = useState({});

  const drafts = cryptoTxs.filter((t) => !t.posted).sort((a, b) => a.date.localeCompare(b.date));
  const posted = cryptoTxs.filter((t) => t.posted).sort((a, b) => b.date.localeCompare(a.date));

  // What would happen if we built journals right now - used to split Drafts
  // into "needs review" (missing a field, or otherwise doesn't resolve) vs
  // "ready to build" (fully specified, just waiting on Build Journals).
  const attempt = useMemo(() => computeCryptoLedger(cryptoTxs, wallets, accounts, coins), [cryptoTxs, wallets, accounts, coins]);
  const needsReview = drafts.filter((t) => !attempt.linesByTx.has(t.id));
  const readyDrafts = drafts.filter((t) => attempt.linesByTx.has(t.id));
  const buildableCount = readyDrafts.length;

  function coinSymbol(id) { return coins.find((c) => c.id === id)?.symbol || "-"; }
  function walletName(id) { return wallets.find((w) => w.id === id)?.name || "-"; }
  function accountLabel(id) { const a = accounts.find((x) => x.id === id); return a ? `${a.code} - ${a.name}` : "-"; }

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
    const result = onPostOne(t.id, { ledgerAccountId: accountId, ledgerSplits: null });
    if (!result.ok) { setPostError((prev) => ({ ...prev, [t.id]: result.reason })); return; }
    setPostError((prev) => ({ ...prev, [t.id]: undefined }));
    if (remember[t.id]) onRemember(t.type, t.coinId, accountId);
  }
  function postSplit(t, value) {
    const rows = (splitRows[t.id] || []).map((r) => ({ accountId: r.accountId, amount: Number(r.amount) || 0 }));
    if (rows.some((r) => !r.accountId || !(r.amount > 0))) return;
    if (Math.abs(rows.reduce((s, r) => s + r.amount, 0) - value) > 0.005) return;
    const result = onPostOne(t.id, { ledgerAccountId: null, ledgerSplits: rows });
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

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-black mb-1">Crypto Transactions</h1>
      <p className="text-sm text-slate-500 mb-5">
        Deposits, withdrawals, and transfers between wallets. Every transaction is saved as a draft first - <b>Build Journals</b> posts everything that resolves, oldest date first, into the real ledger via FIFO cost-basis matching. Trade isn't available yet: matching one coin sold to another bought, both drawing on cost-basis lots, is riskier to guess at than it's worth right now.
      </p>

      <div className="flex gap-1 mb-4 border-b border-stone-200">
        {[["transactions", "Transactions"], ["import", "Import"], ["layers", "Unused Cost Layers"]].map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${subTab === k ? "border-[#03D47C] text-[#02B169] font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {subTab === "import" && (
        <CryptoImportScreen wallets={wallets} onImport={onImportCsv} />
      )}

      {subTab === "transactions" && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <button onClick={() => setShowForm((s) => !s)}
              className="flex items-center gap-1.5 bg-black hover:bg-[#4D4D4D] text-white text-sm px-3 py-1.5 rounded-full">
              <Plus size={14} /> {showForm ? "Close" : "Add Transaction"}
            </button>
            <button onClick={onBuildJournals} disabled={buildableCount === 0}
              className="flex items-center gap-1.5 bg-[#F3F4F6] enabled:hover:bg-[#E5E7EB] disabled:opacity-40 text-black text-sm px-3 py-1.5 rounded-full">
              <ScrollText size={14} /> Build Journals {buildableCount > 0 && `(${buildableCount})`}
            </button>
            <button onClick={() => setSampleResult(onLoadSample())}
              className="flex items-center gap-1.5 bg-[#F3F4F6] hover:bg-[#E5E7EB] text-black text-sm px-3 py-1.5 rounded-full">
              <Sparkles size={14} /> Load sample data
            </button>
          </div>

          {sampleResult !== null && (
            <div className="text-sm bg-stone-50 border border-stone-200 rounded px-3 py-2 mb-4">
              Added <b>{sampleResult}</b> draft transaction{sampleResult === 1 ? "" : "s"} - two coins, all three types, some with fees. Hit <b>Build Journals</b> to post them.
            </div>
          )}

          {showForm && (
            <AddCryptoTxForm
              coins={coins} wallets={wallets} accounts={accounts} cryptoTxs={cryptoTxs}
              onCancel={() => setShowForm(false)}
              onSave={(tx) => { onAdd(tx); setShowForm(false); }}
            />
          )}

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Needs review ({needsReview.length})</div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
            {needsReview.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing to review - transactions with a remembered rule resolve automatically.</div>}
            {needsReview.map((t) => {
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
                <span className="flex-1 truncate">
                  {t.quantity} {coinSymbol(t.coinId)} - {t.type === "Transfer" && !needsToWallet ? `${walletName(t.walletId)} -> ${walletName(t.toWalletId)}` : walletName(t.walletId)}
                  {needsLedgerSide && t.ledgerAccountId && !isSplit && <span className="text-slate-400"> - {accountLabel(t.ledgerAccountId)}</span>}
                </span>
              );

              if (needsToWallet) {
                return (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
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
                );
              }

              if (needsLedgerSide && !isSplit) {
                return (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
                    <span className="text-xs uppercase tracking-wide bg-[#FFFBEB] text-[#B45309] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                    <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                    {summary}
                    <select
                      value={selected}
                      onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}
                      className={`border rounded px-2 py-1 text-xs w-48 shrink-0 ${selected ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                    >
                      <option value="">- choose account -</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
                      <input type="checkbox" checked={!!remember[t.id]} onChange={(e) => setRemember({ ...remember, [t.id]: e.target.checked })} />
                      remember
                    </label>
                    <button onClick={() => startSplit(t, selected, value)} title="Split across multiple accounts"
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 shrink-0">
                      <Layers size={13} />
                    </button>
                    <button onClick={() => post(t)} disabled={!selected}
                      className="bg-black enabled:hover:bg-[#4D4D4D] disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded-full shrink-0">Post</button>
                    <button onClick={() => onDelete(t.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0"><Trash2 size={13} /></button>
                    {rowError && <span className="w-full text-xs text-[#EF4444] pl-[7.5rem]">{rowError}</span>}
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
                        <select
                          value={r.accountId}
                          onChange={(e) => updateSplitRow(t.id, i, { accountId: e.target.value })}
                          className={`flex-1 border rounded px-2 py-1 text-xs ${r.accountId ? "border-stone-300" : "border-[#F59E0B]/60"}`}
                        >
                          <option value="">- choose account -</option>
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                        </select>
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

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Ready to build ({readyDrafts.length})</div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm mb-6 overflow-hidden">
            {readyDrafts.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing ready yet - resolve items in Needs review, or add a transaction above.</div>}
            {readyDrafts.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-stone-100 last:border-0 text-sm">
                <span className="text-xs uppercase tracking-wide bg-stone-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                <span className="flex-1 truncate">
                  {t.quantity} {coinSymbol(t.coinId)} - {t.type === "Transfer" ? `${walletName(t.walletId)} -> ${walletName(t.toWalletId)}` : walletName(t.walletId)}
                  {t.type !== "Transfer" && (
                    <span className="text-slate-400">
                      {" "}- {t.ledgerSplits?.length > 1 ? `${t.ledgerSplits.length} accounts (split)` : accountLabel(t.ledgerAccountId)}
                    </span>
                  )}
                </span>
                {t.matchedByRule && <span className="text-[10px] uppercase tracking-wide text-[#02B169] bg-[#E6FBF1] px-1.5 py-0.5 rounded shrink-0">rule</span>}
                <span className="flex items-center gap-1 text-xs text-[#02B169] shrink-0"><CheckCircle2 size={12} /> ready</span>
                <button onClick={() => onDelete(t.id)} className="text-slate-300 hover:text-[#B91C1C] shrink-0"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Posted ({posted.length})</div>
          <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
            {posted.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing posted yet - post a row above, or build journals in bulk.</div>}
            {posted.map((t) => {
              const legs = cryptoLedger.linesByTx.get(t.id) || [];
              const gainLeg = legs.find((l) => l.label.startsWith("Realized"));
              const isSplit = t.ledgerSplits && t.ledgerSplits.length > 1;
              return (
                <div key={t.id} className="flex items-center gap-3 px-3 py-2 border-b border-stone-100 last:border-0 text-sm">
                  <span className="text-xs uppercase tracking-wide bg-[#E6FBF1] text-[#02B169] px-1.5 py-0.5 rounded shrink-0 w-20 text-center">{t.type}</span>
                  <span className="text-slate-400 font-mono w-24 shrink-0">{t.date}</span>
                  <span className="flex-1 truncate text-slate-600">
                    {t.quantity} {coinSymbol(t.coinId)} - {t.type === "Transfer" ? `${walletName(t.walletId)} -> ${walletName(t.toWalletId)}` : walletName(t.walletId)}
                  </span>
                  {isSplit ? (
                    <span className="text-xs text-slate-500 w-40 truncate" title={t.ledgerSplits.map((s) => accountLabel(s.accountId)).join(", ")}>
                      {t.ledgerSplits.length} accounts (split)
                    </span>
                  ) : t.type !== "Transfer" ? (
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
              );
            })}
          </div>
        </>
      )}

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

function CryptoImportScreen({ wallets, onImport }) {
  const [walletId, setWalletId] = useState(wallets[0]?.id || "");
  const [csvText, setCsvText] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!walletId && wallets[0]) setWalletId(wallets[0].id);
  }, [wallets, walletId]);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ""));
    reader.readAsText(file);
  }

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-slate-500 mb-4">
        One wallet's export at a time - same idea as the fiat CSV import, just with columns for Type, Coin, Quantity, and Price instead of a free-text description. Duplicates (same date + type + coin + quantity + price) are skipped automatically. A row missing its Ledger Account (or a Transfer's destination wallet) still imports - it lands in Drafts needing that one field, fixable right there.
      </p>

      <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm">
        <label className="block text-xs text-slate-500 mb-1">Import into wallet</label>
        <select value={walletId} onChange={(e) => setWalletId(e.target.value)}
          className="border border-stone-300 rounded px-2 py-1.5 text-sm mb-4 w-72">
          {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>

        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder="Paste CSV here..."
          rows={8}
          className="w-full border border-stone-300 rounded px-3 py-2 text-sm font-mono mb-3"
        />

        <div className="flex items-center gap-2 mb-4">
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" id="crypto-csv-file" />
          <label htmlFor="crypto-csv-file" className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 cursor-pointer hover:bg-stone-50">
            <FileUp size={14} /> Upload CSV file
          </label>
          <button onClick={() => setCsvText(SAMPLE_CRYPTO_CSV)} className="flex items-center gap-1.5 text-sm border border-stone-300 rounded px-3 py-1.5 hover:bg-stone-50">
            <Sparkles size={14} /> Load sample data
          </button>
          <div className="flex-1" />
          <button
            onClick={() => { if (csvText.trim() && walletId) setResult(onImport(csvText, walletId)); }}
            className="bg-black hover:bg-[#4D4D4D] text-white text-sm px-4 py-1.5 rounded-full"
          >
            Import
          </button>
        </div>

        {result && (
          <div className="text-sm bg-stone-50 border border-stone-200 rounded px-3 py-2">
            Imported <b>{result.added}</b> transaction{result.added === 1 ? "" : "s"} as drafts.
            {result.dupes > 0 && <> Skipped <b>{result.dupes}</b> duplicate{result.dupes === 1 ? "" : "s"}.</>}
            {result.skipped > 0 && <> Couldn't read <b>{result.skipped}</b> row{result.skipped === 1 ? "" : "s"} (missing date/coin/quantity/price, or an unsupported type).</>}
            {" "}Check the <b>Transactions</b> tab - anything missing a Ledger Account or destination wallet needs a quick pick before Build Journals can post it.
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
          <input type="date" value={tx.date} onChange={(e) => setTx({ ...tx, date: e.target.value })}
            className="border border-stone-300 rounded px-2 py-1.5 text-sm" />
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
            <select value={tx.ledgerAccountId} onChange={(e) => setTx({ ...tx, ledgerAccountId: e.target.value })}
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm">
              <option value="">- choose account -</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
            </select>
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
