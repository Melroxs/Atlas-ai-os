// ---------------------------------------------------------------------------
// Atlas AI OS — Authoritative Company / Merchant Identity
//
// Atlas AI OS is NOT a separate legal company. It is the trading name under
// which an existing South African private company operates the product:
//
//        AI DIALER
//        Registration No. 2024/699248/07
//                │
//                │ trades as
//                ▼
//        Atlas AI OS
//
// This module is the single source of truth for that relationship. Legal pages,
// footers, invoices, payment-provider onboarding and merchant configuration all
// read from here rather than restating the values, so the entity can never drift
// between surfaces.
//
// SCOPE / SENSITIVITY
//   - The SARS tax number is deliberately NOT present in this file, nor
//     anywhere else in the repository. It is held in the operator's private
//     records and the payment provider's onboarding system only. It must not be
//     added to source, client bundles, logs, analytics or public responses.
//   - Payment credentials (merchant ids, client secrets, webhook secrets,
//     settlement account details) are NEVER defined here. They are secrets and
//     belong in the runtime secret store, read server-side only.
//     See `peachMerchantConfig` for the env-driven, credential-free layer.
// ---------------------------------------------------------------------------

/** CIPC-registered legal entity name. Never the trading name. */
export const LEGAL_ENTITY_NAME = "AI DIALER";

/** CIPC company registration number. */
export const COMPANY_REGISTRATION_NUMBER = "2024/699248/07";

/** Brand the legal entity trades under. */
export const TRADING_NAME = "Atlas AI OS";

/** Combined legal presentation, for surfaces with a single field. */
export const LEGAL_PRESENTATION = "AI DIALER t/a Atlas AI OS";

/** South African private company, per the CIPC COR14.3 certificate. */
export const ENTERPRISE_TYPE = "Private Company";
export const ENTERPRISE_STATUS = "In Business";

/** CIPC registration and business start are the same day. ISO-8601. */
export const REGISTRATION_DATE = "2024-11-04";
export const BUSINESS_START_DATE = "2024-11-04";

/** Financial year end — month only, as CIPC records it. */
export const FINANCIAL_YEAR_END_MONTH = "March";

/** Jurisdiction. South Africa / Western Cape / Cape Town. */
export const COUNTRY = "South Africa";
export const COUNTRY_CODE = "ZA";
export const PROVINCE = "Western Cape";
export const CITY = "Cape Town";

/** Settlement currency for the merchant relationship. */
export const SETTLEMENT_CURRENCY = "USD";

/**
 * Settlement account holder — MUST be the legal entity, never the trading name.
 *
 * Atlas AI OS holds no bank account of its own; revenue settles to the
 * AI DIALER business account. No account number, branch code or banking
 * credential is defined here: those are secrets and come from the operator's
 * actual bank mandate once it exists.
 */
export const SETTLEMENT_ACCOUNT_HOLDER = LEGAL_ENTITY_NAME;

/** Settlement bank, once the mandate exists. `null` until then — never a guess. */
export const SETTLEMENT_BANK_NAME: string | null = null;

// ---------------------------------------------------------------------------
// Payment providers
// ---------------------------------------------------------------------------

/** Payment providers Atlas may be onboarded with. */
export const MERCHANT_PROVIDERS = {
  STRIPE: "stripe",
  PEACH: "peach",
} as const;

export type MerchantProvider = (typeof MERCHANT_PROVIDERS)[keyof typeof MERCHANT_PROVIDERS];

/**
 * Provider that actually processes live payments today.
 *
 * Stripe is the sole live paid provider. Peach is scaffolding only: identity
 * and configuration shape exist, but no Peach API calls, credentials or
 * settlement are active. Do not treat Peach as live without a merchant id and
 * verified credentials — see `peachMerchantConfig`.
 */
export const ACTIVE_MERCHANT_PROVIDER: MerchantProvider = MERCHANT_PROVIDERS.STRIPE;

/** Onboarding state per provider. */
export const MERCHANT_STATUS = {
  LIVE: "live",
  SCAFFOLDED: "scaffolded",
  NOT_ONBOARDED: "not_onboarded",
} as const;

export type MerchantStatus = (typeof MERCHANT_STATUS)[keyof typeof MERCHANT_STATUS];

// ---------------------------------------------------------------------------
// Derived strings
// ---------------------------------------------------------------------------

/** Customer-facing operator line, e.g. under a Terms or invoice header. */
export const OPERATOR_STATEMENT = `Atlas AI OS is operated by ${LEGAL_ENTITY_NAME}, a ${COUNTRY} ${ENTERPRISE_TYPE.toLowerCase()}, registration number ${COMPANY_REGISTRATION_NUMBER}.`;

/** Short legal line for an invoice / receipt supplier block. */
export const SUPPLIER_LEGAL_LINE = `${LEGAL_ENTITY_NAME} (${COUNTRY})`;

