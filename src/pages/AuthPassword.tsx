// ---------------------------------------------------------------------------
// /auth/set-password  — first-time account activation (invitation)
// /auth/reset-password — password recovery
//
// Both flows are the same operation against the same Supabase Auth API
// (auth.updateUser), so they share one implementation and differ only in
// copy. The password itself is NEVER stored, hashed or transmitted anywhere
// except Supabase Auth — Atlas tables never see it.
//
// This page requires an existing Supabase session, which is established by
// /auth/callback from the email link. Without a session the link is expired,
// already used, or was opened in a different browser — we say so plainly and
// offer a way forward instead of showing a form that cannot work.
// ---------------------------------------------------------------------------

import { AuthLinkProblem } from "@/components/auth-link-problem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { classifyAuthError } from "@/lib/auth-errors";
import { resolveSafeNext } from "@/lib/auth/email-link";
import { isSupabaseConfigured, supabaseUpdatePassword } from "@/lib/supabase";
import logo from "@/assets/logo.svg";
import { CheckCircle, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

export type AuthPasswordMode = "set" | "reset";

const COPY: Record<
  AuthPasswordMode,
  {
    title: string;
    description: string;
    submit: string;
    success: string;
    expiredTitle: string;
    expiredDescription: string;
  }
> = {
  set: {
    title: "Create your Atlas password",
    description:
      "Your invitation is confirmed. Choose a password to finish setting up your Atlas account.",
    submit: "Set password",
    success: "Your password is set. Taking you into Atlas…",
    expiredTitle: "This invitation link can't be used",
    expiredDescription:
      "This invitation link has expired or has already been used. Ask your Atlas administrator to send a new invitation, or sign in if you already have a password.",
  },
  reset: {
    title: "Reset your Atlas password",
    description: "Choose a new password for your Atlas account.",
    submit: "Update password",
    success: "Your password has been updated. Taking you into Atlas…",
    expiredTitle: "This reset link can't be used",
    expiredDescription:
      "This password reset link has expired or has already been used. Request a new one from the sign-in page and use the most recent email.",
  },
};

export default function AuthPassword({ mode }: { mode: AuthPasswordMode }) {
  const copy = COPY[mode];
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = resolveSafeNext(searchParams.get("next"), "/dashboard");
  const { isLoading: authLoading, isAuthenticated, signOut } = useAuth();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Leave the page promptly once the password is set — the session is already
  // established, and authorization is decided by RequireAuth, not here.
  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => navigate(next, { replace: true }), 900);
    return () => window.clearTimeout(timer);
  }, [success, next, navigate]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Those passwords don't match. Please re-enter them.");
      return;
    }

    setIsSubmitting(true);
    try {
      await supabaseUpdatePassword(password);
      setPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(classifyAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <span className="text-sm">Verifying your link…</span>
        </div>
      </main>
    );
  }

  // No session: the link was expired, already used, or opened elsewhere.
  if (!isAuthenticated) {
    return (
      <AuthLinkProblem
        title={copy.expiredTitle}
        description={copy.expiredDescription}
        primary={
          mode === "reset"
            ? { label: "Request a new reset link", to: "/auth?reset=1" }
            : { label: "Go to sign in", to: "/auth" }
        }
        secondary={
          mode === "reset"
            ? { label: "Back to sign in", to: "/auth" }
            : { label: "Request a new reset link", to: "/auth?reset=1" }
        }
      />
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex justify-center">
          <Link to="/" aria-label="Atlas home">
            <img
              src={logo}
              alt="Atlas logo"
              width={64}
              height={64}
              className="rounded-lg"
            />
          </Link>
        </div>

        <Card className="border shadow-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">
              {success ? "Password updated" : copy.title}
            </CardTitle>
            <CardDescription className="leading-relaxed">
              {success ? copy.success : copy.description}
            </CardDescription>
          </CardHeader>

          {success ? (
            <CardContent className="flex flex-col items-center gap-3 py-2">
              <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
                <CheckCircle className="size-6 text-emerald-500" />
              </div>
              <Button asChild variant="ghost" className="w-full">
                <Link to={next}>Continue to Atlas</Link>
              </Button>
            </CardContent>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="newPassword"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    New password
                  </Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="newPassword"
                      name="newPassword"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-9 pr-9"
                      disabled={isSubmitting || !isSupabaseConfigured()}
                      required
                      minLength={6}
                      autoFocus
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label
                    htmlFor="confirmPassword"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Confirm new password
                  </Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="confirmPassword"
                      name="confirmPassword"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="pl-9"
                      disabled={isSubmitting || !isSupabaseConfigured()}
                      required
                      minLength={6}
                    />
                  </div>
                </div>

                <p className="text-[11px] leading-5 text-muted-foreground">
                  Use at least 6 characters. Your password is stored only by
                  Atlas authentication — never in Atlas business data.
                </p>

                {error && <p className="text-sm text-red-500">{error}</p>}
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting || !password || !confirmPassword}
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4" />
                  )}
                  {copy.submit}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => {
                    void signOut().finally(() =>
                      navigate("/auth", { replace: true }),
                    );
                  }}
                >
                  {mode === "set" ? "Cancel and sign out" : "Sign out"}
                </Button>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
