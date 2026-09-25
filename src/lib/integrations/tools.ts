// ---------------------------------------------------------------------------
// Atlas Integration Platform — actions for the EXISTING tool registry (§15, §16)
//
// There is already one executable-capability registry (src/lib/atlas-data/
// tools-registry.ts) with one risk model, one confirmation model and one
// authorization path (agent runtime `executeTool` + `toolactions` +
// governance). Integrations do NOT get a second one.
//
// This module DERIVES ToolDefinition entries from an adapter's declared
// capabilities. The derivation is deliberately conservative:
//   * reads (get/search/list)                → READ,      confirmation never
//   * metadata writes + uploads              → LOW_WRITE, confirmation on_high_risk
//   * sending / creating externally visible  → HIGH_WRITE, confirmation always
//   * external submission (claim, estimate)  → IRREVERSIBLE, confirmation always
//
// A connector registers its derived tools when it is implemented; nothing here
// invents a tool for a provider that has no adapter, so the Actions surface can
// never advertise a capability that does not exist.
// ---------------------------------------------------------------------------

import type {
  ConfirmationPolicy,
  RiskLevel,
  ToolDefinition,
  ToolField,
} from "@/lib/atlas-data/tools-registry";
import { getAdapter, implementedCapabilities } from "./adapters";
import type { IntegrationCapability } from "./types";

/** The integration verbs a connector can expose, with their governance weight. */
export interface IntegrationActionSpec {
  /** Verb used in the tool id: `<provider>.<verb>`. */
  verb: string;
  name: string;
  description: string;
  /** Capability the provider must actually implement for this action. */
  capability: IntegrationCapability;
  riskLevel: RiskLevel;
  category: ToolDefinition["category"];
  fields: ToolField[];
  /** OAuth scopes the connected account must have granted. */
  requiredScopes?: string[];
  documentationUrl?: string;
}

/** Risk → confirmation policy. High-impact actions always confirm (§14). */
export function confirmationPolicyForRisk(risk: RiskLevel): ConfirmationPolicy {
  switch (risk) {
    case "READ":
      return "never";
    case "LOW_WRITE":
      return "on_high_risk";
    case "HIGH_WRITE":
    case "IRREVERSIBLE":
      return "always";
  }
}

/** Whether an action needs an approval record before it may run (§15). */
export function requiresApproval(risk: RiskLevel): boolean {
  return risk === "HIGH_WRITE" || risk === "IRREVERSIBLE";
}

/** Whether the action can be planned into an autonomous workflow at all. */
export function isAutonomouslyExecutable(risk: RiskLevel, confirmation: ConfirmationPolicy): boolean {
  if (confirmation === "always") return false;
  return risk === "READ" || risk === "LOW_WRITE";
}

/**
 * Build the ToolDefinition entries a provider can legitimately expose TODAY.
 *
 * Actions whose capability the adapter does not implement are omitted entirely
 * (not marked "planned"): the Actions UI must only offer what would work if
 * pressed. `planned` is reserved for a connector that registers a real action
 * whose handler is still being built.
 */
export function integrationToolDefinitions(
  provider: string,
  specs: IntegrationActionSpec[],
): ToolDefinition[] {
  const adapter = getAdapter(provider);
  const capabilities = implementedCapabilities(provider);

  return specs
    .filter((spec) => Boolean(adapter) && capabilities.includes(spec.capability))
    .map((spec) => ({
      id: `${provider}.${spec.verb}`,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      provider,
      version: "1.0.0",
      capabilities: [spec.capability],
      inputSchema: { fields: spec.fields },
      authRequirements: { provider, minRole: spec.riskLevel === "READ" ? "member" : "manager" },
      requiredScopes: spec.requiredScopes ?? [],
      riskLevel: spec.riskLevel,
      confirmationPolicy: confirmationPolicyForRisk(spec.riskLevel),
      implementationStatus: "implemented",
      documentationUrl: spec.documentationUrl,
    }));
}

/** Actions a connector COULD expose once its adapter implements the capability. */
export function plannedIntegrationActions(
  provider: string,
  specs: IntegrationActionSpec[],
): IntegrationActionSpec[] {
  const capabilities = implementedCapabilities(provider);
  return specs.filter((spec) => !capabilities.includes(spec.capability));
}

/**
 * A voice or worker command resolved onto an integration action.
 *
 *   Voice → intent → this descriptor → governance → adapter → provider
 *
 * The descriptor is what the router needs; it contains no credentials and no
 * provider-specific logic.
 */
export interface ResolvedIntegrationAction {
  provider: string;
  toolId: string;
  riskLevel: RiskLevel;
  confirmationPolicy: ConfirmationPolicy;
  requiresApproval: boolean;
  autonomouslyExecutable: boolean;
}

export function resolveIntegrationAction(
  provider: string,
  spec: IntegrationActionSpec,
): ResolvedIntegrationAction {
  const confirmation = confirmationPolicyForRisk(spec.riskLevel);
  return {
    provider,
    toolId: `${provider}.${spec.verb}`,
    riskLevel: spec.riskLevel,
    confirmationPolicy: confirmation,
    requiresApproval: requiresApproval(spec.riskLevel),
    autonomouslyExecutable: isAutonomouslyExecutable(spec.riskLevel, confirmation),
  };
}
