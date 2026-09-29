// ---------------------------------------------------------------------------
// Merchant configuration — provider onboarding state.
//
// The load-bearing rule: Stripe is the live provider and Peach is SCAFFOLDING
// ONLY. Nothing here may imply Peach is processing payments, and no credential
// or tax number may be defined as a default.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { LEGAL_ENTITY_NAME, MERCHANT_PROVIDERS, TRADING_NAME } from "./company-identity";
import {
  LIVE_MERCHANT_PROVIDER,
  isLiveProvider,
  isOnboarded,
  merchantIdentityFor,
  merchantProfileSummary,
  merchantStatusFor,
} from "./merchant-config";

describe("provider onboarding state", () => {
  it("keeps Stripe as the live provider", () => {
    expect(LIVE_MERCHANT_PROVIDER).toBe(MERCHANT_PROVIDERS.STRIPE);
    expect(merchantStatusFor(MERCHANT_PROVIDERS.STRIPE)).toBe("live");
    expect(isLiveProvider(MERCHANT_PROVIDERS.STRIPE)).toBe(true);
    expect(isOnboarded(MERCHANT_PROVIDERS.STRIPE)).toBe(true);
  });

  it("treats Peach as scaffolding, not live", () => {
    expect(merchantStatusFor(MERCHANT_PROVIDERS.PEACH)).toBe("scaffolded");
    expect(isLiveProvider(MERCHANT_PROVIDERS.PEACH)).toBe(false);
    expect(isOnboarded(MERCHANT_PROVIDERS.PEACH)).toBe(false);
  });
});

describe("merchant identity shared across providers", () => {
  it("describes the same legal entity for either provider", () => {
    const stripe = merchantIdentityFor(MERCHANT_PROVIDERS.STRIPE);
    const peach = merchantIdentityFor(MERCHANT_PROVIDERS.PEACH);
    expect(peach).toEqual(stripe);
  });

  it("names AI DIALER as the entity and Atlas AI OS as the trading name", () => {
    const identity = merchantIdentityFor(MERCHANT_PROVIDERS.PEACH);
    expect(identity.legalEntityName).toBe(LEGAL_ENTITY_NAME);
    expect(identity.tradingName).toBe(TRADING_NAME);
    expect(identity.companyRegistrationNumber).toBe("2024/699248/07");
  });

  it("settles to the legal entity, not the trading name", () => {
    const identity = merchantIdentityFor(MERCHANT_PROVIDERS.PEACH);
    expect(identity.settlementAccountHolder).toBe(LEGAL_ENTITY_NAME);
    expect(identity.settlementAccountHolder).not.toBe(TRADING_NAME);
  });
});

describe("no credentials or bank details are invented", () => {
  it("has no settlement bank until the mandate exists", () => {
    const summary = merchantProfileSummary();
    expect(summary.settlementBankName).toBeNull();
  });

  it("defines no merchant id, client id, client secret or webhook secret", () => {
    const serialised = JSON.stringify(merchantProfileSummary());
    for (const forbidden of [
      "merchant_id",
      "merchantId",
      "client_id",
      "clientId",
      "client_secret",
      "clientSecret",
      "webhook_secret",
      "webhookSecret",
      "account_number",
      "branchCode",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("exposes no tax number", () => {
    // The literal tax number is deliberately absent from the repository, so
    // the assertion is on the field name rather than a value.
    const serialised = JSON.stringify(merchantProfileSummary());
    expect(serialised.toLowerCase()).not.toContain("tax");
    expect(Object.keys(merchantProfileSummary()).some((k) => /tax/i.test(k))).toBe(false);
  });
});

describe("onboarding summary", () => {
  it("reports the provider and its status", () => {
    const summary = merchantProfileSummary(MERCHANT_PROVIDERS.PEACH);
    expect(summary.provider).toBe(MERCHANT_PROVIDERS.PEACH);
    expect(summary.status).toBe("scaffolded");
    expect(summary.statementDescriptor).toBe("ATLAS AI OS");
  });
});
