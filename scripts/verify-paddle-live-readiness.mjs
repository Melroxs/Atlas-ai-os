#!/usr/bin/env node
/**
 * Atlas — Paddle live readiness check (READ-ONLY)
 *
 * Referenced from PADDLE_LIVE_MIGRATION.md. Run it against the *production*
 * Edge Function configuration before trusting live billing:
 *
 *   PADDLE_ENVIRONMENT=live PADDLE_API_KEY=... PADDLE_CLIENT_TOKEN=... \
 *   PADDLE_WEBHOOK_SECRET=... ATLAS_APP_URL=... \
 *   PADDLE_STARTER_PRICE_ID_MONTHLY=... (…all six…) \
 *   node scripts/verify-paddle-live-readiness.mjs
 *
 * It creates nothing, charges nothing and mutates nothing: every Paddle call is
 * a GET. Secret VALUES are never printed — only presence, prefix class and
 * whether the value is compatible with the configured environment. Price ids
 * are printed because they are catalog identifiers, not secrets.
 *
 * Flags:
 *   --no-network   skip the Paddle API checks (presence/format checks only)
 *
 * Exit code 0 = every check PASSed (or was explicitly reported as UNVERIFIED);
 * 1 = at least one FAIL.
 */

/**
 * The intended catalogue, in minor units (cents).
 *
 * These are the amounts the LIVE Paddle catalogue actually carries, read back
 * from the live account with this script (GET /prices/{id}) — $49 / $470,
 * $149 / $1430, $299 / $2870 — and they are what `src/pages/Pricing.tsx` and
 * `PLAN_METADATA` must keep showing. Paddle prices are immutable, so a real
 * price change means creating NEW prices and updating the six
 * PADDLE_*_PRICE_ID_* variables, never editing an amount here to match an
 * assumption.
 */
const CANONICAL_CATALOGUE = [
  {
    plan: "ATLAS_STARTER",
    monthly: { env: "PADDLE_STARTER_PRICE_ID_MONTHLY", amount: 4900 },
    annual: { env: "PADDLE_STARTER_PRICE_ID_ANNUAL", amount: 47000 },
  },
  {
    plan: "ATLAS_GROWTH",
    monthly: { env: "PADDLE_GROWTH_PRICE_ID_MONTHLY", amount: 14900 },
    annual: { env: "PADDLE_GROWTH_PRICE_ID_ANNUAL", amount: 143000 },
  },
  {
    plan: "ATLAS_SCALE",
    monthly: { env: "PADDLE_SCALE_PRICE_ID_MONTHLY", amount: 29900 },
    annual: { env: "PADDLE_SCALE_PRICE_ID_ANNUAL", amount: 287000 },
  },
];

const EXPECTED_INTERVAL = { monthly: "month", annual: "year" };

const args = new Set(process.argv.slice(2));
const networkEnabled = Boolean(process.env.PADDLE_API_KEY) && !args.has("--no-network");

let failures = 0;

