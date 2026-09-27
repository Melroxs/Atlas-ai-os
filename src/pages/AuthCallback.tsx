// ---------------------------------------------------------------------------
// /auth/callback — the single entry point for every Supabase Auth email link
// (invitation, password recovery, magic link, signup confirmation,
// email change) and for any link that fell back to the project Site URL.
//
// Responsibility, in order:
//   1. read the auth payload the email link delivered (fragment, query, or a
//      payload captured at page load before the SDK consumed it);
//   2. establish the Supabase session through Supabase Auth only —
//      setSession (implicit) / verifyOtp (token hash) / exchangeCodeForSession
//      (PKCE) — never by trusting an email address or inventing a session;
//   3. determine the intent (invite / recovery / magic link / sign-in);
//   4. send the user to the matching Atlas route, preserving only a safe
//      internal destination (no open redirects).
//
// Authorization is NOT decided here. First-time activation ends on
// /auth/set-password, and every protected route still goes through RequireAuth
// and the Atlas access gate (account status, tenant membership, billing).
// ---------------------------------------------------------------------------

import { AuthLinkProblem } from "@/components/auth-link-problem";
import { useAuth } from "@/hooks/use-auth";
import {
  consumeCapturedAuthLink,
  isFailedLink,
  parseAuthLink,
  resolveAuthLinkDestination,
  resolveAuthLinkSource,
  resolveSafeNext,
  type AuthLinkPayload,
} from "@/lib/auth/email-link";
import { getSupabaseClient } from "@/lib/supabase";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

interface Establishment {
  payload: AuthLinkPayload | null;
  /**
   * true  — a session was established from the link
   * false — the link carried credentials but Supabase refused them
   * null  — the link carried no credentials; use the app's own auth state
   */
  sessionEstablished: boolean | null;
}

/** A refused link with no intent of its own (nothing useful to do). */
function isRefusedLinkWithoutIntent(payload: AuthLinkPayload | null): boolean {
  return isFailedLink(payload) && payload?.type === null;
}

export default function AuthCallback() {
  const navigate = useNavigate();
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const [establishment, setEstablishment] = useState<Establishment | null>(null);
  const startedRef = useRef(false);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function run() {
      const live = parseAuthLink(
        typeof window !== "undefined" ? window.location : {},
      );
      // Prefer the live URL while it still carries the credentials; otherwise
      // fall back to the payload captured at page load, which is what survives
      // when the SDK (or the router) already consumed and stripped the URL.
      // The capture is claimed either way, so a token can never be applied
      // twice.
      const payload = resolveAuthLinkSource(
        live,
        consumeCapturedAuthLink(),
      );

      if (!payload) {
        setEstablishment({ payload: null, sessionEstablished: null });
        return;
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        setEstablishment({ payload, sessionEstablished: false });
        return;
      }

      try {
        if (payload.accessToken && payload.refreshToken) {
          // Implicit flow (the project default): the email link delivered an
          // access/refresh token pair in the fragment.
          const { data, error } = await supabase.auth.setSession({
            access_token: payload.accessToken,
            refresh_token: payload.refreshToken,
          });
          setEstablishment({
            payload,
            sessionEstablished: !error && Boolean(data.session),
          });
          return;
        }

        if (payload.tokenHash && payload.type) {
          // Token-hash template style: verified server-side, once.
          const { data, error } = await supabase.auth.verifyOtp({
            token_hash: payload.tokenHash,
            type: payload.type,
          });
          setEstablishment({
            payload,
            sessionEstablished: !error && Boolean(data.session),
          });
          return;
        }

        if (payload.code) {
          // PKCE / OAuth authorization code.
          const { data, error } = await supabase.auth.exchangeCodeForSession(
            payload.code,
          );
          setEstablishment({
            payload,
            sessionEstablished: !error && Boolean(data.session),
          });
          return;
        }

        // No credentials to apply — rely on the session the SDK restored.
        setEstablishment({ payload, sessionEstablished: null });
      } catch {
        // Never surface a raw auth-provider error to the user.
        setEstablishment({ payload, sessionEstablished: false });
      }
    }

    void run();
  }, []);

  useEffect(() => {
    if (!establishment || navigatedRef.current) return;

    const { payload, sessionEstablished } = establishment;

    // An outright-refused link with no intent of its own has nowhere useful to
    // go — explain it instead of dumping the user somewhere confusing.
    if (isRefusedLinkWithoutIntent(payload)) return;

    // When the link carried no credentials of its own, wait for the app's own
    // auth state so we never race session initialization.
    if (sessionEstablished === null && authLoading) return;

    navigatedRef.current = true;

    const authenticated = sessionEstablished ?? isAuthenticated;
    const next = resolveSafeNext(payload?.next, "/dashboard");
    const destination = resolveAuthLinkDestination(payload, { authenticated });

    const to =
      destination.kind === "set-password" ||
      destination.kind === "reset-password"
        ? `${destination.to}?next=${encodeURIComponent(next)}`
        : destination.to;

    // `replace` keeps token-bearing URLs out of the history stack.
    navigate(to, { replace: true });
  }, [establishment, authLoading, isAuthenticated, navigate]);

  if (establishment && isRefusedLinkWithoutIntent(establishment.payload)) {
    return (
      <AuthLinkProblem
        title="This link is no longer valid"
        description="That sign-in link has expired or has already been used. Sign in as usual, or request a fresh link — the newest email always wins."
        primary={{ label: "Go to sign in", to: "/auth" }}
        secondary={{ label: "Request a new link", to: "/auth?reset=1" }}
      />
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <span className="text-sm">Signing you in…</span>
      </div>
    </main>
  );
}
