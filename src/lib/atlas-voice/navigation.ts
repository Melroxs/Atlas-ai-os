// ---------------------------------------------------------------------------
// Atlas Voice — navigation bridge
//
// `navigate_atlas` must drive the EXISTING Atlas router. This module owns the
// only seam: a component rendered inside the router registers the real
// react-router `navigate` function here, and the voice tools call through it.
// No second navigation system, no URL guessing, and no claiming success when
// navigation did not happen.
//
// Every path below is copied from the actual route table in src/main.tsx.
// Where Atlas has no dedicated route for a concept (evidence and supplements
// are SECTIONS of the claim detail page, not pages of their own) the mapping
// points at the page that really contains it and says so — it never invents a
// deep link that would silently 404.
// ---------------------------------------------------------------------------

const CLAIM_DETAIL_PREFIX = "/dashboard/revenue-recovery/";

/**
 * Extract the claim id from a ClaimDetail path. This is how Atlas learns the
 * ACTIVE claim from context: if the user is looking at a claim and asks
 * "what's missing?", the question refers to that claim without the user
 * repeating its name.
 */
export function claimIdFromPath(pathname: string): string | null {
  const path = (pathname ?? "").split("?")[0].split("#")[0];
  if (!path.startsWith(CLAIM_DETAIL_PREFIX)) return null;
  const rest = path.slice(CLAIM_DETAIL_PREFIX.length);
  if (!rest || rest.includes("/")) return null;
  try {
    return decodeURIComponent(rest) || null;
  } catch {
    return rest || null;
  }
}

/** Page label for the current route, used as voice context. */
export function pageLabelFromPath(pathname: string): string | null {
  const path = (pathname ?? "").split("?")[0];
  if (claimIdFromPath(path)) return "Claim detail";
  for (const destination of Object.values(ATLAS_DESTINATIONS)) {
    if (destination.path && destination.path === path) return destination.label;
  }
  return null;
}

/** Destinations Atlas can be asked to open by voice. */
export interface AtlasDestination {
  id: string;
  /** Spoken/display label used in confirmations. */
  label: string;
  /** Real route path; `null` when the destination needs an entity id. */
  path: string | null;
  /** True when the route needs a claim id appended. */
  requiresClaimId?: boolean;
  /** Honest note when the destination is a section rather than its own page. */
  note?: string;
}

const CLAIM_LIST_PATH = "/dashboard/revenue-recovery";
const CLAIM_DETAIL_PATH = "/dashboard/revenue-recovery/:id";

export const ATLAS_DESTINATIONS: Record<string, AtlasDestination> = {
  dashboard: { id: "dashboard", label: "Dashboard", path: "/dashboard" },
  claims: { id: "claims", label: "Claims", path: CLAIM_LIST_PATH },
  claim: {
    id: "claim",
    label: "claim",
    path: CLAIM_DETAIL_PATH,
    requiresClaimId: true,
  },
  // Evidence/supplements have no standalone route; they live on claim detail.
  evidence: {
    id: "evidence",
    label: "claim evidence",
    path: CLAIM_DETAIL_PATH,
    requiresClaimId: true,
    note: "Evidence is shown on the claim page.",
  },
  supplements: {
    id: "supplements",
    label: "claim supplement",
    path: CLAIM_DETAIL_PATH,
    requiresClaimId: true,
    note: "Supplements are shown on the claim page.",
  },
  workforce: { id: "workforce", label: "Workforce", path: "/dashboard/workers" },
  tasks: { id: "tasks", label: "Work queue", path: "/dashboard/work-queue" },
  ask: { id: "ask", label: "Ask Atlas", path: "/dashboard/ask" },
  knowledge: { id: "knowledge", label: "Knowledge", path: "/dashboard/knowledge" },
  intelligence: { id: "intelligence", label: "Intelligence", path: "/dashboard/intelligence" },
  governance: { id: "governance", label: "Governance", path: "/dashboard/governance" },
  workflows: { id: "workflows", label: "Workflows", path: "/dashboard/workflows" },
  recommendations: {
    id: "recommendations",
    label: "Recommendations",
    path: "/dashboard/recommendations",
  },
  connections: { id: "connections", label: "Connections", path: "/dashboard/connections" },
  events: { id: "events", label: "Events", path: "/dashboard/events" },
  actions: { id: "actions", label: "Actions", path: "/dashboard/actions" },
  team: { id: "team", label: "Team", path: "/dashboard/team" },
  audit: { id: "audit", label: "Audit log", path: "/dashboard/audit" },
  settings: { id: "settings", label: "Settings", path: "/dashboard/settings" },
  billing: { id: "billing", label: "Billing", path: "/dashboard/billing" },
};

/**
 * Spoken variants → destination id. Ordered longest-first at match time so
 * "claims needing review" wins over the bare "claims".
 */
