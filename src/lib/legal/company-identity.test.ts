// ---------------------------------------------------------------------------
// Company / merchant identity — legal entity and trading name.
//
// The load-bearing rule under test: Atlas AI OS is a TRADING NAME, not an
// incorporated company. The legal entity is AI DIALER (2024/699248/07). These
// tests fail if any code path can produce "Atlas AI OS (Pty) Ltd" or similar
// as the legal entity, because that would misstate the counterparty on
// contracts, invoices and payment-provider records.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  COMPANY_IDENTITY,
  COMPANY_REGISTRATION_NUMBER,
  ENTERPRISE_TYPE,
  FORBIDDEN_LEGAL_ENTITY_NAMES,
  LEGAL_ENTITY_NAME,
  LEGAL_PRESENTATION,
  OPERATOR_STATEMENT,
  PEACH_MERCHANT_IDENTITY,
  REGISTRATION_LINE,
  SETTLEMENT_ACCOUNT_HOLDER,
  STATEMENT_DESCRIPTOR,
  SUPPLIER_LEGAL_LINE,
  TRADING_NAME,
  isValidLegalEntityName,
  legalPresentationFor,
  peachMerchantConfig,
  supplierBlockFor,
} from "./company-identity";

describe("legal entity", () => {
  it("is AI DIALER, the CIPC-registered company", () => {
    expect(LEGAL_ENTITY_NAME).toBe("AI DIALER");
    expect(isValidLegalEntityName("AI DIALER")).toBe(true);
  });

  it("is accepted case-insensitively and with collapsed whitespace", () => {
    expect(isValidLegalEntityName("  ai   dialer ")).toBe(true);
    expect(isValidLegalEntityName("AI DIALER")).toBe(true);
  });

  it("rejects empty, blank and non-string values", () => {
    expect(isValidLegalEntityName("")).toBe(false);
    expect(isValidLegalEntityName("   ")).toBe(false);
    expect(isValidLegalEntityName(null)).toBe(false);
    expect(isValidLegalEntityName(undefined)).toBe(false);
    expect(isValidLegalEntityName(42)).toBe(false);
  });
});

describe("registration number", () => {
  it("is 2024/699248/07", () => {
    expect(COMPANY_REGISTRATION_NUMBER).toBe("2024/699248/07");
    expect(REGISTRATION_LINE).toBe("Registration No. 2024/699248/07");
  });

  it("appears in the supplier block for invoices", () => {
    const block = supplierBlockFor(LEGAL_ENTITY_NAME, TRADING_NAME);
    expect(block).toContain("2024/699248/07");
  });
});

describe("trading name", () => {
  it("is Atlas AI OS and is NOT itself a legal entity name", () => {
    expect(TRADING_NAME).toBe("Atlas AI OS");
    // The trading name alone must never validate as the legal entity.
    expect(isValidLegalEntityName(TRADING_NAME)).toBe(false);
  });
});

describe("combined presentation", () => {
  it("is AI DIALER t/a Atlas AI OS", () => {
    expect(LEGAL_PRESENTATION).toBe("AI DIALER t/a Atlas AI OS");
  });

  it("is produced from entity + trading name", () => {
    expect(legalPresentationFor("AI DIALER", "Atlas AI OS")).toBe(
      "AI DIALER t/a Atlas AI OS",
    );
  });

  it("refuses to build a presentation from an invalid legal entity", () => {
    expect(legalPresentationFor("Atlas AI OS (Pty) Ltd", TRADING_NAME)).toBeNull();
    expect(legalPresentationFor("", TRADING_NAME)).toBeNull();
  });
});

describe("invalid legal identities are never produced", () => {
  const inventedEntities = [
    "Atlas AI OS (Pty) Ltd",
    "Atlas AI OS (Pty)",
    "Atlas AI OS Pty Ltd",
    "Atlas AI OS Ltd",
    "Atlas AI OS LLC",
    "Atlas AI OS Inc",
    "atlas ai os pty ltd",
    "ATLAS AI OS (PTY) LTD",
  ];

  it.each(inventedEntities)("rejects %s as a legal entity", (name) => {
    expect(isValidLegalEntityName(name)).toBe(false);
  });

  it("covers the explicitly forbidden list", () => {
    for (const name of FORBIDDEN_LEGAL_ENTITY_NAMES) {
      expect(isValidLegalEntityName(name)).toBe(false);
    }
  });

  it("returns null rather than a misleading supplier block", () => {
    for (const name of inventedEntities) {
      expect(supplierBlockFor(name, TRADING_NAME)).toBeNull();
    }
  });
});

