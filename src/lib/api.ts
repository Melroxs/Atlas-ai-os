// ---------------------------------------------------------------------------
// Atlas function registry — the single contract between the frontend and the
// Supabase backend.
//
// Every entry maps to one of:
//   query    — Postgres RPC (read), returns jsonb
//   mutation — Postgres RPC (write), returns jsonb
//   edge     — Supabase Edge Function (external API / heavy compute)
//   client   — pure client-side implementation (deterministic, no backend)
//
// RPC names are `snake_case` functions defined in supabase/migrations/.
// Edge functions live in supabase/functions/<name>/index.ts.
//
// TResult is the shape the page consumes. RPC results are jsonb, so the
// shapes below are the typed contract (the old Convex codegen equivalent).
// ---------------------------------------------------------------------------

import {
  buildRecoveryAnalytics,
  defaultClaimCounts,
  enrichClaimFromEvidence,
  normalizeClaimListResponse,
  normalizeClaimPackageResponse,
  type ClaimSnapshot,
  type EvidenceDocLike,
} from "@/lib/insurance/logic";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import { normalizeArchiveDetailResponse } from "@/lib/archive/normalize";
import {
  normalizeAuthorityMonitorResponse,
  normalizeAuthoritativeKnowledgeResponse,
  normalizeImpactAssessments,
  normalizeKnowledgeChanges,
  normalizeOrganizationContextResponse,
  type NormalizedOrgContextShape,
} from "@/lib/everest/normalize";
import {
  analyzeRecoveryClient,
  buildBusinessBrain,
  buildIndustryCoverage,
  buildIndustryExcellence,
  buildInsuranceIntelligence,
  buildValueIntelligence,
} from "@/lib/everest/client";

export type FnKind = "query" | "mutation" | "edge" | "client";

/**
 * True when a conversation-converse failure means the conversational engine
 * is unreachable, so the converse client should degrade to local retrieval
 * over real evidence instead of surfacing a hard error.
 *
 * Guards the exact defects seen in production:
 *   - supabase-js FunctionsFetchError on a CORS-blocked fetch:
 *     "Failed to send a request to the Edge Function"
 *   - a 404 preflight / "Response to preflight request does not have HTTP ok
 *     status" when the function was never deployed
 *   - generic fetch/load failures (offline, DNS, gateway)
 *
 * GENUINE business errors from a reachable function ("Unauthorized",
 * "Conversation failed: …", tenant-setup messages) are NOT "unreachable" and
 * are propagated so the user sees the real reason.
 */
export function isConverseEngineUnreachable(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    msg.includes("404") ||
    lower.includes("not found") ||
    lower.includes("failed to fetch") ||
    lower.includes("failed to send a request to the edge function") ||
    lower.includes("function was not found") ||
    lower.includes("load failed") ||
    lower.includes("preflight") ||
    lower.includes("no access-control-allow-origin")
  );
}

/** Loose jsonb object. */
export type Obj = Record<string, any>;
/** Loose jsonb array of objects. */
export type ObjArray = Obj[];

export interface ApiFn<TResult = any> {
  name: string;
  kind: FnKind;
  clientImpl?: (args?: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Post-processes the RPC result into the shape the page consumes. */
  transform?: (data: unknown) => unknown;
}

/**
 * Priority used when sorting claim evidence for enrichment: financial and
 * estimating documents (estimate/xactimate/invoice/payment) are the ones the
 * amount analyzers can actually read, so they are fetched first and never
 * dropped by the detail-fetch cap. Scope/policy/supporting docs follow.
 */
function evidencePriority(classification?: string | null): number {
  const c = (classification ?? "").toLowerCase();
  if (/(estimate|xactimate|invoice|financial|ledger|payment)/.test(c)) return 5;
  if (/scope/.test(c)) return 4;
  if (/policy/.test(c)) return 3;
  if (/(photo|image)/.test(c)) return 2;
  if (/(report|communication|correspondence|supplement|regulatory|claim)/.test(c)) return 1;
  return 0;
}

export interface TenantDocRow {
  _id: string;
  title?: string | null;
  sourceId?: string | null;
  summary?: string | null;
  classification?: string | null;
}

/**
 * List the tenant's documents for claim grounding.
 *
 * The documents_list_documents RPC caps its result at the 80 most recent
 * rows, which hides claim evidence that was ingested earlier (a real archive
 * can easily exceed that). Reading the tenant's own documents through the
 * authenticated REST client (RLS-scoped) removes the cap; the RPC remains as
 * a fallback if the direct read is ever unavailable.
 */
async function listTenantDocsForClaim(
  supabase: SupabaseClient,
): Promise<TenantDocRow[]> {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("_id, title, sourceId, summary, classification")
      .limit(1000);
    if (!error && Array.isArray(data) && data.length > 0) {
      return data as TenantDocRow[];
    }
  } catch {
    // fall through to the RPC below
  }
  return ((await rpcCall(supabase, "documents_list_documents")) ?? []) as TenantDocRow[];
}

function def<TResult = any>(
  name: string,
  kind: FnKind,
  clientImpl?: ApiFn<TResult>["clientImpl"],
): ApiFn<TResult> {
  return { name, kind, clientImpl } as ApiFn<TResult>;
}

