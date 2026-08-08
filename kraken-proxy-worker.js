// Kraken read-only proxy — Cloudflare Worker for Primmy's Ledger.
//
// Holds your Kraken API secret, signs each private request, and returns the
// JSON to the app. The app never sees the secret, and the browser talks only to
// this Worker (CORS-enabled), not to Kraken directly.
//
// SET THESE AS WORKER SECRETS (Dashboard → your Worker → Settings → Variables,
// or `wrangler secret put NAME`):
//   KRAKEN_KEY     Kraken API key   (create it READ-ONLY: "Query Ledger Entries"
//                                    + "Query Trades" only — no trade/withdraw)
//   KRAKEN_SECRET  Kraken private key (the long base64 string)
//   PROXY_TOKEN    a random string you invent; the app must send it, so this
//                  isn't an open relay (e.g. generate with `openssl rand -hex 24`)
//   ALLOW_ORIGIN   your app origin, e.g. https://primmmp.github.io

// Only read-only endpoints are allowed through — never trading or withdrawals.
const ALLOWED = new Set(["TradesHistory", "Ledgers", "Balance", "TradeBalance", "OpenOrders", "ClosedOrders", "QueryTrades", "QueryLedgers"]);

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    // Shared-token gate: only your app (which knows PROXY_TOKEN) can use this.
    if (!env.PROXY_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.PROXY_TOKEN}`) {
      return json({ error: "unauthorized" }, 401, cors);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
    const method = body.method;
    // Safe diagnostic: reports whether the secrets are present and whether the
    // secret is valid base64 - lengths only, never the values themselves.
    if (method === "_diag") {
      const k = env.KRAKEN_KEY || "", s = env.KRAKEN_SECRET || "";
      let secretDecodes = false, secretDecodedLen = 0;
      try { secretDecodedLen = base64ToBytes(s).length; secretDecodes = true; } catch {}
      return json({
        keyPresent: !!k, keyLen: k.length,
        secretPresent: !!s, secretLen: s.length, secretTrimmedLen: s.replace(/\s+/g, "").length,
        secretDecodes, secretDecodedLen,
        allowOrigin: env.ALLOW_ORIGIN || null, proxyTokenSet: !!env.PROXY_TOKEN,
      }, 200, cors);
    }
    if (!ALLOWED.has(method)) return json({ error: `endpoint '${method}' not allowed` }, 403, cors);

    const path = "/0/private/" + method;
    const nonce = Date.now().toString();
    const post = new URLSearchParams({ nonce, ...(body.params || {}) }).toString();

    let kres;
    try {
      const signature = await sign(path, nonce, post, env.KRAKEN_SECRET);
      kres = await fetch("https://api.kraken.com" + path, {
        method: "POST",
        headers: {
          "API-Key": env.KRAKEN_KEY,
          "API-Sign": signature,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: post,
      });
    } catch (e) {
      return json({ error: "kraken request failed: " + e.message }, 502, cors);
    }
    return json(await kres.json(), 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Kraken API-Sign = base64( HMAC-SHA512( path + SHA256(nonce + post), base64decode(secret) ) )
async function sign(path, nonce, post, secretB64) {
  const enc = new TextEncoder();
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(nonce + post)));
  const pathBytes = enc.encode(path);
  const message = new Uint8Array(pathBytes.length + sha256.length);
  message.set(pathBytes, 0); message.set(sha256, pathBytes.length);
  const keyBytes = base64ToBytes(secretB64);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return bytesToBase64(sig);
}
function base64ToBytes(b64) {
  // Tolerate stray whitespace/newlines and base64url so a copy-paste quirk in
  // the secret can't break signing.
  let clean = String(b64 || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  clean += "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(clean);
  const r = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) r[i] = bin.charCodeAt(i);
  return r;
}
function bytesToBase64(bytes) { let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin); }