describe("supplier / invoice identity", () => {
  it("renders trading name, operator and registration number", () => {
    const block = supplierBlockFor(LEGAL_ENTITY_NAME, TRADING_NAME);
    expect(block).toBe(
      [
        "Atlas AI OS",
        "Operated by: AI DIALER",
        "Registration No. 2024/699248/07",
      ].join("\n"),
    );
  });

  it("states the operator as a South African private company", () => {
    expect(OPERATOR_STATEMENT).toBe(
      "Atlas AI OS is operated by AI DIALER, a South Africa private company, " +
        "registration number 2024/699248/07.",
    );
    expect(OPERATOR_STATEMENT).toContain(ENTERPRISE_TYPE.toLowerCase());
    // The invoice supplier field is a separate short-form line.
    expect(SUPPLIER_LEGAL_LINE).toBe("AI DIALER (South Africa)");
  });

  it("does not claim Atlas AI OS is independently incorporated", () => {
    for (const text of [OPERATOR_STATEMENT, LEGAL_PRESENTATION]) {
      expect(text).not.toMatch(/atlas\s+ai\s+os\s*\(pty\)/i);
      expect(text).not.toMatch(/atlas\s+ai\s+os\s+pty/i);
      expect(text).not.toMatch(/atlas\s+ai\s+os\s+ltd/i);
    }
  });
});

describe("settlement identity", () => {
  it("settles to the legal entity, never the trading name", () => {
    expect(SETTLEMENT_ACCOUNT_HOLDER).toBe("AI DIALER");
    expect(SETTLEMENT_ACCOUNT_HOLDER).not.toBe(TRADING_NAME);
  });

  it("carries no invented bank details", () => {
    expect(COMPANY_IDENTITY.settlementBankName).toBeNull();
  });
});

describe("enterprise facts", () => {
  it("records the CIPC certificate values", () => {
    expect(ENTERPRISE_TYPE).toBe("Private Company");
    expect(COMPANY_IDENTITY.registrationDate).toBe("2024-11-04");
    expect(COMPANY_IDENTITY.businessStartDate).toBe("2024-11-04");
    expect(COMPANY_IDENTITY.financialYearEnd).toBe("March");
    expect(COMPANY_IDENTITY.country).toBe("South Africa");
    expect(COMPANY_IDENTITY.countryCode).toBe("ZA");
    expect(COMPANY_IDENTITY.province).toBe("Western Cape");
    expect(COMPANY_IDENTITY.city).toBe("Cape Town");
  });

  it("is frozen so a consumer cannot mutate the single source of truth", () => {
    expect(Object.isFrozen(COMPANY_IDENTITY)).toBe(true);
    expect(Object.isFrozen(PEACH_MERCHANT_IDENTITY)).toBe(true);
  });
});

describe("statement descriptor", () => {
  it("is recognisably ATLAS AI OS on a customer charge", () => {
    expect(STATEMENT_DESCRIPTOR).toBe("ATLAS AI OS");
  });
});

describe("Peach merchant configuration", () => {
  it("populates legal entity and trading name separately", () => {
    expect(PEACH_MERCHANT_IDENTITY.legalEntityName).toBe("AI DIALER");
    expect(PEACH_MERCHANT_IDENTITY.tradingName).toBe("Atlas AI OS");
    expect(PEACH_MERCHANT_IDENTITY.companyRegistrationNumber).toBe("2024/699248/07");
    expect(PEACH_MERCHANT_IDENTITY.countryCode).toBe("ZA");
  });

  it("settles to AI DIALER", () => {
    expect(PEACH_MERCHANT_IDENTITY.settlementAccountHolder).toBe("AI DIALER");
  });

  it("falls back to canonical values with no env set", () => {
    expect(peachMerchantConfig()).toEqual(PEACH_MERCHANT_IDENTITY);
  });

  it("ignores blank overrides", () => {
    const config = peachMerchantConfig({ PEACH_TRADING_NAME: "   " });
    expect(config.tradingName).toBe(TRADING_NAME);
  });

  it("accepts non-secret env overrides", () => {
    const config = peachMerchantConfig({
      PEACH_COUNTRY_CODE: "ZA",
      PEACH_STATEMENT_DESCRIPTOR: "ATLAS AI OS",
    });
    expect(config.countryCode).toBe("ZA");
    expect(config.statementDescriptor).toBe("ATLAS AI OS");
  });

  it("refuses an override that would invent a separate company", () => {
    expect(() =>
      peachMerchantConfig({ PEACH_LEGAL_ENTITY_NAME: "Atlas AI OS (Pty) Ltd" }),
    ).toThrow(/Invalid merchant legal entity name/);
    expect(() => peachMerchantConfig({ PEACH_LEGAL_ENTITY_NAME: "Atlas AI OS" })).toThrow();
  });

  it("derives the combined presentation from whatever entity is configured", () => {
    const config = peachMerchantConfig({ PEACH_TRADING_NAME: "Atlas" });
    expect(config.combinedPresentation).toBe("AI DIALER t/a Atlas");
  });
});

describe("no tax number anywhere in this module", () => {
  // The SARS tax number is intentionally excluded from the repository — the
  // literal value is deliberately not written here either. This guards against
  // a tax field being reintroduced into the identity source of truth.
  it("does not define or reference a tax number", () => {
    expect("taxNumber" in COMPANY_IDENTITY).toBe(false);
    expect("sarsTaxNumber" in COMPANY_IDENTITY).toBe(false);
    expect("tax_number" in COMPANY_IDENTITY).toBe(false);
    const serialised = JSON.stringify(COMPANY_IDENTITY);
    expect(serialised.toLowerCase()).not.toContain("tax");
  });

  it("has no tax-related key at all", () => {
    const keys = Object.keys(COMPANY_IDENTITY);
    expect(keys.some((k) => /tax/i.test(k))).toBe(false);
  });
});
