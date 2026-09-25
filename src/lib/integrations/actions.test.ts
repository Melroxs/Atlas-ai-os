import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistrationError,
  assertAdapterCapabilities,
  clearAdapters,
  deriveLifecycle,
  describeProvider,
  getAdapter,
  implementedCapabilities,
  listResolvedProviders,
  registerAdapter,
  requireCapability,
} from "./adapters";
import {
  confirmationPolicyForRisk,
  integrationToolDefinitions,
  isAutonomouslyExecutable,
  plannedIntegrationActions,
  requiresApproval,
  resolveIntegrationAction,
  type IntegrationActionSpec,
} from "./tools";
import { CONNECTOR_BY_ID, CONNECTOR_REGISTRY } from "@/lib/atlas-data/connectors-registry";
import type { ProviderAdapter } from "./types";

const SPECS: IntegrationActionSpec[] = [
  {
    verb: "search_jobs",
    name: "Search jobs",
    description: "Search the connected account for jobs.",
    capability: "read",
    riskLevel: "READ",
    category: "search",
    fields: [{ key: "query", type: "string", required: true, description: "Search text" }],
  },
  {
    verb: "create_task",
    name: "Create task",
    description: "Create a task in the connected account.",
    capability: "write",
    riskLevel: "HIGH_WRITE",
    category: "write",
    fields: [{ key: "title", type: "string", required: true, description: "Task title" }],
  },
];

function fakeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return { provider: "jobnimbus", capabilities: ["read"], ...overrides };
}

afterEach(() => clearAdapters());

describe("adapter registry", () => {
  it("refuses an adapter whose provider has no registry entry", () => {
    expect(() => registerAdapter(fakeAdapter({ provider: "not_a_provider" }))).toThrow(
      AdapterRegistrationError,
    );
  });

  it("refuses an adapter that claims a capability it does not implement", () => {
    expect(() => registerAdapter(fakeAdapter({ capabilities: ["read", "webhook"] }))).toThrow(
      /does not implement verifyWebhook/,
    );
    expect(() => registerAdapter(fakeAdapter({ capabilities: ["polling"] }))).toThrow(
      /does not implement syncResource/,
    );
    expect(() =>
      registerAdapter(fakeAdapter({ capabilities: ["oauth2" as "read"] })),
    ).toThrow(/buildAuthorizationUrl/);
  });

  it("accepts an adapter that implements what it declares", () => {
    registerAdapter(
      fakeAdapter({
        capabilities: ["read", "polling"],
        syncResource: async () => ({ records: [], nextCursor: null, hasMore: false }),
      }),
    );
    expect(getAdapter("jobnimbus")).not.toBeNull();
    expect(implementedCapabilities("jobnimbus")).toEqual(["polling", "read"]);
  });

  it("gates an operation on the capability the provider actually implements", () => {
    registerAdapter(fakeAdapter({ capabilities: ["read"] }));
    expect(() => requireCapability("jobnimbus", "read")).not.toThrow();
    expect(() => requireCapability("jobnimbus", "write")).toThrow(/does not support write/);
    expect(() => requireCapability("gmail" as "jobnimbus", "read")).toThrow(
      /not connected to Atlas yet/,
    );
  });
});