const ALIASES: Array<[string, string]> = [
  ["claim book", "claims"],
  ["all claims", "claims"],
  ["claims needing review", "claims"],
  ["claims list", "claims"],
  ["claim detail", "claim"],
  ["revenue recovery", "claims"],
  ["the evidence", "evidence"],
  ["evidence", "evidence"],
  ["supplement", "supplements"],
  ["supplements", "supplements"],
  ["the claim", "claim"],
  ["claim", "claim"],
  ["today's tasks", "tasks"],
  ["todays tasks", "tasks"],
  ["my tasks", "tasks"],
  ["task list", "tasks"],
  ["work queue", "tasks"],
  ["tasks", "tasks"],
  ["workers", "workforce"],
  ["workforce", "workforce"],
  ["ask atlas", "ask"],
  ["knowledge", "knowledge"],
  ["intelligence", "intelligence"],
  ["governance", "governance"],
  ["workflows", "workflows"],
  ["recommendations", "recommendations"],
  ["connections", "connections"],
  ["events", "events"],
  ["actions", "actions"],
  ["team", "team"],
  ["audit", "audit"],
  ["settings", "settings"],
  ["billing", "billing"],
  ["dashboard", "dashboard"],
  ["home", "dashboard"],
  ["claims", "claims"],
];

/** Resolve a spoken destination phrase to a known destination id. */
export function resolveDestinationId(raw: string): string | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return null;
  if (ATLAS_DESTINATIONS[text]) return text;

  // Longest alias first so specific phrases beat generic ones.
  const ordered = [...ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, id] of ordered) {
    if (text === alias) return id;
  }
  for (const [alias, id] of ordered) {
    if (text.includes(alias)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigator registration (the seam into react-router)
// ---------------------------------------------------------------------------

type Navigator = (path: string) => void;

let _navigator: Navigator | null = null;

/**
 * Register the app's real router navigate function. Called by a component
 * rendered inside the router; returns an unsubscribe function.
 */
export function registerAtlasNavigator(navigate: Navigator): () => void {
  _navigator = navigate;
  return () => {
    if (_navigator === navigate) _navigator = null;
  };
}

/** True when the router seam is wired (i.e. the app shell is mounted). */
export function isAtlasNavigatorRegistered(): boolean {
  return _navigator !== null;
}

/** Test-only reset. */
export function resetAtlasNavigator(): void {
  _navigator = null;
}

// ---------------------------------------------------------------------------
// Resolution + navigation
// ---------------------------------------------------------------------------

export interface AtlasNavigationTarget {
  destination: string;
  label: string;
  path: string;
  claimId?: string;
  /** Honest note when the destination is a section of another page. */
  note?: string;
}

export type AtlasTargetResolution =
  | { ok: true; target: AtlasNavigationTarget }
  | { ok: false; reason: string };

/**
 * Resolve a spoken destination (+ optional entity) into a real route.
 * Returns an explicit reason when it cannot — callers must surface it rather
 * than reporting a success that did not happen.
 */
export function resolveAtlasTarget(input: {
  destination?: string;
  entityId?: string;
}): AtlasTargetResolution {
  const id = resolveDestinationId(input.destination ?? "");
  if (!id) {
    return {
      ok: false,
      reason: input.destination
        ? `I don't know a page called "${input.destination}" in Atlas.`
        : "I didn't catch which Atlas page you want.",
    };
  }

  const destination = ATLAS_DESTINATIONS[id];
  if (!destination) {
    return { ok: false, reason: "That Atlas page isn't available." };
  }

  if (destination.requiresClaimId) {
    const claimId = (input.entityId ?? "").trim();
    if (!claimId) {
      return {
        ok: false,
        reason:
          destination.id === "claim"
            ? "Which claim? Tell me the claim number or customer name."
            : `Which claim's ${destination.label}? Tell me the claim number or customer name.`,
      };
    }
    return {
      ok: true,
      target: {
        destination: destination.id,
        label: destination.label,
        path: `/dashboard/revenue-recovery/${encodeURIComponent(claimId)}`,
        claimId,
        ...(destination.note ? { note: destination.note } : {}),
      },
    };
  }

  if (!destination.path) {
    return { ok: false, reason: "That Atlas page isn't available." };
  }

  return {
    ok: true,
    target: {
      destination: destination.id,
      label: destination.label,
      path: destination.path,
    },
  };
}

export interface AtlasNavigationResult {
  success: boolean;
  destination: string | null;
  entityId: string | null;
  path: string | null;
  message: string;
}

/**
 * Navigate the real Atlas UI. Never reports success unless the router seam
 * actually ran.
 */
export function navigateAtlas(input: {
  destination?: string;
  entityId?: string;
}): AtlasNavigationResult {
  const resolution = resolveAtlasTarget(input);
  if (!resolution.ok) {
    return {
      success: false,
      destination: null,
      entityId: null,
      path: null,
      message: resolution.reason,
    };
  }

  const { target } = resolution;
  if (!_navigator) {
    console.error("[atlas-voice] navigation was requested before the router seam was registered");
    return {
      success: false,
      destination: target.destination,
      entityId: target.claimId ?? null,
      path: target.path,
      message: "I couldn't reach Atlas's navigation. Please try again from inside the app.",
    };
  }

  try {
    _navigator(target.path);
  } catch (error) {
    console.error(
      "[atlas-voice] navigation failed:",
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      destination: target.destination,
      entityId: target.claimId ?? null,
      path: target.path,
      message: "I couldn't open that page. Please try again.",
    };
  }

  const base =
    target.destination === "claim"
      ? "Opened the claim."
      : `Opened ${target.label}.`;

  return {
    success: true,
    destination: target.destination,
    entityId: target.claimId ?? null,
    path: target.path,
    message: target.note ? `${base} ${target.note}` : base,
  };
}
