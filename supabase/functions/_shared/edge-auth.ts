// ---------------------------------------------------------------------------
// Atlas Edge Functions — shared auth / CORS / response envelope
//
// Every Atlas Edge Function that the browser calls must:
//   1. answer the CORS preflight before any business logic,
//   2. authenticate the caller's Supabase JWT,
//   3. resolve the caller's organization from THEIR OWN membership — never
//      from a client-supplied tenant id,
//   4. return the `{ data }` / `{ data: null, error }` envelope the frontend
//      action hook (`useAction`) unwraps.
//
// Security notes:
//   - The service-role key is used ONLY for server-to-server reads
//     (auth verification + membership lookup). It never reaches a response.
//   - Unknown origins receive no Access-Control-Allow-Origin header, so the
//     browser blocks the cross-origin read. Authorization is enforced
//     independently of CORS.
// ---------------------------------------------------------------------------

/** Origins the Atlas web app runs from (mirrors _shared/cors.ts). */
export const ATLAS_EDGE_ALLOWED_ORIGINS: string[] = [
  "https://atlas-ai-os.com",
  "https://atlasuniversalos.freebuff.app",
];

export const ATLAS_EDGE_CORS_METHODS = "GET, POST, OPTIONS";
export const ATLAS_EDGE_CORS_HEADERS =
  "authorization, x-client-info, apikey, content-type";
export const ATLAS_EDGE_CORS_MAX_AGE = "86400";

/** CORS headers for a request (Allow-Origin only for allowlisted origins). */
export function atlasEdgeCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Methods", ATLAS_EDGE_CORS_METHODS);
  headers.set("Access-Control-Allow-Headers", ATLAS_EDGE_CORS_HEADERS);
  headers.set("Access-Control-Max-Age", ATLAS_EDGE_CORS_MAX_AGE);
  headers.set("Vary", "Origin");
  const origin = request.headers.get("origin") ?? "";
  if (ATLAS_EDGE_ALLOWED_ORIGINS.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

/** 204 for OPTIONS, or null to continue. Runs BEFORE auth. */
export function atlasEdgePreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: atlasEdgeCorsHeaders(request),
    });
  }
  return null;
}

/** JSON response carrying the CORS headers and the `{ data }` envelope. */
export function atlasEdgeJson(
  data: unknown,
  status = 200,
  headers?: Headers,
): Response {
  const merged = headers ?? new Headers();
  if (!merged.has("Content-Type")) merged.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ data }), { status, headers: merged });
}

/** Error response carrying the CORS headers and the `{ error }` envelope. */
export function atlasEdgeError(
  message: string,
  status: number,
  headers?: Headers,
): Response {
  const merged = headers ?? new Headers();
  if (!merged.has("Content-Type")) merged.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ data: null, error: message }), {
    status,
    headers: merged,
  });
}

// ---------------------------------------------------------------------------
// Server-side Supabase REST access (auth verification + membership lookup)
// ---------------------------------------------------------------------------

function supabaseUrl(): string {
  return Deno.env.get("SUPABASE_URL") ?? "";
}

function serviceRoleKey(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, string>;
      const key = parsed.default ?? parsed.service_role ?? "";
      if (key) return key;
    } catch {
      // fall through to the legacy variable
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function serviceHeaders(): Record<string, string> {
  const key = serviceRoleKey();
  return { apikey: key, Authorization: `Bearer ${key}` };
}

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

export interface AtlasCaller {
  userId: string;
  email: string | null;
  /**
   * The caller's ACTIVE organization, resolved from their own membership.
   * Null only when the user genuinely has no active membership yet.
   */
  tenantId: string | null;
  role: string | null;
}

export class AtlasAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AtlasAuthError";
    this.status = status;
  }
}

/**
 * Verify the caller's Supabase JWT and resolve their own organization.
 *
 * Throws AtlasAuthError when the token is missing or invalid. A user with no
 * active membership is still authenticated (tenantId: null) — callers decide
 * whether an organization is required for their operation.
 */
export async function requireAtlasCaller(request: Request): Promise<AtlasCaller> {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new AtlasAuthError("Unauthorized: missing token", 401);
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new AtlasAuthError("Unauthorized: missing token", 401);

  const url = supabaseUrl();
  if (!url) {
    console.error("[atlas-edge] SUPABASE_URL is not configured");
    throw new AtlasAuthError("Atlas Voice is unavailable right now.", 503);
  }

  const userResponse = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey() },
  });
  if (!userResponse.ok) {
    throw new AtlasAuthError("Your session expired. Please sign in again.", 401);
  }

  const user = (await userResponse.json()) as { id?: string; email?: string };
  if (!user?.id) {
    throw new AtlasAuthError("Your session expired. Please sign in again.", 401);
  }

  const membership = await resolveActiveMembership(user.id);
  return {
    userId: user.id,
    email: user.email ?? null,
    tenantId: membership?.tenantId ?? null,
    role: membership?.role ?? null,
  };
}

interface ActiveMembership {
  tenantId: string;
  role: string | null;
}

/**
 * Resolve the caller's active workspace membership using the service role.
 *
 * Membership is read for THE AUTHENTICATED USER ID only — a tenant id supplied
 * by the client is never consulted, which is what keeps tenant isolation
 * intact for voice requests.
 */
async function resolveActiveMembership(
  userId: string,
): Promise<ActiveMembership | null> {
  const url = supabaseUrl();
  const key = serviceRoleKey();
  if (!url || !key) return null;

  const query =
    `${url}/rest/v1/memberships` +
    `?select=%22tenantId%22,role,status` +
    `&%22userId%22=eq.${encodeURIComponent(userId)}` +
    `&status=eq.active&limit=1`;

  try {
    const response = await fetch(query, { headers: serviceHeaders() });
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    const tenantId = typeof row.tenantId === "string" ? row.tenantId : "";
    if (!tenantId) return null;
    return {
      tenantId,
      role: typeof row.role === "string" ? row.role : null,
    };
  } catch (error) {
    console.error(
      "[atlas-edge] membership lookup failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