describe("lifecycle derivation is evidence-based", () => {
  it("reports a registry entry with no adapter as foundation ready", () => {
    const def = CONNECTOR_BY_ID.google_gmail;
    expect(deriveLifecycle(def, null)).toBe("foundation_ready");
  });

  it("reports a contract-only adapter as scaffolded", () => {
    expect(deriveLifecycle(CONNECTOR_BY_ID.jobnimbus, fakeAdapter())).toBe("connector_scaffolded");
  });

  it("reports an OAuth provider as scaffolded until both OAuth halves exist", () => {
    const half = fakeAdapter({
      capabilities: ["read"],
      buildAuthorizationUrl: () => "https://provider/authorize",
    });
    expect(deriveLifecycle(CONNECTOR_BY_ID.companycam, half)).toBe("connector_scaffolded");
    const full = fakeAdapter({
      capabilities: ["read"],
      buildAuthorizationUrl: () => "https://provider/authorize",
      exchangeAuthorizationCode: async () => ({
        accessTokenSealed: "sealed",
        refreshTokenSealed: null,
        tokenExpiresAt: null,
        keyVersion: 1,
        scopes: [],
      }),
    });
    expect(deriveLifecycle(CONNECTOR_BY_ID.companycam, full)).toBe("connector_implemented");
  });

  it("never claims a connector is tested or production verified from code alone", () => {
    registerAdapter(
      fakeAdapter({
        capabilities: ["read", "polling"],
        syncResource: async () => ({ records: [], nextCursor: null, hasMore: false }),
      }),
    );
    const resolved = describeProvider("jobnimbus");
    expect(resolved?.lifecycle).toBe("connector_implemented");
    expect(listResolvedProviders().every((p) => p.lifecycle !== "production_verified")).toBe(true);
    expect(listResolvedProviders().every((p) => p.lifecycle !== "connector_tested")).toBe(true);
  });

  it("reports every planned provider from the single registry", () => {
    const planned = CONNECTOR_REGISTRY.filter((c) => c.implementationStatus === "planned").map((c) => c.id);
    for (const id of ["whatsapp", "jobnimbus", "xactimate", "companycam", "eagleview", "hover", "acculynx"]) {
      expect(planned).toContain(id);
      expect(CONNECTOR_BY_ID[id].docsUrl).toBeTruthy();
    }
    // The audit correction: Drive has no client in this repo, so it is not
    // reported as implemented.
    expect(CONNECTOR_BY_ID.google_drive.implementationStatus).toBe("planned");
  });

  it("exposes no integration provider as connected without an adapter", () => {
    for (const provider of listResolvedProviders()) {
      if (!provider.adapter) expect(provider.lifecycle).toBe("foundation_ready");
    }
  });
});

describe("governance mapping for integration actions", () => {
  it("maps risk onto confirmation policy and approval requirement", () => {
    expect(confirmationPolicyForRisk("READ")).toBe("never");
    expect(confirmationPolicyForRisk("LOW_WRITE")).toBe("on_high_risk");
    expect(confirmationPolicyForRisk("HIGH_WRITE")).toBe("always");
    expect(confirmationPolicyForRisk("IRREVERSIBLE")).toBe("always");
    expect(requiresApproval("READ")).toBe(false);
    expect(requiresApproval("LOW_WRITE")).toBe(false);
    expect(requiresApproval("HIGH_WRITE")).toBe(true);
    expect(requiresApproval("IRREVERSIBLE")).toBe(true);
  });

  it("never lets a high-impact action run autonomously", () => {
    expect(isAutonomouslyExecutable("READ", "never")).toBe(true);
    expect(isAutonomouslyExecutable("LOW_WRITE", "on_high_risk")).toBe(true);
    expect(isAutonomouslyExecutable("HIGH_WRITE", "always")).toBe(false);
    expect(isAutonomouslyExecutable("IRREVERSIBLE", "always")).toBe(false);
  });

  it("resolves a voice/worker command onto a governed action descriptor", () => {
    const descriptor = resolveIntegrationAction("jobnimbus", SPECS[1]);
    expect(descriptor).toMatchObject({
      toolId: "jobnimbus.create_task",
      riskLevel: "HIGH_WRITE",
      confirmationPolicy: "always",
      requiresApproval: true,
      autonomouslyExecutable: false,
    });
  });

  it("only emits tool definitions for capabilities the adapter implements", () => {
    registerAdapter(fakeAdapter({ capabilities: ["read"] }));
    const tools = integrationToolDefinitions("jobnimbus", SPECS);
    expect(tools.map((t) => t.id)).toEqual(["jobnimbus.search_jobs"]);
    expect(tools[0]).toMatchObject({
      provider: "jobnimbus",
      riskLevel: "READ",
      confirmationPolicy: "never",
      authRequirements: { provider: "jobnimbus", minRole: "member" },
    });
    // The write action is NOT advertised while it is unimplemented.
    expect(plannedIntegrationActions("jobnimbus", SPECS).map((s) => s.verb)).toEqual(["create_task"]);
  });

  it("emits nothing for a provider with no adapter (no phantom actions)", () => {
    expect(integrationToolDefinitions("jobnimbus", SPECS)).toEqual([]);
  });

  it("requires manager role for write actions", () => {
    registerAdapter(fakeAdapter({ capabilities: ["read", "write"] }));
    const write = integrationToolDefinitions("jobnimbus", SPECS).find(
      (t) => t.id === "jobnimbus.create_task",
    )!;
    expect(write.authRequirements.minRole).toBe("manager");
  });
});
