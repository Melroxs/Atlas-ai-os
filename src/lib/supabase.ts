// ---------------------------------------------------------------------------
// Supabase — the single backend for Atlas.
//
// Auth (email/password + anonymous guests + password reset) and all data go
// through Supabase. The anon key is public by design (it ships in the browser
// bundle); every table is locked down with row-level security and every data
// operation runs as a Postgres RPC so tenants can never see each other.
// Server-side secrets (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) are used only
// by Edge Functions / the Supabase platform — never by this module.
// ---------------------------------------------------------------------------

import {
  createClient,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

// Access import.meta.env.* directly (no aliasing): Vite statically replaces
// direct `import.meta.env.VITE_*` reads at build time, so the values get baked
// into the production bundle. Reading through an alias keeps a runtime
// reference to import.meta.env, which has no VITE_ vars in production builds.
//
// Public fallbacks: the anon key and project URL are public by design (they
// ship in every browser bundle; row-level security gates all data). They keep
// the app functional even in builds where the platform did not inject the
// VITE_ env vars.
//
// The hosted build pipeline can inline VITE_ vars as opaque encrypted blobs
// (no runtime decryptor exists in the browser bundle). Those values are not
// a valid HTTPS URL / JWT, so they are rejected below and the public
// fallbacks are used instead — the app stays fully functional on every
// build target while still honoring real VITE_ vars when present.
const FALLBACK_URL = "https://ibxvzxblyhzwokljkslt.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlieHZ6eGJseWh6d29rbGprc2x0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODM3NzYsImV4cCI6MjEwMjA1OTc3Nn0.12Fubl-jzjDaVaHQFCGrUQODTtZaeiGPNBGNjQoPhyc";

/**
 * True when a value is a usable http(s) URL. The hosted build pipeline can
 * inline VITE_ vars as opaque encrypted blobs (no runtime decryptor exists in
 * the browser bundle); those fail this check so the public fallbacks win.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A Supabase anon key is a JWT: three dot-separated base64url segments. */
export function isJwt(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

const RAW_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const RAW_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const SUPABASE_URL = isHttpUrl(RAW_URL) ? RAW_URL : FALLBACK_URL;
const SUPABASE_ANON_KEY = isJwt(RAW_ANON_KEY) ? RAW_ANON_KEY : FALLBACK_ANON_KEY;

/**
 * The resolved Supabase project URL (public by design — ships in the browser
 * bundle as part of the anon-key configuration).
 */
export const resolvedSupabaseUrl: string = SUPABASE_URL as string;

/**
 * The resolved Supabase anon key (public by design — ships in the browser
 * bundle; row-level security gates all data). Exported so tests and tools can
 * construct independent clients (the default client is a singleton).
 */
export const resolvedSupabaseAnonKey: string = SUPABASE_ANON_KEY as string;

/**
 * True when the browser-side Supabase config keys are present. The Auth page
 * shows an honest banner when this is false instead of firing doomed calls.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing).",
    );
  }
  if (!client) {
    client = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

/** The Supabase client, or null when client config is missing. */
export function getSupabaseClient(): SupabaseClient | null {
  return isSupabaseConfigured() ? getClient() : null;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Create a new Supabase account. Returns the user, or null when email
 * confirmation is enabled and the user must confirm their email before
 * signing in.
 */
export async function supabaseSignUp(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: User | null; needsEmailConfirmation: boolean }> {
  const { data, error } = await getClient().auth.signUp({
    email: input.email.trim(),
    password: input.password,
    options: {
      data: input.name?.trim() ? { full_name: input.name.trim() } : undefined,
    },
  });
  if (error) throw error;
  return {
    user: data.user ?? null,
    needsEmailConfirmation: !data.session,
  };
}

/** Sign in to an existing Supabase account. */
export async function supabaseSignIn(
  email: string,
  password: string,
): Promise<User> {
  const { data, error } = await getClient().auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  if (!data.user) throw new Error("Supabase sign-in returned no user.");
  return data.user;
}

/** Sign in as an anonymous guest (no email/password required). */
export async function supabaseAnonymousSignIn(): Promise<User> {
  const { data, error } = await getClient().auth.signInAnonymously();
  if (error) throw error;
  if (!data.user) throw new Error("Supabase anonymous sign-in returned no user.");
  return data.user;
}

/**
 * Send Supabase's password-reset email.
 *
 * The `redirectTo` ensures the recovery link opens the correct production URL
 * rather than the Supabase Dashboard Site URL (which may be localhost during
 * development). The Site URL in the Supabase Dashboard must also be updated
 * to the production domain.
 */
export async function supabaseSendPasswordReset(email: string): Promise<void> {
  const appOrigin = typeof window !== "undefined"
    ? window.location.origin
    : "https://atlas-ai-os.com";

  const { error } = await getClient().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${appOrigin}/reset-password`,
  });
  if (error) throw error;
}

/**
 * Update the current user's password (used during password-recovery flow).
 * Must be called while the user has an active Supabase session established
 * via the recovery link.
 */
export async function supabaseUpdatePassword(newPassword: string): Promise<void> {
  const { error } = await getClient().auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** Current Supabase session, or null when signed out. */
export async function getSupabaseSession(): Promise<Session | null> {
  if (!isSupabaseConfigured()) return null;
  const { data } = await getClient().auth.getSession();
  return data.session ?? null;
}

/** Sign out of Supabase. */
export async function supabaseSignOut(): Promise<void> {
  try {
    await getClient().auth.signOut();
  } catch {
    // Already signed out — nothing to do.
  }
}

/** Auth events surfaced by Supabase's onAuthStateChange. */
export type SupabaseAuthEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "PASSWORD_RECOVERY"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "MFA_CHALLENGE_VERIFIED"
  | string;

/** Subscribe to auth state changes. Returns an unsubscribe function. */
export function onSupabaseAuthChange(
  callback: (
    session: Session | null,
    event?: SupabaseAuthEvent,
  ) => void,
): () => void {
  if (!isSupabaseConfigured()) return () => undefined;
  const supabase = getClient();
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    callback(session, event);
  });
  void supabase.auth.getSession().then(({ data: sessionData }) => {
    callback(sessionData.session ?? null, "INITIAL_SESSION");
  });
  return () => data.subscription.unsubscribe();
}
