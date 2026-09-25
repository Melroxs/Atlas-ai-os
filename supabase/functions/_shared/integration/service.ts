// ---------------------------------------------------------------------------
// Atlas Integration Platform — Edge-side service access
//
// Server-only helpers for the integration functions. The service-role key is
// used for database writes (events, connections, jobs) and never leaves the
// function. Every write goes through the guarded SQL functions added by
// migration 20260922_atlas_integration_foundation.sql — this module never
// composes its own INSERT/UPDATE against provider tables, so the same
// authorization rules run no matter who calls.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

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

export function serviceReady(): boolean {
  return Boolean(SUPABASE_URL && serviceRoleKey());
}

/** Call a Postgres RPC with the service role. Returns the parsed JSON value. */
export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey(),
      Authorization: `Bearer ${serviceRoleKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`rpc ${name} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** PostgREST select with the service role. */
export async function select<T>(
  table: string,
  query: string,
): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: serviceRoleKey(),
      Authorization: `Bearer ${serviceRoleKey()}`,
    },
  });
  if (!response.ok) {
    throw new Error(`select ${table} failed: ${response.status}`);
  }
  return (await response.json()) as T[];
}

export interface ConnectionRow {
  _id: string;
  tenantId: string;
  provider: string;
  status: string;
}

/**
 * Resolve the connection a webhook URL was issued for.
 *
 * The webhook URL carries the connection id (an unguessable UUID Atlas issued),
 * so the organization binding comes from OUR OWN row — never from a field the
 * provider or an attacker can choose. The signature check still runs first.
 */
export async function loadConnection(connectionId: string): Promise<ConnectionRow | null> {
  const rows = await select<ConnectionRow>(
    "connections",
    `select=_id,%22tenantId%22,provider,status&_id=eq.${encodeURIComponent(connectionId)}&limit=1`,
  );
  return rows[0] ?? null;
}

/**
 * Signing secret for a provider webhook, resolved server-side only.
 *
 * Convention: `INTEGRATION_WEBHOOK_SECRET_<PROVIDER_UPPER>` — one secret per
 * provider, set as an Edge secret, never in the database and never in code.
 */
export function webhookSecretFor(provider: string): string {
  return Deno.env.get(`INTEGRATION_WEBHOOK_SECRET_${provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`) ?? "";
}

/** Credential-sealing key, server-side only. */
export function credentialKey(): string {
  return Deno.env.get("INTEGRATION_CREDENTIAL_KEY") ?? "";
}

/** Compact structured log line with the fields an operator needs. */
export function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(`[integrations] ${event}`, JSON.stringify(detail));
}
