// ---------------------------------------------------------------------------
// Atlas AI OS — Payment provider merchant configuration (server-only)
//
// IMPORTANT — READ BEFORE USING
//
// Peach Payments is SCAFFOLDING ONLY. There is no Peach integration in this
// repository: no API client, no checkout session, no webhook, no settlement.
// Stripe remains the sole live paid provider
// (supabase/functions/stripe-checkout | stripe-webhook | stripe-customer-portal).
//
// This module exists so that the merchant identity Peach will need is already
// canonical and correct, and so nothing invents a second company for the
// product. It performs NO network calls and issues no payment requests.
//
// The canonical relationship, restated because it is the whole point:
//
//        AI DIALER                 <- legal entity, registration 2024/699248/07
//            │ trades as
//            ▼
//        Atlas AI OS                <- product / trading name
//
// Peach settlement structure (Phase 3), for when onboarding happens:
//
//        Peach Merchant → AI DIALER → AI DIALER business bank account
//
// The settlement account holder is the LEGAL ENTITY. No account number,
// branch code or banking credential is defined anywhere in this repository —
// those come from the operator's real bank mandate and Peach/Capitec setup.
//
// NO CREDENTIALS. Merchant ids, client ids, client secrets and webhook secrets
// are deliberately NOT modelled here and must never be added as defaults. They
// are secrets: read them server-side from the runtime secret store, and leave
// them unset until the operator actually has them.
// ---------------------------------------------------------------------------

import {
  ACTIVE_MERCHANT_PROVIDER,
  COMPANY_IDENTITY,
  MERCHANT_PROVIDERS,
  MERCHANT_STATUS,
  PEACH_MERCHANT_IDENTITY,
  peachMerchantConfig,
  type MerchantConfigOverrides,
  type MerchantProvider,
  type MerchantStatus,
  type PeachMerchantIdentity,
} from "./company-identity";

/**
 * Provider onboarding state.
 *
 * `stripe` is live. `peach` is scaffolded: identity on file, no merchant
 * account, no credentials, nothing processed. Do not report Peach as an
 * active provider until the operator supplies real credentials and the
 * integration actually exists.
 */
export function merchantStatusFor(provider: MerchantProvider): MerchantStatus {
  return provider === MERCHANT_PROVIDERS.STRIPE
    ? MERCHANT_STATUS.LIVE
    : MERCHANT_STATUS.SCAFFOLDED;
}

/** The provider actually processing live payments today. */
export const LIVE_MERCHANT_PROVIDER: MerchantProvider = ACTIVE_MERCHANT_PROVIDER;

/** True only for the live provider — guards UI that asserts "Peach is live". */
export function isLiveProvider(provider: MerchantProvider): boolean {
  return provider === LIVE_MERCHANT_PROVIDER;
}

/**
 * Non-secret merchant identity for provider onboarding.
 *
 * Read SERVER-SIDE. Every value here is public-safe (the SARS tax number is
 * not present at all), but keeping the surface server-side means a future
 * secret can join the same block without leaking into a client bundle.
 */
export function merchantIdentityFor(
  provider: MerchantProvider,
  env: MerchantConfigOverrides = {},
): PeachMerchantIdentity {
  // Both providers describe the same legal entity, so the identity shape is
  // shared; only the onboarding state differs.
  void provider;
  return peachMerchantConfig(env);
}

/** Whether the provider is onboarded and processing payments. */
export function isOnboarded(provider: MerchantProvider): boolean {
  return merchantStatusFor(provider) === MERCHANT_STATUS.LIVE;
}

/**
 * Summary of the operator identity, for admin/onboarding surfaces.
 *
 * Contains no tax number and no credentials.
 */
export function merchantProfileSummary(provider: MerchantProvider = LIVE_MERCHANT_PROVIDER) {
  return {
    provider,
    status: merchantStatusFor(provider),
    identity: merchantIdentityFor(provider),
    settlementAccountHolder: COMPANY_IDENTITY.settlementAccountHolder,
    settlementBankName: COMPANY_IDENTITY.settlementBankName,
    settlementCurrency: COMPANY_IDENTITY.settlementCurrency,
    statementDescriptor: PEACH_MERCHANT_IDENTITY.statementDescriptor,
  };
}