function pass(label, detail = "") {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function unverified(label, detail = "") {
  console.log(`  UNVERIFIED  ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function cents(amount) {
  return `$${(amount / 100).toFixed(2)}`;
}

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * The only place a credential value is used. Building the header here (rather
 * than interpolating the key at each call site) keeps secret values out of
 * every string this script can print.
 */
function paddleHeaders(key) {
  return { Authorization: `Bearer ${key}`, Accept: "application/json" };
}

// ---------------------------------------------------------------------------
// 1. Paddle environment
// ---------------------------------------------------------------------------

section("1. Paddle environment");
const rawEnvironment = readEnv("PADDLE_ENVIRONMENT").toLowerCase();
let environment = null;
if (rawEnvironment === "live" || rawEnvironment === "production") {
  environment = "live";
  pass("PADDLE_ENVIRONMENT", `live (${rawEnvironment})`);
} else if (rawEnvironment === "sandbox") {
  environment = "sandbox";
  console.log(
    `  WARN  PADDLE_ENVIRONMENT=sandbox — this is a deliberate sandbox run, NOT a production readiness pass.`,
  );
} else {
  fail(
    "PADDLE_ENVIRONMENT",
    rawEnvironment
      ? `unsupported value (expected sandbox | live | production)`
      : "missing — Atlas now fails closed instead of defaulting to sandbox",
  );
}

// ---------------------------------------------------------------------------
// 2. App URL (post-payment destination)
// ---------------------------------------------------------------------------

section("2. Application URL");
const appUrl = readEnv("ATLAS_APP_URL");
if (!appUrl) {
  unverified(
    "ATLAS_APP_URL",
    "unset — the Edge Function falls back to its built-in production default",
  );
} else if (!/^https:\/\/[^/]+/i.test(appUrl)) {
  fail("ATLAS_APP_URL", "must be an absolute https origin");
} else {
  pass("ATLAS_APP_URL", `https origin set (${new URL(appUrl).origin})`);
}

// ---------------------------------------------------------------------------
// 3. Credentials — presence + environment compatibility (never values)
// ---------------------------------------------------------------------------

section("3. Credentials");
const apiKey = readEnv("PADDLE_API_KEY");
if (!apiKey) {
  fail("PADDLE_API_KEY", "missing");
} else if (apiKey.startsWith("pdl_live_apikey_")) {
  environment === "sandbox"
    ? fail("PADDLE_API_KEY", "live API key while PADDLE_ENVIRONMENT=sandbox")
    : pass("PADDLE_API_KEY", "present, live key");
} else if (apiKey.startsWith("pdl_sdbx_apikey_")) {
  environment === "live"
    ? fail("PADDLE_API_KEY", "sandbox API key while PADDLE_ENVIRONMENT=live")
    : pass("PADDLE_API_KEY", "present, sandbox key");
} else {
  unverified("PADDLE_API_KEY", "present, unrecognised prefix (not validated)");
}

const clientToken = readEnv("PADDLE_CLIENT_TOKEN");
if (!clientToken) {
  fail(
    "PADDLE_CLIENT_TOKEN",
    "missing — the Paddle.js overlay is disabled, so checkout needs a Paddle-hosted URL",
  );
} else {
  const isLiveToken = clientToken.startsWith("live_");
  const isTestToken = clientToken.startsWith("test_");
  if (environment === "live" && !isLiveToken) {
    fail("PADDLE_CLIENT_TOKEN", "not a live_ token while PADDLE_ENVIRONMENT=live");
  } else if (environment === "sandbox" && !isTestToken) {
    fail("PADDLE_CLIENT_TOKEN", "not a test_ token while PADDLE_ENVIRONMENT=sandbox");
  } else {
    pass(
      "PADDLE_CLIENT_TOKEN",
      isLiveToken ? "present, live_ token" : isTestToken ? "present, test_ token" : "present",
    );
  }
}

readEnv("PADDLE_WEBHOOK_SECRET")
  ? pass("PADDLE_WEBHOOK_SECRET", "present (value never printed)")
  : fail("PADDLE_WEBHOOK_SECRET", "missing — webhook signature verification would reject every event");

// ---------------------------------------------------------------------------
// 4. Six price ids
// ---------------------------------------------------------------------------

section("4. Price catalogue (six ids)");
const missingPriceIds = [];
for (const entry of CANONICAL_CATALOGUE) {
  for (const interval of ["monthly", "annual"]) {
    const spec = entry[interval];
    const value = readEnv(spec.env);
    if (!value) {
      missingPriceIds.push(spec.env);
      fail(
        spec.env,
        `missing — expected ${cents(spec.amount)} per ${EXPECTED_INTERVAL[interval]}`,
      );
    } else if (!value.startsWith("pri_")) {
      fail(spec.env, "does not look like a Paddle price id (must start with pri_)");
    } else {
      pass(spec.env, `${value} (expected ${cents(spec.amount)}/${EXPECTED_INTERVAL[interval]})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Paddle API verification (read-only GETs)
// ---------------------------------------------------------------------------

section("5. Paddle API verification");
if (!networkEnabled) {
  unverified(
    "Paddle API checks",
    args.has("--no-network") ? "skipped (--no-network)" : "skipped (PADDLE_API_KEY missing)",
  );
} else {
  const base = environment === "sandbox" ? "https://api.sandbox.paddle.com" : "https://api.paddle.com";
  const headers = paddleHeaders(apiKey);

  async function paddleGet(path) {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) {
      return { ok: false, status: response.status, data: null };
    }
    const json = await response.json();
    return { ok: true, status: response.status, data: json?.data ?? null };
  }

  for (const entry of CANONICAL_CATALOGUE) {
    for (const interval of ["monthly", "annual"]) {
      const spec = entry[interval];
      const priceId = readEnv(spec.env);
      if (!priceId || !priceId.startsWith("pri_")) continue;

      let result;
      try {
        result = await paddleGet(`/prices/${encodeURIComponent(priceId)}`);
      } catch (e) {
        unverified(spec.env, `network error (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`);
        continue;
      }

      if (!result.ok) {
        fail(
          spec.env,
          result.status === 404
            ? `${priceId} not found in the ${environment} catalogue`
            : `Paddle returned HTTP ${result.status}`,
        );
        continue;
      }

      const price = result.data ?? {};
      const problems = [];
      if (price.status !== "active") problems.push(`status=${price.status ?? "unknown"}`);
      const cycle = price.billing_cycle?.interval;
      if (cycle !== EXPECTED_INTERVAL[interval]) {
        problems.push(`billing interval=${cycle ?? "none"} (expected ${EXPECTED_INTERVAL[interval]})`);
      }
      if (!price.billing_cycle) problems.push("no recurring billing cycle");
      const amount = price.unit_price?.amount;
      if (String(amount) !== String(spec.amount)) {
        problems.push(`unit_price=${cents(Number(amount) || 0)} (expected ${cents(spec.amount)})`);
      }
      const currency = price.unit_price?.currency_code;
      if (currency && currency !== "USD") problems.push(`currency=${currency}`);

      problems.length
        ? fail(spec.env, `${priceId}: ${problems.join("; ")}`)
        : pass(spec.env, `${priceId}: active, recurring, priced correctly`);

      // Trial configuration is reported, never assumed: Paddle applies a trial
      // from the catalogue price, so whether Atlas may advertise one is a
      // property of the live catalogue, not of the checkout code.
      const trial = price.billing_cycle?.trial_period ?? null;
      if (trial) {
        const trialAmount = price.billing_cycle?.unit_price?.amount;
        console.log(
          `  INFO  ${priceId}: trial period ${trial.frequency} ${trial.interval}(s)` +
            (trialAmount === null || trialAmount === undefined
              ? " with no trial charge"
              : `, trial price ${cents(Number(trialAmount))}`),
        );
      }
    }
  }

  try {
    const destinations = await paddleGet("/notification-settings");
    if (!destinations.ok) {
      unverified(
        "Notification destinations",
        `Paddle returned HTTP ${destinations.status} (the API key may lack notification.read)`,
      );
    } else {
      const list = Array.isArray(destinations.data) ? destinations.data : [];
      if (list.length === 0) {
        fail("Notification destinations", "none configured — no webhook will ever arrive");
      } else {
        for (const destination of list) {
          const url = destination?.destination ?? "(no url)";
          const subscribed = Array.isArray(destination?.subscribed_events)
            ? destination.subscribed_events.length
            : 0;
          const isAtlasWebhook = typeof url === "string" && url.includes("/functions/v1/paddle-webhook");
          console.log(
            `  ${isAtlasWebhook ? "PASS" : "INFO"}  destination ${url} — ${destination?.active === false ? "INACTIVE" : "active"}, ${subscribed} subscribed event(s)${isAtlasWebhook ? "" : " (not the Atlas webhook endpoint)"}`,
          );
        }
      }
    }
  } catch (e) {
    unverified(
      "Notification destinations",
      `network error (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Summary
// ---------------------------------------------------------------------------

section("Summary");
if (missingPriceIds.length) {
  console.log(`  Missing price ids: ${missingPriceIds.join(", ")}`);
}
console.log(
  "  Not checked here (verify in the Supabase / Paddle dashboards):\n" +
    "    - deployed paddle-webhook revision and verify_jwt = false\n" +
    "    - deployed paddle-checkout revision and default JWT verification\n" +
    "    - Paddle approved domains and the default payment link\n" +
    "    - the webhook destination's signing secret matching PADDLE_WEBHOOK_SECRET",
);
if (failures > 0) {
  console.log(`\nFAILED — ${failures} check(s) did not pass. Paddle is NOT ready.`);
  process.exit(1);
}
console.log(
  `\nOK — no failures.${environment === "sandbox" ? " (sandbox run: not a production readiness pass)" : ""}`,
);