/** Registration line, e.g. "Registration No. 2024/699248/07". */
export const REGISTRATION_LINE = `Registration No. ${COMPANY_REGISTRATION_NUMBER}`;

/** Statement-descriptor candidate customers should recognise on a charge. */
export const STATEMENT_DESCRIPTOR = "ATLAS AI OS";

/**
 * The full immutable merchant profile.
 *
 * Deliberately excludes the SARS tax number and every credential. Consumers
 * that need to serialise this should treat the result as public-safe.
 */
export interface CompanyIdentity {
  readonly legalEntityName: string;
  readonly tradingName: string;
  readonly legalPresentation: string;
  readonly companyRegistrationNumber: string;
  readonly enterpriseType: string;
  readonly enterpriseStatus: string;
  readonly registrationDate: string;
  readonly businessStartDate: string;
  readonly financialYearEnd: string;
  readonly country: string;
  readonly countryCode: string;
  readonly province: string;
  readonly city: string;
  readonly currency: string;
  readonly settlementAccountHolder: string;
  readonly settlementBankName: string | null;
  readonly settlementCurrency: string;
}

export const COMPANY_IDENTITY: CompanyIdentity = Object.freeze({
  legalEntityName: LEGAL_ENTITY_NAME,
  tradingName: TRADING_NAME,
  legalPresentation: LEGAL_PRESENTATION,
  companyRegistrationNumber: COMPANY_REGISTRATION_NUMBER,
  enterpriseType: ENTERPRISE_TYPE,
  enterpriseStatus: ENTERPRISE_STATUS,
  registrationDate: REGISTRATION_DATE,
  businessStartDate: BUSINESS_START_DATE,
  financialYearEnd: FINANCIAL_YEAR_END_MONTH,
  country: COUNTRY,
  countryCode: COUNTRY_CODE,
  province: PROVINCE,
  city: CITY,
  currency: SETTLEMENT_CURRENCY,
  settlementAccountHolder: SETTLEMENT_ACCOUNT_HOLDER,
  settlementBankName: SETTLEMENT_BANK_NAME,
  settlementCurrency: SETTLEMENT_CURRENCY,
});

// ---------------------------------------------------------------------------
// Validation — guards the "Atlas AI OS is not a company" rule
// ---------------------------------------------------------------------------

/**
 * Legal-entity names Atlas must never produce.
 *
 * "Atlas AI OS" is a trading name, not an incorporated company. A separate
 * "Atlas AI OS (Pty) Ltd" exists only if the owner registers one through CIPC;
 * until then, emitting one would misstate the legal counterparty on contracts,
 * invoices and payment-provider records.
 */
export const FORBIDDEN_LEGAL_ENTITY_NAMES: readonly string[] = Object.freeze([
  "Atlas AI OS (Pty) Ltd",
  "Atlas AI OS (Pty)",
  "Atlas AI OS Pty Ltd",
  "Atlas AI OS Ltd",
  "Atlas AI OS LLC",
  "Atlas AI OS Inc",
]);

const normalise = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Whether `value` is an acceptable legal-entity name for Atlas.
 *
 * Rejects any spelling that would present the trading name as an incorporated
 * company. The trading name is only ever valid in a combined presentation such
 * as "AI DIALER t/a Atlas AI OS", never on its own as the legal entity.
 */
export function isValidLegalEntityName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = normalise(value);
  if (candidate.length === 0) return false;

  if (FORBIDDEN_LEGAL_ENTITY_NAMES.some((f) => normalise(f) === candidate)) return false;
  // Broader guard: any legal suffix directly appended to the trading name.
  if (
    candidate.startsWith(normalise(TRADING_NAME)) &&
    /(\bpty\b|\bltd\b|\bllc\b|\binc\b|\bcorp\b|\bna\b)/.test(candidate)
  ) {
    return false;
  }
  return candidate === normalise(LEGAL_ENTITY_NAME);
}

/**
 * Build the combined presentation from an entity + trading name, refusing to
 * produce a form that would imply a separate company.
 */
export function legalPresentationFor(
  legalEntityName: string,
  tradingName: string,
): string | null {
  if (!isValidLegalEntityName(legalEntityName)) return null;
  const trading = normalise(tradingName);
  if (trading.length === 0) return null;
  return `${legalEntityName.trim()} t/a ${tradingName.trim()}`;
}

/**
 * Build the invoice/receipt supplier block for a legal + trading name pair.
 *
 * Returns `null` rather than a misleading string if the legal name is invalid.
 */
