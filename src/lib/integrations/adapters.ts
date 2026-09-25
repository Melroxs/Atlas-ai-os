// ---------------------------------------------------------------------------
// Atlas Integration Platform — adapter registry (§19)
//
// Adapters are registered explicitly and are validated against the provider's
// declared capabilities at registration time. That check is the thing that stops
// a provider being credited with a capability nobody implemented: if the registry
// says "webhook" and the adapter has no `verifyWebhook`, registration throws.
//
// Provider-specific behaviour lives here, inside the adapter — never as
// `if (provider === "gmail")` branches scattered through the application.
// ---------------------------------------------------------------------------

import {
  CONNECTOR_BY_ID,
  CONNECTOR_REGISTRY,
  type ConnectorDefinition,
} from "@/lib/atlas-data/connectors-registry";
import type {
  ConnectorLifecycle,
  IntegrationCapability,
  ProviderAdapter,
  ResolvedProvider,
} from "./types";

const registry = new Map<string, ProviderAdapter>();

/** Capabilities that REQUIRE a corresponding adapter method. */
const REQUIRED_IMPLEMENTATIONS: Array<{
  capability: IntegrationCapability;
  method: keyof ProviderAdapter;
  label: string;
}> = [
  { capability: "webhook", method: "verifyWebhook", label: "verifyWebhook" },
  { capability: "polling", method: "syncResource", label: "syncResource" },
  { capability: "oauth2" as IntegrationCapability, method: "buildAuthorizationUrl", label: "buildAuthorizationUrl" },
];

export class AdapterRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterRegistrationError";
  }
}

/**
 * Validate that an adapter actually implements everything its declared
 * capabilities promise. Throws — a half-built connector must not register.
 */
export function assertAdapterCapabilities(adapter: ProviderAdapter): void {
  for (const requirement of REQUIRED_IMPLEMENTATIONS) {
    if (!adapter.capabilities.includes(requirement.capability)) continue;
    if (typeof (adapter as unknown as Record<string, unknown>)[requirement.method] !== "function") {
      throw new AdapterRegistrationError(
        `adapter "${adapter.provider}" declares capability "${requirement.capability}" but does not implement ${requirement.label}()`,
      );
    }
  }
  if (adapter.capabilities.includes("webhook") && typeof adapter.normalizeWebhookEvent !== "function") {
    throw new AdapterRegistrationError(
      `adapter "${adapter.provider}" declares "webhook" but does not implement normalizeWebhookEvent()`,
    );
  }
}

export function registerAdapter(adapter: ProviderAdapter): void {
  if (!CONNECTOR_BY_ID[adapter.provider]) {
    throw new AdapterRegistrationError(
      `adapter "${adapter.provider}" has no registry entry — add it to connectors-registry.ts first`,
    );
  }
  assertAdapterCapabilities(adapter);
  registry.set(adapter.provider, adapter);
}

export function getAdapter(provider: string): ProviderAdapter | null {
  return registry.get(provider) ?? null;
}

export function hasAdapter(provider: string): boolean {
  return registry.has(provider);
}

/** Adapters that failed registration, reported honestly instead of silently. */
const registrationFailures = new Map<string, string>();

export function recordRegistrationFailure(provider: string, reason: string): void {
  registrationFailures.set(provider, reason);
}

export function listRegistrationFailures(): Array<{ provider: string; reason: string }> {
  return [...registrationFailures.entries()].map(([provider, reason]) => ({ provider, reason }));
}

/** Test/DI seam: clear the in-process registry. */
export function clearAdapters(): void {
  registry.clear();
  registrationFailures.clear();
}

/**
 * Lifecycle state for a provider — derived from evidence, never asserted.
 *
 *   * an adapter whose declared OAuth capability is wired AND which declares
 *     polling/webhook wiring counts as `connector_implemented`
 *   * an adapter with the contract present but no transport methods wired is
 *     `connector_scaffolded`
 *   * a registry entry with no adapter is `foundation_ready`
 *
 * `connector_tested` and `production_verified` are NEVER derived here: they are
 * set by a verified live run (see docs/INTEGRATION_PLATFORM.md §11).
 */
export function deriveLifecycle(def: ConnectorDefinition, adapter: ProviderAdapter | null): ConnectorLifecycle {
  if (!adapter) return "foundation_ready";
  const wired = [
    adapter.buildAuthorizationUrl,
    adapter.exchangeAuthorizationCode,
    adapter.refreshCredentials,
    adapter.syncResource,
    adapter.verifyWebhook,
  ].filter((fn) => typeof fn === "function").length;
  if (wired === 0) return "connector_scaffolded";
  if (def.authType === "oauth2") {
    const oauthWired =
      typeof adapter.buildAuthorizationUrl === "function" &&
      typeof adapter.exchangeAuthorizationCode === "function";
    if (!oauthWired) return "connector_scaffolded";
  }
  return "connector_implemented";
}

export function describeProvider(provider: string): ResolvedProvider | null {
  const def = CONNECTOR_BY_ID[provider];
  if (!def) return null;
  const adapter = getAdapter(provider);
  return { provider, lifecycle: deriveLifecycle(def, adapter), adapter };
}

export function listResolvedProviders(): ResolvedProvider[] {
  return CONNECTOR_REGISTRY.map((def) => ({
    provider: def.id,
    lifecycle: deriveLifecycle(def, getAdapter(def.id)),
    adapter: getAdapter(def.id),
  }));
}

/** Capability intersection: what Atlas can ACTUALLY do for this provider today. */
export function implementedCapabilities(provider: string): IntegrationCapability[] {
  return (getAdapter(provider)?.capabilities ?? []).slice().sort();
}

/** Refuse an operation the provider has no implementation for. */
export function requireCapability(provider: string, capability: IntegrationCapability): void {
  const adapter = getAdapter(provider);
  if (!adapter) {
    throw new Error(`${provider} is not connected to Atlas yet (no adapter registered)`);
  }
  if (!adapter.capabilities.includes(capability)) {
    throw new Error(`${provider} does not support ${capability} in Atlas`);
  }
}