function defT<TResult = any>(
  name: string,
  kind: FnKind,
  transform: ApiFn<TResult>["transform"],
  clientImpl?: ApiFn<TResult>["clientImpl"],
): ApiFn<TResult> {
  return { name, kind, transform, clientImpl } as ApiFn<TResult>;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** profiles row (users_current_user). */
export interface UserRow {
  _id: string;
  _creationTime?: number;
  name?: string | null;
  image?: string | null;
  email?: string | null;
  emailVerificationTime?: number | null;
  isAnonymous?: boolean;
  role?: string | null;
  account_status?: string | null;
  platform_role?: string | null;
  [k: string]: any;
}

/** tenants_get_my_workspace. */
export interface WorkspaceShape {
  tenant: Obj | null;
  profile: Obj | null;
  membership: Obj | null;
  systems: ObjArray;
  packs: ObjArray;
  members: ObjArray;
  invites: ObjArray;
  [k: string]: any;
}

/** A knowledge/claim document. */
export interface DocShape extends Obj {
  _id: string;
  _creationTime?: number;
  title?: string;
  fileName?: string;
  status?: string;
  [k: string]: any;
}

/** connections_list_catalog entry — mirrors the page's local CatalogEntry. */
export interface CatalogEntryShape extends Obj {
  id: string;
  name: string;
  category: string;
  authType: "oauth2" | "api_key" | "none";
  capabilities: string[];
  requiredEnvVars: string[];
  oauthScopes: string[];
  configured: boolean;
  missingEnvVars: string[];
  displayStatus: string;
  setupInstructions: string;
  docsUrl: string | null;
  connection: any;
}

/** insurance_recovery_analytics item shapes. */
export interface RecoveryTrendPointShape extends Obj {
  month: string;
  label: string;
  claimsCreated: number;
  findingsOpened: number;
  supplementsSubmitted: number;
}

export interface CarrierRecoveryRowShape extends Obj {
  carrier: string;
  claimCount: number;
  outstanding: number;
  potential: number;
}

export interface LifecycleStageShape extends Obj {
  status: string;
  label: string;
  count: number;
}

/** insurance_get_claim_package. */
export interface ClaimPackageShape extends Obj {
  claim: Obj;
  supplements: ObjArray;
  findings: Array<Obj & { evidence: string[] }>;
  evidenceDocs: ObjArray;
  completeness: Obj & {
    score: number;
    complete: number;
    total: number;
    categories: Array<Obj & { key: string; label: string; note: string }>;
  };
  reconciliation: Obj & {
    outstanding: number;
    notes: string[];
  };
  timeline: ObjArray;
  packageModel: Obj & {
    fields: Array<Obj & { key: string; label: string; value?: string }>;
  };
}

/** insurance_get_supplement_document. */
export interface SupplementDocumentShape extends Obj {
  status?: string;
  requestedAmount?: number;
  disclaimer: string;
  sections: Array<{ title: string; body: string[] }>;
}

/** archive_get_detail. */
export interface ArchiveDetailShape extends Obj {
  archive: Obj & {
    warnings: string[];
    stats: Obj;
    status: string;
  };
  files: ObjArray;
  docs: Obj;
  candidates: ObjArray;
}

/** Tool schema — mirrors the page's local ToolRow (tools_list). */
export interface ToolFieldShape {
  key: string;
  type: "string" | "number" | "boolean" | "enum";
  required?: boolean;
  description: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  longText?: boolean;
  [k: string]: any;
}

export interface ToolRowShape extends Obj {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string | null;
  version: string;
  capabilities: string[];
  riskLevel: string;
  riskLabel: string;
  confirmationRequired: boolean;
  policyReason: string;
  implementationStatus: string;
  minRole: string;
  inputFields: ToolFieldShape[];
  requiredScopes: string[];
  documentationUrl: string | null;
  enabled: boolean;
  connected: boolean;
  scopesOk: boolean;
  canRun: boolean;
}

/** everest_list_authoritative_knowledge. */
export interface AuthoritativeKnowledgeShape extends Obj {
  jurisdiction: Obj;
  tiers: Obj;
  sources: ObjArray;
  knowledge: ObjArray;
}

/** everest_authority_monitor. */
export interface AuthorityMonitorShape extends Obj {
  now: number;
  sources: Array<
    Obj & {
      recentChecks: ObjArray;
      sourceId: string;
      name: string;
    }
  >;
}

/** everest_get_organization_context. */
export interface OrganizationContextShape extends Obj {
  context: Obj | null;
  organization: Obj;
  locations: ObjArray;
  user: Obj | null;
  timezoneNote?: string | null;
}

/** everest_get_industry_coverage. */
export interface IndustryCoverageShape extends Obj {
  coverage: Array<
    Obj & {
      name: string;
      overall: string;
      note: string;
      axes: ObjArray;
    }
  >;
}

/** everest_get_industry_excellence. */
export interface IndustryExcellenceShape extends Obj {
  excellence: ObjArray;
}

/** everest_get_value_intelligence. */
export interface ValueIntelligenceShape extends Obj {
  engine:
    | (Obj & {
        detectionSignals: string[];
        evidenceRequirements: string[];
        recommendedActions: string[];
        limitations: string[];
        affectedEntities: string[];
        calculationMethod: string;
        measurableOutcome: string;
      })
    | null;
  opportunities: ObjArray;
}

/** everest_get_insurance_intelligence. */
export interface EverestInsuranceShape extends Obj {
  lifecycle: Array<{ stage: string; description: string }>;
  evidenceCategories: Array<{
    key: string;
    name: string;
    description: string;
    examples: string[];
  }>;
  baseline: Obj & {
    entities: ObjArray;
    knowledgeKinds: Obj & {
      domain: string[];
      organization: string[];
      evidence: string[];
    };
  };
}

/** everest_business_brain (client-built from static atlas data). */
export interface BusinessBrainShape extends Obj {
  businessTypes: ObjArray;
  financialKnowledge: Obj & {
    revenue: ObjArray;
    expenses: ObjArray;
    profitability: ObjArray;
    incomeStatementFlow: ObjArray;
    accountingIdentity: Obj;
  };
  orgRoles: ObjArray;
  businessObjects: ObjArray;
  lifecycles: Array<Obj & { stages: string[] }>;
  maturity: ObjArray;
  orgStructures: ObjArray;
  businessFunctions: ObjArray;
  disambiguation?: Obj;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pilot Intelligence types
// ---------------------------------------------------------------------------

export interface PilotCompanyRow {
  id: string;
  tenant_id: string;
  name: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  website?: string | null;
  company_type?: string | null;
  company_size?: string | null;
  claims_volume?: string | null;
  status?: string;
  notes?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface PilotSessionRow {
  id: string;
  tenant_id: string;
  company_id?: string | null;
  session_type: string;
  title?: string | null;
  summary?: string | null;
  notes?: string | null;
  attendee?: string | null;
  scheduled_at?: string | null;
  duration_min?: number | null;
  outcome?: string | null;
  created_at: string;
}

export interface PilotInsightRow {
  id: string;
  tenant_id: string;
  company_id?: string | null;
  session_id?: string | null;
  insight_type: string;
  title: string;
  description?: string | null;
  priority?: string;
  status?: string;
  source?: string | null;
  tags?: string[];
  created_at: string;
  updated_at?: string;
}

export interface PilotOutcomeRow {
  id: string;
  tenant_id: string;
  company_id?: string | null;
  outcome_type: string;
  title: string;
  description?: string | null;
  financial_impact?: number | null;
  claim_id?: string | null;
  recommendation_id?: string | null;
  evidence_count?: number;
  status?: string;
  created_at: string;
}

export interface PilotTestimonialRow {
  id: string;
  tenant_id: string;
  company_id?: string | null;
  quote: string;
  author_name?: string | null;
  author_role?: string | null;
  is_public?: boolean;
  created_at: string;
}

export interface PilotAnalyticsShape {
  totalCompanies: number;
  activeCompanies: number;
  totalSessions: number;
  totalInsights: number;
  openInsights: number;
  totalOutcomes: number;
  totalRevenueRecovery: number;
  totalTestimonials: number;
  insightsByType: Array<{ type: string; count: number }>;
  insightsByPriority: Array<{ priority: string; count: number }>;
  companiesByStatus: Array<{ status: string; count: number }>;
  recentActivity: Obj[];
}


export const api = {
  users: {
    currentUser: def<UserRow | null>("users_current_user", "query"),
  },
  authStatus: {
    authStatus: def<{ supabaseConfigured: boolean; guestConfigured: boolean; authUsable: boolean }>(
      "auth_status",
      "query",
    ),
  },
  tenants: {
    getMyWorkspace: def<WorkspaceShape | null>("tenants_get_my_workspace", "query"),
    createTenant: def<{ tenantId: string }>("tenants_create_tenant", "mutation"),
    initForCheckout: def<{ tenantId: string; alreadyExisted: boolean }>("tenants_init_for_checkout", "mutation"),
    activateAfterPayment: def<{ ok: boolean; tenantId: string }>("tenants_activate_after_payment", "mutation"),
    handlePaymentFailure: def<{ ok: boolean; tenantId: string }>("tenants_handle_payment_failure", "mutation"),
    handleSubscriptionCancelled: def<{ ok: boolean; tenantId: string }>("tenants_handle_subscription_cancelled", "mutation"),
    inviteMember: def<Obj>("tenants_invite_member", "mutation"),
    claimInvites: def<{ claimed: number }>("tenants_claim_invites", "mutation"),
    updateMemberRole: def<{ ok: boolean }>("tenants_update_member_role", "mutation"),
    removeMember: def<{ ok: boolean }>("tenants_remove_member", "mutation"),
  },
  onboarding: {
    updateCompanyProfile: def<{ ok: boolean }>("onboarding_update_company_profile", "mutation"),
    saveCompanySystem: def<{ ok: boolean }>("onboarding_save_company_system", "mutation"),
    completeOnboarding: def<{ ok: boolean }>("onboarding_complete_onboarding", "mutation"),
  },
  intelligence: {
    seedIntelligence: def<{ seeded: number }>(
      "intelligence_seed_packs",
      "client",
      async () => {
        const [{ PACK_SEEDS }, { getSupabaseClient }] = await Promise.all([
          import("@/lib/atlas-data/packs"),
          import("@/lib/supabase"),
        ]);
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        const { data, error } = await supabase.rpc("intelligence_seed_packs", {
          p_packs: PACK_SEEDS,
        });
        if (error) throw error;
        return data as { seeded: number };
      },
    ),
    listWorkspacePacks: def<ObjArray>("intelligence_list_workspace_packs", "query"),
    listPackItems: def<ObjArray>("intelligence_list_pack_items", "query"),
    setPackActivation: def<{ activatedPacks: Obj }>("intelligence_set_pack_activation", "mutation"),
  },
  documents: {
    listDocuments: def<DocShape[]>("documents_list_documents", "query"),
    documentStats: def<Obj>("documents_document_stats", "query"),
    getDocument: def<DocShape | null>("documents_get_document", "query"),
    getDocumentDetail: def<{
      doc: DocShape;
      chunks: ObjArray;
      entities: ObjArray;
      assertions: ObjArray;
    } | null>("documents_get_document_detail", "query"),
    deleteDocument: def<{ ok: boolean }>("documents_delete_document", "mutation"),
  },
  ingestion: {
    processDocument: def<{ ok: boolean; docId?: string; warnings?: string[] }>(
      "ingestion_process_document",
      "client",
      async (args) => {
        const { processDocumentClient } = await import("@/lib/actions/ingestion");
        const a = (args ?? {}) as Record<string, unknown>;
        const result = await processDocumentClient({
          storagePath: String(a.storageId ?? a.storagePath ?? ""),
          title: String(a.title ?? "Untitled document"),
          mimeType: String(a.mimeType ?? "application/octet-stream"),
          size: Number(a.size ?? 0),
          sourceType: String(a.sourceType ?? "upload"),
        });
        return { ok: true, docId: result.docId };
      },
    ),
    reprocessDocument: def<{ ok: boolean }>(
      "ingestion_reprocess_document",
      "client",
      async (args) => {
        const { processDocumentClient } = await import("@/lib/actions/ingestion");
        const a = (args ?? {}) as Record<string, unknown>;
        await processDocumentClient({
          storagePath: String(a.storageId ?? a.storagePath ?? ""),
          title: String(a.title ?? "Untitled document"),
          mimeType: String(a.mimeType ?? "application/octet-stream"),
          size: Number(a.size ?? 0),
          sourceType: String(a.sourceType ?? "upload"),
        });
        return { ok: true };
      },
    ),
  },
  knowledge: {
    listEntities: def<ObjArray>("knowledge_list_entities", "query"),
    entityStats: def<Obj & { typeCounts: Record<string, number> }>(
      "knowledge_entity_stats",
      "query",
    ),
    getEntity: def<{
      entity: Obj;
      relationships: ObjArray;
      assertions: ObjArray;
    } | null>("knowledge_get_entity", "query"),
    listAssertions: def<ObjArray>("knowledge_list_assertions", "query"),
    graphSnapshot: def<{
      nodes: Array<{ id: string; type: string }>;
      edges: Array<{ source: string; target: string }>;
    }>("knowledge_graph_snapshot", "query"),
    confirmEntity: def<{ ok: boolean }>("knowledge_confirm_entity", "mutation"),
  },
  recommendations: {
    listRecommendations: def<Array<Obj & { evidence: ObjArray }>>(
      "recommendations_list",
      "query",
    ),
    recommendationCounts: def<Obj>("recommendations_counts", "query"),
    runDetectors: def<Obj>(
      "recommendations_run_detectors",
      "client",
      async () => {
        const { runDetectorsClient } = await import("@/lib/actions/detectors");
        return runDetectorsClient();
      },
    ),
    approveRecommendation: def<{ ok: boolean }>("recommendations_decide", "mutation"),
    rejectRecommendation: def<{ ok: boolean }>("recommendations_decide", "mutation"),
    dismissRecommendation: def<{ ok: boolean }>("recommendations_decide", "mutation"),
    markExecuted: def<{ ok: boolean }>("recommendations_decide", "mutation"),
  },
  history: {
    listAskSessions: def<ObjArray>("history_list_ask_sessions", "query"),
    recentActivity: def<ObjArray>("history_recent_activity", "query"),
  },
  audit: {
    listAuditLogs: defT<ObjArray>("audit_list_logs", "query", (d) =>
      Array.isArray(d) ? d : [],
    ),
  },
  archive: {
    listArchives: def<ObjArray>("archive_list", "query"),
    archiveStats: def<Obj>("archive_stats", "query"),
    // The RPC returns jsonb where optional collections can be missing or
    // null (archive.warnings, files, docs, candidates, stats). Normalize at
    // this boundary so ArchiveDetail and the client processing loop always
    // receive arrays/objects — never undefined (the production crash:
    // "Cannot read properties of undefined (reading 'length')" after an
    // archive finished ingesting and the page rendered).
    getArchiveDetail: defT<ArchiveDetailShape | null>(
      "archive_get_detail",
      "query",
      (d) => normalizeArchiveDetailResponse(d) as ArchiveDetailShape | null,
    ),
    beginArchive: def<{ archiveId: string }>("archive_begin", "mutation"),
    submitInventoryBatch: def<{ ok: boolean }>("archive_submit_inventory_batch", "mutation"),
    beginProcessing: def<{ ok: boolean; ingested: number; failed: number; candidates: number }>(
      "archive_begin_processing",
      "client",
      async (args) => {
        const { beginProcessingClient } = await import("@/lib/actions/archive");
        return beginProcessingClient({
          archiveId: String((args ?? {}).archiveId ?? ""),
        });
      },
    ),
    cancelArchive: def<{ ok: boolean }>("archive_cancel", "mutation"),
    retryFiles: def<{ ok: boolean; requeued: number }>(
      "archive_retry_files",
      "client",
      async (args) => {
        const { retryFilesClient } = await import("@/lib/actions/archive");
        return retryFilesClient({
          archiveId: String((args ?? {}).archiveId ?? ""),
          fileIds: ((args ?? {}).fileIds as string[]) ?? [],
        });
      },
    ),
    deleteArchive: def<{ ok: boolean }>("archive_delete", "mutation"),
  },
  events: {
    listEvents: defT<ObjArray>("events_list", "query", (d) =>
      Array.isArray(d) ? d : [],
    ),
    getEventDetail: def<Obj | null>("events_get_detail", "query"),
    eventStats: defT<Obj>("events_stats", "query", (d) =>
      d && typeof d === "object"
        ? d
        : {
            total: 0,
            byStatus: {},
            byType: {},
            duplicates: 0,
            actionsTriggered: 0,
            retried: 0,
            avgProcessingMs: null,
            sourceMechanisms: [],
          },
    ),
    // The deployed backend exposes events_raw_policies (tenant policy state).
    // The page contract is the static registry merged with that state, so
    // this is a client impl: it merges at the boundary and NEVER crashes the
    // Events page when the RPC is missing, slow or empty (the production
    // defect was a 404 for the old name `events_list_policies` turning into
    // a null array the page `.map()`ed).
    listEventPolicies: def<ObjArray>("events_list_policies", "client", async () => {
      const [{ EVENT_REGISTRY, mergeEventPolicies }, { getSupabaseClient }, { rpcCall }] =
        await Promise.all([
          import("@/lib/atlas-data/events-registry"),
          import("@/lib/supabase"),
          import("@/lib/actions/rpc"),
        ]);
      const supabase = getSupabaseClient();
      if (!supabase) throw new Error("Supabase is not configured.");
      let raw: unknown = [];
      try {
        raw = await rpcCall(supabase, "events_raw_policies");
      } catch (e) {
        // The page must stay usable even when the backend RPC is unavailable:
        // fall back to the registry with default (enabled) policy state.
        console.error(
          "[atlas] events_raw_policies unavailable — showing registry defaults:",
          e instanceof Error ? e.message : String(e),
        );
        raw = [];
      }
      return mergeEventPolicies(
        EVENT_REGISTRY,
        raw as Array<Record<string, unknown>> | null,
      );
    }),
    listNotifications: defT<ObjArray>("events_list_notifications", "query", (d) =>
      d && typeof d === "object" ? d : { items: [], unreadCount: 0 },
    ),
    retryEvent: def<Obj>("events_retry", "mutation"),
    setEventPolicy: def<{ ok: boolean }>("events_set_policy", "mutation"),
    markNotificationRead: def<{ ok: boolean }>("events_mark_notification_read", "mutation"),
  },
  workflows: {
    listWorkflowDefinitions: def<ObjArray>("workflows_list_definitions", "query"),
    getWorkflowDetail: def<Obj | null>("workflows_get_detail", "query"),
    listWorkflowInstances: def<ObjArray>("workflows_list_instances", "query"),
    getWorkflowInstanceDetail: def<Obj | null>("workflows_get_instance_detail", "query"),
    listWorkflowApprovals: def<ObjArray>("workflows_list_approvals", "query"),
    workflowStats: def<Obj>("workflows_stats", "query"),
    setWorkflowSetting: def<{ ok: boolean }>("workflows_set_setting", "mutation"),
    decideWorkflowApproval: def<Obj>("workflows_decide_approval", "mutation"),
    cancelWorkflowInstance: def<Obj>("workflows_cancel_instance", "mutation"),
    retryWorkflowInstance: def<Obj>("workflows_retry_instance", "mutation"),
  },
  connections: {
    listConnectorCatalog: def<CatalogEntryShape[]>("connections_list_catalog", "query"),
    beginGoogleDriveOAuth: def<Obj>("connections_begin_google_drive_oauth", "mutation"),
    disconnectGoogleDrive: def<{ ok: boolean }>("connections_disconnect_google_drive", "mutation"),
  },
  connectionsSync: {
    syncGoogleDrive: def<Obj>("connections-sync-google-drive", "edge"),
    testConnection: def<Obj>("connections-test-connection", "edge"),
    runDueSyncs: def<{ ok: boolean }>("connections-run-due-syncs", "edge"),
  },
  insurance: {
    claims: {
      // The deployed RPC returns rows wrapped as { claim, findings,
      // supplements }; the pages read flat fields (c._id, c.customer,
      // c.completeness, …). Normalize at this boundary so list rows carry the
      // persisted claim id + derived aggregates — the production defect was
      // undefined row fields navigating to /revenue-recovery/undefined →
      // ClaimDetail “Claim not found”.
      listClaims: defT<ObjArray>("insurance_list_claims", "query", (d) =>
        normalizeClaimListResponse(d) as unknown as ObjArray,
      ),
      // The deployed RPC returns the raw claim row + its supplements/findings/
      // evidence. The page renders the DERIVED package (completeness, model,
      // timeline, reconciliation) — enrich at the boundary so the page can
      // never crash on the missing sections (the production defect).
      getClaimPackage: defT<ClaimPackageShape | null>(
        "insurance_get_claim_package",
        "query",
        (d) => normalizeClaimPackageResponse(d) as unknown as ClaimPackageShape | null,
      ),
      getClaimTimeline: def<ObjArray>("insurance_get_claim_timeline", "query"),
      getSupplementDocument: def<SupplementDocumentShape | null>(
        "insurance_get_supplement_document",
        "query",
      ),
      claimCounts: defT<Obj & { recoveryPipeline: string[] }>(
        "insurance_claim_counts",
        "query",
        (d) => (d && typeof d === "object" ? d : defaultClaimCounts()),
      ),
      // The deployed RPC returns raw { claims, findings, supplements }; the
      // page consumes the DERIVED analytics (trend/carriers/statusDistribution/
      // recoveryPipeline). Building it at the boundary is what makes the
      // Revenue Recovery page survive zero/incomplete/missing data instead of
      // crashing on analytics.trend.flatMap (the production defect).
      recoveryAnalytics: defT<
        Obj & {
          recoveryPipeline: string[];
          trend: RecoveryTrendPointShape[];
          carriers: CarrierRecoveryRowShape[];
          statusDistribution: LifecycleStageShape[];
        }
      >("insurance_recovery_analytics", "query", (d) =>
        buildRecoveryAnalytics(d) as unknown as Obj & {
          recoveryPipeline: string[];
          trend: RecoveryTrendPointShape[];
          carriers: CarrierRecoveryRowShape[];
          statusDistribution: LifecycleStageShape[];
        },
      ),
      analyzeAllClaims: def<Obj>("insurance_analyze_all_claims", "query"),
      insuranceIntelligence: def<Obj>(
        "insurance_intelligence",
        "client",
        async () => ({
          summary: "",
          carriers: [],
          statusDistribution: [],
          recoveryPipeline: [],
          trend: [],
        }),
      ),
      createClaim: def<Obj>("insurance_create_claim", "mutation"),
      updateClaim: def<{ ok: boolean }>("insurance_update_claim", "mutation"),
      attachClaimEvidence: def<{ ok: boolean }>("insurance_attach_claim_evidence", "mutation"),
      runClaimAnalysis: def<{ ok: boolean; findings: number; evidence: number }>(
        "insurance_run_claim_analysis",
        "client",
        async (args) => {
          // The insurance_run_claim_analysis RPC does not exist in the
          // deployed schema — analysis runs the SAME deterministic analyzers
          // the demo loader uses, against the real claim record, and persists
          // findings via insurance_upsert_findings (idempotent on findingKey).
          const claimId = String((args ?? {}).claimId ?? "");
          const [{ rpcCall }, { buildClaimFindings, enrichClaimFromEvidence }, { getSupabaseClient }] =
            await Promise.all([
              import("@/lib/actions/rpc"),
              import("@/lib/insurance/logic"),
              import("@/lib/supabase"),
            ]);
          const supabase = getSupabaseClient();
          if (!supabase) throw new Error("Supabase is not configured.");
          let pkg: { claim?: Record<string, unknown> | null } | null = null;
          try {
            pkg = (await rpcCall(supabase, "insurance_get_claim_package", {
              claimId,
            })) as { claim?: Record<string, unknown> | null };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            // Pre-migration 0009 insurance_get_claim_package raises 22023
            // (JSON-null scalar evidence) or 22P02 (legacy nested evidence
            // ids wrapped as {"value": …}). Both are valid claim states, so
            // fall back to the timeline RPC (same claim row, no evidence
            // join) and keep analysis working until the migration lands.
            const msg = String(err?.message ?? "");
            const isBrokenPackage =
              err?.code === "22023" ||
              err?.code === "22P02" ||
              msg.includes("cannot extract elements from a scalar") ||
              msg.includes("invalid input syntax for type uuid");
            if (!isBrokenPackage) {
              throw e;
            }
            const timeline = (await rpcCall(supabase, "insurance_get_claim_timeline", {
              claimId,
            })) as { claim?: Record<string, unknown> | null };
            pkg = { claim: timeline?.claim ?? null };
          }
          if (!pkg?.claim) throw new Error("Claim not found.");
          const claim = pkg.claim;
          const snapshot = {
            _id: claimId,
            claimNumber: (claim.claimNumber as string) ?? null,
            dateOfLoss: (claim.dateOfLoss as number | null) ?? null,
            property: (claim.property as string) ?? null,
            causeOfLoss: (claim.causeOfLoss as string) ?? null,
            lossDescription: (claim.lossDescription as string) ?? null,
            customer: (claim.customer as string) ?? null,
            carrier: (claim.carrier as string) ?? null,
            policy: (claim.policy as string) ?? null,
            adjuster: (claim.adjuster as string) ?? null,
            status: (claim.status as string) ?? null,
            estimateAmount: (claim.estimateAmount as number | null) ?? null,
            estimateLineItemCount: (claim.estimateLineItemCount as number | null) ?? null,
            invoicedAmount: (claim.invoicedAmount as number | null) ?? null,
            paymentAmount: (claim.paymentAmount as number | null) ?? null,
            approvedAmount: (claim.approvedAmount as number | null) ?? null,
            collectedAmount: (claim.collectedAmount as number | null) ?? null,
            openBalance: (claim.openBalance as number | null) ?? null,
            deductible: (claim.deductible as number | null) ?? null,
            policyLimits: (claim.policyLimits as number | null) ?? null,
            scopeItems: (claim.scopeItems as ClaimSnapshot["scopeItems"]) ?? null,
            expectedScope: (claim.expectedScope as string[]) ?? null,
            actualScope: (claim.actualScope as string[]) ?? null,
            evidenceSummary: (claim.evidenceSummary as string[]) ?? null,
            evidenceDocumentIds: (claim.evidenceDocumentIds as unknown[]) ?? null,
            provenance: (claim.provenance as string) ?? null,
            createdAt: (claim.createdAt as number | null) ?? null,
            updatedAt: (claim.updatedAt as number | null) ?? null,
          } as ClaimSnapshot;

          // Ground the (possibly sparse) claim in its actual evidence
          // documents: match tenant docs by claim number, pull their
          // extracted text, and derive the amounts / scope / evidence
          // categories the analyzers run on. Best-effort — if enrichment
          // fails, analysis still runs on the claim record itself.
          const claimNumForMatch = String(
            claim.claimNumber ?? snapshot.claimNumber ?? "",
          ).replace(/[-\s]/g, "").toUpperCase();
          let enrichedSnapshot = snapshot;
          if (claimNumForMatch) {
            try {
              const docs = await listTenantDocsForClaim(supabase);
              // Match the claim number in the title, the source path OR the
              // extracted content summary. Real archives (including the NPP
              // demo) deliberately scatter claim documents outside the claim
              // folder, so folder-derived matches alone miss the invoice,
              // payment and estimate docs — their content still names the
              // claim, and summaries are derived from that content.
              const matched = docs
                .filter((d) =>
                  `${d.title ?? ""} ${d.sourceId ?? ""} ${d.summary ?? ""}`
                    .toUpperCase()
                    .replace(/[-\s]/g, "")
                    .includes(claimNumForMatch),
                )
                .sort(
                  (a, b) =>
                    evidencePriority(b.classification) -
                    evidencePriority(a.classification),
                );
              // Fetch every matched claim document's extracted text (capped
              // only as a safety bound — a single claim rarely exceeds a few
              // dozen documents) so the analyzers see the invoice, payment and
              // estimate docs the way the individual-upload path does.
              const withText: EvidenceDocLike[] = [];
              for (const d of matched.slice(0, 40)) {
                const detail = (await rpcCall(
                  supabase,
                  "documents_get_document_detail",
                  { documentId: d._id },
                ).catch(() => null)) as { chunks?: Array<{ content?: string }> } | null;
                withText.push({
                  _id: d._id,
                  title: d.title,
                  classification: d.classification,
                  text: (detail?.chunks ?? []).map((c) => c.content ?? "").join("\n"),
                });
              }
              enrichedSnapshot = enrichClaimFromEvidence(snapshot, withText);
            } catch (e) {
              // Enrichment is best-effort — never block analysis on it.
              // eslint-disable-next-line no-console
              console.error("[atlas] claim evidence enrichment failed:", e);
            }
          }

          const findings = buildClaimFindings(enrichedSnapshot).map((f, i) => ({
            ...f,
            findingKey: `claim:${claimId}:${f.source ?? f.category}:${i}`,
          }));
          await rpcCall(supabase, "insurance_upsert_findings", {
            claimId,
            findings,
          });

          // Link every document that references this claim number as evidence
          // (tenant-scoped by the RPC).
          let evidenceLinked = 0;
          const claimNumber = claim.claimNumber as string | undefined;
          if (claimNumber) {
            const docs = await listTenantDocsForClaim(supabase);
            const num = claimNumber.replace(/[-\s]/g, "").toUpperCase();
            for (const d of docs) {
              const hay = `${d.title ?? ""} ${d.sourceId ?? ""} ${d.summary ?? ""}`
                .toUpperCase()
                .replace(/[-\s]/g, "");
              if (hay.includes(num)) {
                await rpcCall(supabase, "insurance_attach_claim_evidence", {
                  claimId,
                  documentId: d._id,
                }).catch(() => undefined);
                evidenceLinked++;
              }
            }
          }
          return { ok: true, findings: findings.length, evidence: evidenceLinked };
        },
      ),
      updateFindingStatus: def<{ ok: boolean }>("insurance_update_finding_status", "mutation"),
      createSupplement: def<{ ok: boolean }>("insurance_create_supplement", "mutation"),
      updateSupplementStatus: def<{ ok: boolean }>(
        "insurance_update_supplement_status",
        "mutation",
      ),
      recordClaimPayment: def<{ ok: boolean }>("insurance_record_claim_payment", "mutation"),
    },
    candidates: {
      listClaimCandidates: defT<ObjArray>("insurance_list_claim_candidates", "query", (d) =>
        Array.isArray(d)
          ? d.map((c) => ({
              ...c,
              evidence: Array.isArray(c.evidence) ? c.evidence : [],
              documentIds: Array.isArray(c.documentIds) ? c.documentIds : [],
              documentTitles: Array.isArray(c.documentTitles) ? c.documentTitles : [],
              archivePaths: Array.isArray(c.archivePaths) ? c.archivePaths : [],
            }))
          : [],
      ),
      claimCandidateCounts: defT<Obj>("insurance_claim_candidate_counts", "query", (d) =>
        d && typeof d === "object" ? d : {},
      ),
      approveClaimCandidate: def<Obj>("insurance_approve_claim_candidate", "mutation"),
      rejectClaimCandidate: def<{ ok: boolean }>("insurance_reject_claim_candidate", "mutation"),
      candidateSummary: def<Obj>("insurance_claim_candidate_summary", "query"),
      reconstructClaims: def<Obj>(
        "insurance_reconstruct_claims",
        "client",
        async () => {
          // CLAIM DISCOVERY + EVIDENCE RECONSTRUCTION (§"FINAL CLAIM
          // DISCOVERY"): the deterministic discovery engine turns the
          // tenant's ingested evidence into REAL persisted claims — it does
          // NOT stop at candidates. HIGH-confidence evidence creates a claim
          // (approving the pending candidate when one exists, otherwise
          // insurance_create_claim) with its evidence attached; evidence that
          // matches an existing claim ENRICHES it (missing fields only, never
          // overwriting); MEDIUM evidence becomes a reviewable candidate; LOW
          // evidence is kept without manufacturing anything. See
          // src/lib/actions/claim-discovery.ts for the full executor.
          const [{ runClaimDiscovery }, { getSupabaseClient }] = await Promise.all([
            import("@/lib/actions/claim-discovery"),
            import("@/lib/supabase"),
          ]);
          const supabase = getSupabaseClient();
          if (!supabase) throw new Error("Supabase is not configured.");
          return runClaimDiscovery(supabase);
        },
      ),
    },
    demoData: {
      // The `insurance_demo_load` RPC does not exist in the deployed schema
      // (production regression: the Revenue Recovery “Load demo data” button
      // 404'd). The deterministic demo loader already exists client-side —
      // seed through the DEPLOYED RPCs (insurance_demo_remove +
      // insurance_create_claim + insurance_update_claim +
      // insurance_create_supplement + insurance_upsert_findings) instead.
      loadDemoData: def<{ claims: number; demo: true }>(
        "insurance_demo_load",
        "client",
        async () => {
          const { loadDemoDataClient } = await import("@/lib/insurance/demo");
          return loadDemoDataClient();
        },
      ),
      removeDemoData: def<{ removed: number }>(
        "insurance_demo_remove",
        "client",
        async () => {
          const { removeDemoDataClient } = await import("@/lib/insurance/demo");
          return removeDemoDataClient();
        },
      ),
    },
  },
  tools: {
    tools: {
      listTools: def<ToolRowShape[]>("tools_list", "query"),
      listToolActions: def<ObjArray>("tools_list_actions", "query"),
    },
    execute: {
      executeTool: def<Obj>("tools-execute-tool", "edge"),
      confirmToolAction: def<Obj>("tools-confirm-tool-action", "edge"),
      cancelToolAction: def<Obj>("tools-cancel-tool-action", "edge"),
    },
  },
  conversation: {
    listConversationSessions: def<ObjArray>("conversation_list_sessions", "query"),
    getConversationSession: def<Obj | null>("conversation_get_session", "query"),
    deleteConversationSession: def<{ ok: boolean }>("conversation_delete_session", "mutation"),
    converse: def<Obj>("conversation-converse", "client", async (args) => {
      // Prefer the deployed Edge Function (AI-powered conversational brain).
      // When it isn't deployed / not configured in this project, fall back to
      // deterministic local retrieval over REAL ingested evidence so Ask Atlas
      // and voice never dead-end (Phase 15).
      //
      // Structured diagnostics: the edge request/status/failure is logged with
      // an [atlas] converse prefix so the voice + Ask flows can be traced end
      // to end (wake → transcript → converse → answer) without ever logging
      // secrets. A failure of BOTH the edge function AND local retrieval is
      // surfaced with the real reason instead of being swallowed.
      const { getSupabaseClient } = await import("@/lib/supabase");
      const supabase = getSupabaseClient();
      if (!supabase) throw new Error("Supabase is not configured.");
      const body = (args ?? {}) as Record<string, unknown>;
      const question = String(body.transcript ?? body.query ?? "");
      console.info("[atlas] converse: edge request started", {
        question: question.slice(0, 80),
      });
      try {
        const { data, error } = await supabase.functions.invoke(
          "conversation-converse",
          { body },
        );
        if (error) throw error;
        const payload = data as { data?: unknown; error?: string; ok?: boolean } | null;
        if (payload && typeof payload === "object" && payload.error) {
          throw new Error(payload.error);
        }
        console.info("[atlas] converse: edge response ok");
        const unwrapped =
          payload && typeof payload === "object" && "data" in payload
            ? (payload.data as Obj | undefined)
            : ((payload ?? {}) as Obj);
        // AI diagnostics (no secrets): expose provider/model/status from the
        // deployed reasoning layer so the Ask page and Voice panel can show
        // the real configuration instead of a misleading "no AI" state.
        const ai = unwrapped?.ai as
          | { configured?: boolean; provider?: string; model?: string | null; status?: string; lastErrorCode?: string; latencyMs?: number }
          | undefined;
        // A deployed backend that predates the AI layer reports no metadata —
        // treat it as the honest default (deterministic retrieval) so the UI
        // never guesses or shows a stale "checking…" state.
        if (!ai && unwrapped && typeof unwrapped === "object") {
          unwrapped.ai = {
            configured: false,
            provider: "none",
            model: null,
            status: "not_configured",
            lastErrorCode: "backend_has_no_ai_layer",
          };
        }
        if (ai) {
          const model = ai.model ?? "?";
          if (ai.status === "connected") {
            console.info("[atlas] converse: ai-request-completed", {
              provider: ai.provider,
              model,
              latencyMs: ai.latencyMs,
            });
          } else if (ai.status === "fallback") {
            console.info("[atlas] converse: ai-fallback", {
              provider: ai.provider,
              model,
              reason: ai.lastErrorCode,
            });
          } else if (ai.status === "skipped") {
            console.info("[atlas] converse: ai-skipped", {
              provider: ai.provider,
              model,
              reason: ai.lastErrorCode,
            });
          }
        }
        return unwrapped ?? {};
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          "[atlas] converse: edge failure (",
          msg.slice(0, 160),
          ") — falling back to local retrieval",
        );
        if (!isConverseEngineUnreachable(msg)) throw e;
        console.info("[atlas] converse: ai-fallback", {
          reason: "engine_unreachable",
          detail: msg.slice(0, 120),
        });
        const { answerLocally } = await import("@/lib/ask/retrieval");
        try {
          const local = await answerLocally(
            supabase,
            question,
            (body.sessionId as string | null) ?? null,
          );
          return {
            ...(local as unknown as Obj),
            ai: {
              configured: false,
              provider: "none",
              model: null,
              status: "not_configured",
              lastErrorCode: "engine_unreachable",
            },
          };
        } catch (fallbackError) {
          const fmsg =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new Error(
            `The conversation engine is unreachable (${msg.slice(0, 120)}) and local retrieval over your knowledge base also failed: ${fmsg}`,
          );
        }
      }
    }),
  },
  voice: {
    voiceProviderStatus: def<{
      stt: string;
      tts: string;
      sttProvider: string;
      ttsProvider: string;
      serverConfigured: boolean;
      voiceRuntimeAvailable: boolean;
      nvidiaVoiceAvailable: boolean;
    }>("voice_provider_status", "client", async () => {
      // Check Voice Runtime availability (Phase 6)
      let voiceRuntimeAvailable = false;
      let nvidiaVoiceAvailable = false;
      try {
        const { isVoiceRuntimeInitialized, isVoiceProviderAvailable } = await import("@/lib/voice-runtime");
        voiceRuntimeAvailable = isVoiceRuntimeInitialized();
        nvidiaVoiceAvailable = isVoiceProviderAvailable("nvidia-nim-voice");
      } catch {
        // Voice runtime not yet initialized — fall back to browser voice
      }

      return {
        stt: nvidiaVoiceAvailable ? "server" : "browser",
        tts: nvidiaVoiceAvailable ? "server" : "browser",
        sttProvider: nvidiaVoiceAvailable ? "nvidia-nemotron" : "browser",
        ttsProvider: nvidiaVoiceAvailable ? "nvidia-nemotron" : "browser",
        serverConfigured: nvidiaVoiceAvailable,
        voiceRuntimeAvailable,
        nvidiaVoiceAvailable,
      };
    }),
    synthesizeSpeech: def<Obj>("voice-synthesize", "edge"),
    transcribeAudio: def<Obj>("voice-transcribe", "edge"),
  },
  everest: {
    // Deployed `everest_get_organization_context()` takes ZERO parameters. The
    // page historically passed `{ userTimezone }` — PostgREST 404s any extra
    // param (PGRST202), so the org section never loaded in production. This is
    // a client impl: it calls the RPC with no args, uses the passed
    // userTimezone only for the browser-side temporal snapshot, and normalizes
    // the deployed `{ tenantId, context, timezoneNote, profile, locations }`
    // shape into the page contract (context/organization/user/locations). A
    // genuine RPC failure throws → useQuery resolves null → the page shows an
    // explicit error state (never an eternal "Loading…").
    getOrganizationContext: def<NormalizedOrgContextShape | null>(
      "everest_get_organization_context",
      "client",
      async (args) => {
        const { getSupabaseClient } = await import("@/lib/supabase");
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        const a = (args ?? {}) as Record<string, unknown>;
        const userTimezone =
          typeof a.userTimezone === "string" && a.userTimezone
            ? a.userTimezone
            : undefined;
        const raw = await rpcCall(supabase, "everest_get_organization_context");
        return normalizeOrganizationContextResponse(raw, Date.now(), userTimezone);
      },
    ),
    // Deployed `everest_update_organization_context(p_patch jsonb)` — the page
    // submits individual form fields, so this client impl packs them into the
    // single jsonb patch the RPC requires (previously a plain mutation that
    // 404'd on `p_country`/`p_regions`/…).
    updateOrganizationContext: def<{ ok: boolean }>(
      "everest_update_organization_context",
      "client",
      async (args) => {
        const { getSupabaseClient } = await import("@/lib/supabase");
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        const a = (args ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of [
          "country",
          "regions",
          "cities",
          "primaryTimezone",
          "locale",
          "currency",
          "fiscalYearStart",
          "businessDays",
          "businessHours",
          "holidays",
          "industry",
          "businessModel",
          "companySize",
        ]) {
          if (a[k] !== undefined) patch[k] = a[k] === null ? null : a[k];
        }
        await rpcCall(supabase, "everest_update_organization_context", {
          p_patch: patch,
        });
        return { ok: true };
      },
    ),
    upsertOperatingLocation: def<{ ok: boolean }>("everest_upsert_operating_location", "mutation"),
    removeOperatingLocation: def<{ ok: boolean }>("everest_remove_operating_location", "mutation"),
    // Not an RPC — the universal Business Brain ships with the frontend
    // (migration 0005 header: static knowledge lives client-side). The old
    // stub returned empty arrays, so the page showed all-zero stat cards
    // despite the real atlas data being available.
    getBusinessBrain: def<BusinessBrainShape>(
      "everest_business_brain",
      "client",
      () => buildBusinessBrain() as unknown as BusinessBrainShape,
    ),
    // Deployed RPC + boundary enrichments: tier labels/weights, retrieval
    // metadata and fail-closed per-row applicability evaluated against the
    // tenant's own org context (fetched via the same zero-arg RPC). If the
    // context fetch fails, applicability fails closed with a reason instead of
    // silently treating knowledge as applicable.
    listAuthoritativeKnowledge: def<AuthoritativeKnowledgeShape>(
      "everest_list_authoritative_knowledge",
      "client",
      async () => {
        const { getSupabaseClient } = await import("@/lib/supabase");
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        let context: Record<string, unknown> | null = null;
        try {
          const org = (await rpcCall(
            supabase,
            "everest_get_organization_context",
          )) as Record<string, unknown> | null;
          const ctx = org && typeof org === "object" ? (org.context as Record<string, unknown>) : null;
          if (ctx && typeof ctx === "object") {
            context = {
              country: ctx.country,
              regions: ctx.regions,
              cities: ctx.cities,
              industry: ctx.industry,
            };
          }
        } catch (e) {
          // Fail closed — applicability gets an explicit reason, never a pass.
          console.error(
            "[atlas] org context unavailable for knowledge applicability (failing closed):",
            e instanceof Error ? e.message : String(e),
          );
        }
        const raw = await rpcCall(supabase, "everest_list_authoritative_knowledge");
        return normalizeAuthoritativeKnowledgeResponse(
          raw,
          context,
        ) as unknown as AuthoritativeKnowledgeShape;
      },
    ),
    // Not deployed as RPCs — measured client-side from the real registered
    // pack items + the deployed `everest_raw_knowledge` registry (empty
    // registry → honest zero scores, never fabricated rows).
    getIndustryCoverage: def<IndustryCoverageShape | null>(
      "everest_industry_coverage",
      "client",
      async () => {
        const { getSupabaseClient } = await import("@/lib/supabase");
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        return (await buildIndustryCoverage(supabase)) as unknown as IndustryCoverageShape;
      },
    ),
    getInsuranceIntelligence: def<EverestInsuranceShape | null>(
      "everest_insurance_intelligence",
      "client",
      () => buildInsuranceIntelligence() as unknown as EverestInsuranceShape,
    ),
    getAuthorityMonitor: defT<AuthorityMonitorShape | null>(
      "everest_authority_monitor",
      "query",
      (d) => normalizeAuthorityMonitorResponse(d) as AuthorityMonitorShape | null,
    ),
    // Guaranteed arrays at the boundary — never undefined/null (same class of
    // production defect that crashed ArchiveDetail).
    listKnowledgeChanges: defT<ObjArray>(
      "everest_list_knowledge_changes",
      "query",
      (d) => normalizeKnowledgeChanges(d),
    ),
    listImpactAssessments: defT<ObjArray>(
      "everest_list_impact_assessments",
      "query",
      (d) => normalizeImpactAssessments(d),
    ),
    decideImpactReview: def<{ ok: boolean }>("everest_decide_impact_review", "mutation"),
    getIndustryExcellence: def<IndustryExcellenceShape | null>(
      "everest_industry_excellence",
      "client",
      async () => {
        const { getSupabaseClient } = await import("@/lib/supabase");
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        return (await buildIndustryExcellence(supabase)) as unknown as IndustryExcellenceShape;
      },
    ),
    getValueIntelligence: def<ValueIntelligenceShape | null>(
      "everest_value_intelligence",
      "client",
      (args) => buildValueIntelligence(args) as unknown as ValueIntelligenceShape,
    ),
    // Not an RPC — deterministic recovery analysis over the page's claim
    // facts (the same engine the demo loader uses).
    analyzeClaimRecovery: def<Obj | null>(
      "everest_analyze_claim_recovery",
      "client",
      (args) => analyzeRecoveryClient(args) as unknown as Obj,
    ),
    runAuthorityCheckNow: def<{ status: string; createdVersionIds?: string[] }>(
      "everest-authority-check",
      "edge",
    ),
    runInvestigation: def<Obj>("everest-run-investigation", "edge"),
    seedEverest: def<{ seededSources: number; seededKnowledge: number }>(
      "everest_seed",
      "mutation",
    ),
  },
  seed: {
    seedDemoData: def<Obj>("seed_demo_data", "mutation"),
    seedDemoClaims: def<{ ok: boolean }>("seed_demo_claims", "mutation"),
  },
pilotIntelligence: {
    listCompanies: def<PilotCompanyRow[]>("pilot_companies_list", "query"),
    createCompany: def<PilotCompanyRow>("pilot_companies_create", "mutation"),
    updateCompany: def<PilotCompanyRow>("pilot_companies_update", "mutation"),
    deleteCompany: def<boolean>("pilot_companies_delete", "mutation"),
    listSessions: def<PilotSessionRow[]>("pilot_sessions_list", "query"),
    createSession: def<PilotSessionRow>("pilot_sessions_create", "mutation"),
    deleteSession: def<boolean>("pilot_sessions_delete", "mutation"),
    listInsights: def<PilotInsightRow[]>("pilot_insights_list", "query"),
    createInsight: def<PilotInsightRow>("pilot_insights_create", "mutation"),
    updateInsightStatus: def<PilotInsightRow>("pilot_insights_update_status", "mutation"),
    deleteInsight: def<boolean>("pilot_insights_delete", "mutation"),
    listOutcomes: def<PilotOutcomeRow[]>("pilot_outcomes_list", "query"),
    createOutcome: def<PilotOutcomeRow>("pilot_outcomes_create", "mutation"),
    deleteOutcome: def<boolean>("pilot_outcomes_delete", "mutation"),
    listTestimonials: def<PilotTestimonialRow[]>("pilot_testimonials_list", "query"),
    createTestimonial: def<PilotTestimonialRow>("pilot_testimonials_create", "mutation"),
    getAnalytics: def<PilotAnalyticsShape>("pilot_analytics", "query"),
  },
  admin: {
    listPilotApplications: def<ObjArray>("pilot_list_applications", "query"),
    getApplication: def<Obj | null>("pilot_get_application", "query"),
    reviewPilotApplication: def<{ ok: boolean }>("pilot_review_application", "mutation"),
    pilotApplicationStats: def<Obj>("pilot_application_stats", "query"),
    provisionUser: def<Obj>("admin_provision_user", "mutation"),
    listProvisions: def<ObjArray>("admin_list_provisions", "query"),
    listAuditLog: def<ObjArray>("admin_list_audit_log", "query"),
    // User management
    listUsers: def<ObjArray>("admin_list_users", "query"),
    getUser: def<Obj | null>("admin_get_user", "query"),
    updateUserRole: def<{ ok: boolean }>("admin_update_user_role", "mutation"),
    updateUserStatus: def<{ ok: boolean }>("admin_update_user_status", "mutation"),
    updateUserCompany: def<{ ok: boolean }>("admin_update_user_company", "mutation"),
    listTenants: def<ObjArray>("admin_list_tenants", "query"),
    createTenant: def<{ ok: boolean }>("admin_create_tenant", "mutation"),
    inviteUser: def<{ ok: boolean; user_id?: string; action?: string; message?: string }>("admin_invite_user", "mutation"),
  },
  crm: {
    listLeads: def<ObjArray>("crm_list_leads", "query"),
    getLead: def<Obj | null>("crm_get_lead", "query"),
    createLead: def<Obj>("crm_create_lead", "mutation"),
    updateLead: def<Obj>("crm_update_lead", "mutation"),
    deleteLead: def<{ ok: boolean }>("crm_delete_lead", "mutation"),
    addActivity: def<Obj>("crm_add_activity", "mutation"),
    listTasks: def<ObjArray>("crm_list_tasks", "query"),
    createTask: def<Obj>("crm_create_task", "mutation"),
    completeTask: def<{ ok: boolean }>("crm_complete_task", "mutation"),
    dashboardStats: def<Obj>("crm_dashboard_stats", "query"),
    // Custom fields
    listCustomFields: def<ObjArray>("crm_list_custom_fields", "query"),
    createCustomField: def<Obj>("crm_create_custom_field", "mutation"),
    deleteCustomField: def<{ ok: boolean }>("crm_delete_custom_field", "mutation"),
    getCustomFieldValues: def<ObjArray>("crm_get_custom_field_values", "query"),
    upsertCustomFieldValue: def<Obj>("crm_upsert_custom_field_value", "mutation"),
    bulkUpsertCustomFieldValues: def<{ count: number }>("crm_bulk_upsert_custom_field_values", "mutation"),
  },
  email: {
    listTemplates: def<ObjArray>("email_list_templates", "query"),
    saveTemplate: def<Obj>("email_save_template", "mutation"),
    deleteTemplate: def<{ ok: boolean }>("email_delete_template", "mutation"),
    createOutreach: def<Obj>("email_create_outreach", "mutation"),
    listOutreach: def<ObjArray>("email_list_outreach", "query"),
    listSignatures: def<ObjArray>("email_list_signatures", "query"),
    saveSignature: def<Obj>("email_save_signature", "mutation"),
    deleteSignature: def<{ ok: boolean }>("email_delete_signature", "mutation"),
  },
  industryKnowledge: {
    // Industry knowledge layer — Layer 1 (global, shared across all customers)
    listDocuments: def<ObjArray>("industry_list_documents", "query"),
    getDocumentDetail: def<Obj | null>("industry_get_document_detail", "query"),
    searchKnowledge: def<ObjArray>("industry_search_knowledge", "query"),
    knowledgeStats: def<Obj>("industry_knowledge_stats", "query"),
    knowledgeGraph: def<{
      nodes: Array<{ id: string; type: string; title: string }>;
      edges: Array<{ source: string; target: string; relationship: string }>;
    }>("industry_knowledge_graph", "query"),
    seedKnowledge: def<{ seededDocuments: number; seededKnowledge: number; seededProvenance: number }>(
      "industry_seed_knowledge",
      "client",
      async () => {
        const [
          { ATLAS_INDUSTRY_KNOWLEDGE_SEED, ATLAS_KNOWLEDGE_PROVENANCE },
          { getSupabaseClient },
        ] = await Promise.all([
          import("@/lib/knowledge/seed"),
          import("@/lib/supabase"),
        ]);
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        const { data, error } = await supabase.rpc("industry_seed_knowledge", {
          p_knowledge: ATLAS_INDUSTRY_KNOWLEDGE_SEED,
          p_provenance: ATLAS_KNOWLEDGE_PROVENANCE,
        });
        if (error) throw error;
        return data as { seededDocuments: number; seededKnowledge: number; seededProvenance: number };
      },
    ),
    // Client-side knowledge retrieval (combines industry + customer + live evidence)
    retrieveKnowledge: def<Obj>(
      "knowledge_retrieve",
      "client",
      async (args) => {
        const { retrieveKnowledge } = await import("@/lib/knowledge/retrieval");
        const { getSupabaseClient } = await import("@/lib/supabase");
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase is not configured.");
        const a = (args ?? {}) as Record<string, unknown>;
        const query = String(a.query ?? "");
        return retrieveKnowledge(supabase, query, {
          layers: a.layers as import("@/lib/knowledge/types").KnowledgeLayer[] | undefined,
          industry: a.industry as string | undefined,
          jurisdiction: a.jurisdiction as string | undefined,
          limit: typeof a.limit === "number" ? a.limit : 15,
        });
      },
    ),
  },
  // ---------------------------------------------------------------------
  // Atlas Durable Job System
  // ---------------------------------------------------------------------
  jobs: {
    createJob: def<{ job_id: string; deduplicated: boolean }>(
      "jobs_create_job",
      "mutation",
    ),
    createStep: def<{ step_id: string }>("jobs_create_step", "mutation"),
    dequeue: def<{ jobs: string[]; count: number }>("jobs_dequeue", "mutation"),
    completeJob: def<{ ok: boolean }>("jobs_complete_job", "mutation"),
    failJob: def<{ ok: boolean; retrying: boolean; next_scheduled_at?: string }>(
      "jobs_fail_job",
      "mutation",
    ),
    completeStep: def<{ ok: boolean }>("jobs_complete_step", "mutation"),
    failStep: def<{ ok: boolean }>("jobs_fail_step", "mutation"),
    retryStep: def<{ ok: boolean }>("jobs_retry_step", "mutation"),
    cancelJob: def<{ ok: boolean }>("jobs_cancel_job", "mutation"),
    getJob: def<Obj | null>("jobs_get_job", "query"),
    listJobs: def<ObjArray>("jobs_list_jobs", "query"),
    getEvents: def<ObjArray>("jobs_get_events", "query"),
    unlockStuck: def<{ unlocked: number }>("jobs_unlock_stuck", "mutation"),
    stats: def<Obj>("jobs_stats", "query"),
  },
} as const;

export type Api = typeof api;