export function supplierBlockFor(
  legalEntityName: string,
  tradingName: string,
): string | null {
  if (!isValidLegalEntityName(legalEntityName)) return null;
  const lines = [
    tradingName.trim(),
    `Operated by: ${legalEntityName.trim()}`,
    REGISTRATION_LINE,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Peach merchant configuration (identity only — no credentials)
// ---------------------------------------------------------------------------

/** Non-secret merchant identity, as submitted to a payment provider. */
export interface PeachMerchantIdentity {
  readonly legalEntityName: string;
  readonly tradingName: string;
  readonly combinedPresentation: string;
  readonly companyRegistrationNumber: string;
  readonly country: string;
  readonly countryCode: string;
  readonly settlementAccountHolder: string;
  readonly settlementCurrency: string;
  readonly statementDescriptor: string;
}

/**
 * The merchant identity Peach should show for Atlas AI OS.
 *
 * Legal entity and trading name are populated SEPARATELY, which is what Peach
 * requires; `combinedPresentation` is only for a single-field surface.
 */
export const PEACH_MERCHANT_IDENTITY: PeachMerchantIdentity = Object.freeze({
  legalEntityName: LEGAL_ENTITY_NAME,
  tradingName: TRADING_NAME,
  combinedPresentation: LEGAL_PRESENTATION,
  companyRegistrationNumber: COMPANY_REGISTRATION_NUMBER,
  country: COUNTRY,
  countryCode: COUNTRY_CODE,
  settlementAccountHolder: SETTLEMENT_ACCOUNT_HOLDER,
  settlementCurrency: SETTLEMENT_CURRENCY,
  statementDescriptor: STATEMENT_DESCRIPTOR,
});

/**
 * Env-driven overrides for the non-secret merchant configuration.
 *
 * Read SERVER-SIDE ONLY. There is deliberately no client-side reader: these
 * values are safe to expose, but keeping the surface server-only means a
 * future secret can be added to the same block without leaking it.
 *
 * Credentials (merchant id, client id, client secret, webhook secret and
 * settlement account) are NOT modelled here. They must come from the operator's
 * real Peach/Capitec setup via the runtime secret store — never a default.
 */
export interface MerchantConfigOverrides {
  readonly PEACH_LEGAL_ENTITY_NAME?: string;
  readonly PEACH_TRADING_NAME?: string;
  readonly PEACH_COMPANY_REGISTRATION_NUMBER?: string;
  readonly PEACH_COUNTRY?: string;
  readonly PEACH_COUNTRY_CODE?: string;
  readonly PEACH_SETTLEMENT_ACCOUNT_HOLDER?: string;
  readonly PEACH_SETTLEMENT_CURRENCY?: string;
  readonly PEACH_STATEMENT_DESCRIPTOR?: string;
}

const readOverride = (
  env: MerchantConfigOverrides,
  key: keyof MerchantConfigOverrides,
): string | null => {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Resolve the merchant identity, allowing env overrides for the non-secret
 * fields while keeping the canonical defaults.
 *
 * An override that would change the LEGAL ENTITY to a trading-name-plus-suffix
 * form is rejected outright: configuration cannot be used to accidentally
 * represent Atlas AI OS as its own company.
 */
export function peachMerchantConfig(
  env: MerchantConfigOverrides = {},
): PeachMerchantIdentity {
  const legalEntityName =
    readOverride(env, "PEACH_LEGAL_ENTITY_NAME") ?? PEACH_MERCHANT_IDENTITY.legalEntityName;
  const tradingName =
    readOverride(env, "PEACH_TRADING_NAME") ?? PEACH_MERCHANT_IDENTITY.tradingName;

  if (!isValidLegalEntityName(legalEntityName)) {
    throw new Error(
      "Invalid merchant legal entity name. The legal entity is the registered " +
        "company; the product is its trading name. Configure " +
        "PEACH_LEGAL_ENTITY_NAME to the CIPC-registered entity name.",
    );
  }

  return Object.freeze({
    legalEntityName: legalEntityName.trim(),
    tradingName: tradingName.trim(),
    combinedPresentation: `${legalEntityName.trim()} t/a ${tradingName.trim()}`,
    companyRegistrationNumber:
      readOverride(env, "PEACH_COMPANY_REGISTRATION_NUMBER") ??
      PEACH_MERCHANT_IDENTITY.companyRegistrationNumber,
    country: readOverride(env, "PEACH_COUNTRY") ?? PEACH_MERCHANT_IDENTITY.country,
    countryCode:
      readOverride(env, "PEACH_COUNTRY_CODE") ?? PEACH_MERCHANT_IDENTITY.countryCode,
    settlementAccountHolder:
      readOverride(env, "PEACH_SETTLEMENT_ACCOUNT_HOLDER") ??
      PEACH_MERCHANT_IDENTITY.settlementAccountHolder,
    settlementCurrency:
      readOverride(env, "PEACH_SETTLEMENT_CURRENCY") ??
      PEACH_MERCHANT_IDENTITY.settlementCurrency,
    statementDescriptor:
      readOverride(env, "PEACH_STATEMENT_DESCRIPTOR") ??
      PEACH_MERCHANT_IDENTITY.statementDescriptor,
  });
}
