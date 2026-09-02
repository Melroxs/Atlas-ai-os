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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { classifyAuthError, isExistingAccountError } from "@/lib/auth-errors";
import {
  isSupabaseConfigured,
  supabaseSendPasswordReset,
  supabaseSignIn,
  supabaseSignUp,
  supabaseUpdatePassword,
} from "@/lib/supabase";
import { useMutation } from "@/hooks/use-supabase";
import logo from "@/assets/logo.svg";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogIn,
  Mail,
  UserPlus,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

type Mode = "signIn" | "signUp";

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn, lastEvent } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  // Read initial mode from query params (e.g., mode=signup from Pricing CTA)
  const initialMode: Mode = (() => {
    const m = searchParams.get("mode");
    if (m === "signUp" || m === "signup" || m === "sign-up") return "signUp";
    if (m === "signIn" || m === "signin" || m === "sign-in") return "signIn";
    return "signIn";
  })();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const initForCheckout = useMutation(api.tenants.initForCheckout);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // When signup fails because the email already has an account, offer a direct
  // path to the login flow instead of leaving the user at a dead end.
  const [existingAccount, setExistingAccount] = useState(false);

  const supabaseClientConfigured = isSupabaseConfigured();

  // Detect Supabase PASSWORD_RECOVERY event (user clicked the recovery email
  // link and the Supabase client extracted the session from the URL hash).
  useEffect(() => {
    if (lastEvent === "PASSWORD_RECOVERY") {
      setRecovering(true);
    }
  }, [lastEvent]);

  useEffect(() => {
    if (!authLoading && isAuthenticated && !recovering) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, recovering, navigate, redirect]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signUp") {
        const { needsEmailConfirmation } = await supabaseSignUp({
          email,
          password,
          name,
        });
        if (needsEmailConfirmation) {
          // Supabase email confirmation is enabled — the user must confirm
          // before their account can be used.
          setNotice(
            `Almost there! We sent a confirmation link to ${email.trim()}. ` +
              "Click it to activate your account, then sign in.",
          );
          setIsLoading(false);
          return;
        }
        // Account created and session active. Provision the Atlas workspace
        // (tenant + owner membership + company profile) right away so the
        // user lands inside Atlas instead of a dead end. The RPC is
        // idempotent for existing members; if it ever fails we surface the
        // reason AND hand off to /setup (which retries the same idempotent
        // RPC), so the company name the user typed is never lost.
        if (companyName.trim()) {
          try {
            // Use initForCheckout instead of createTenant so the tenant
            // is created with billing_state = 'pending_checkout', which
            // the access gate uses to enforce subscription-based access.
            const initResult = await initForCheckout({ name: companyName.trim() });
            console.info(
              "[auth] workspace initialized for checkout:",
              initResult?.tenantId,
              initResult?.alreadyExisted ? "(existing)" : "(new)",
            );
          } catch (provisionError) {
            console.warn(
              "[auth] workspace auto-provision failed, /checkout will retry it:",
              provisionError,
            );
            const provisionMsg =
              provisionError instanceof Error
                ? provisionError.message
                : String(provisionError ?? "unknown error");
            setNotice(
              `Your account is ready, but Atlas couldn't create the workspace yet: ` +
                `${provisionMsg} You'll finish creating it on the next screen.`,
            );
            // /checkout's initForCheckout retries the same idempotent RPC,
            // so a failure here is recoverable — carry the name.
            navigate(
              `/checkout?plan=${searchParams.get("plan") || "starter"}&billing=${searchParams.get("billing") || "monthly"}&company=${encodeURIComponent(companyName.trim())}`,
            );
            setIsLoading(false);
            return;
          }
        }
      } else {
        await supabaseSignIn(email, password);
      }
      navigate(redirect);
    } catch (err) {
      console.error("Auth error:", err);
      setError(classifyAuthError(err));
      setExistingAccount(isExistingAccountError(err));
      setIsLoading(false);
    }
  };

  const switchToSignIn = () => {
    setMode("signIn");
    setError(null);
    setNotice(null);
    setExistingAccount(false);
  };

  const handleReset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setNotice(null);
    try {
      await supabaseSendPasswordReset(email);
      setNotice(
        `If an account exists for ${email}, a password reset link is on its way. Check your inbox.`,
      );
      setResetting(false);
    } catch (err) {
      console.error("Password reset error:", err);
      setError(classifyAuthError(err));
      setExistingAccount(isExistingAccountError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdatePassword = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (newPassword !== confirmPassword) {
        throw new Error("Passwords do not match.");
      }
      if (newPassword.length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }
      await supabaseUpdatePassword(newPassword);
      setNotice(
        "Your password has been updated. Redirecting to Atlas…",
      );
      setRecovering(false);
      setNewPassword("");
      setConfirmPassword("");
      // Give the user a moment to read the notice, then navigate.
      setTimeout(() => navigate(redirect), 1500);
    } catch (err) {
      console.error("Password update error:", err);
      setError(classifyAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const companyInput = (
    <div className="space-y-1.5">
      <Label
        htmlFor="company"
        className="text-xs font-medium text-muted-foreground"
      >
        Company / workspace name
      </Label>
      <div className="relative">
        <Building2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="company"
          name="company"
          type="text"
          autoComplete="organization"
          placeholder="e.g. Northshore Restoration Inc."
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className="pl-9"
          disabled={isLoading || !supabaseClientConfigured}
        />
      </div>
    </div>
  );

  const emailInput = (
    <div className="space-y-1.5">
      <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">
        Email
      </Label>
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="pl-9"
          disabled={isLoading || !supabaseClientConfigured}
          required
        />
      </div>
    </div>
  );

  const passwordInput = (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label
          htmlFor="password"
          className="text-xs font-medium text-muted-foreground"
        >
          Password
        </Label>
        {mode === "signIn" && (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => setResetting((r) => !r)}
            disabled={isLoading}
          >
            Forgot password?
          </Button>
        )}
      </div>
      <div className="relative">
        <Input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete={mode === "signUp" ? "new-password" : "current-password"}
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="pr-9"
          disabled={isLoading || !supabaseClientConfigured}
          required
          minLength={mode === "signUp" ? 6 : undefined}
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
  );

  const statusBanner = !supabaseClientConfigured ? (
    <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-left text-xs leading-5 text-amber-800 dark:text-amber-200">
      <AlertTriangle className="mr-1.5 inline size-3.5 -translate-y-px" />
      Email sign-in isn't configured for this deployment yet. Ask the
      administrator to add the{" "}
      <code className="font-mono">VITE_SUPABASE_URL</code> and{" "}
      <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> project keys.
    </div>
  ) : null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Auth Content */}
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center justify-center h-full flex-col">
          <Card className="min-w-[350px] pb-0 border shadow-md">
            <CardHeader className="text-center">
              <div className="flex justify-center">
                <img
                  src={logo}
                  alt="Atlas logo"
                  width={64}
                  height={64}
                  className="rounded-lg mb-4 mt-4 cursor-pointer"
                  onClick={() => navigate("/")}
                />
              </div>
              <CardTitle className="text-xl">
                {recovering
                  ? "Set your new password"
                  : resetting
                    ? "Reset your password"
                    : "Welcome to Atlas"}
              </CardTitle>
              <CardDescription>
                {recovering
                  ? "Your identity is verified. Choose a strong new password."
                  : resetting
                    ? "We'll email you a link to set a new password"
                    : mode === "signIn"
                      ? "Sign in to your workspace"
                      : "Create your account and workspace"}
              </CardDescription>
              {statusBanner}
            </CardHeader>

            {recovering ? (
              <form onSubmit={handleUpdatePassword}>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Enter your new password below.
                  </p>
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
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="pl-9 pr-9"
                        disabled={isLoading}
                        required
                        minLength={6}
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
                        disabled={isLoading}
                        required
                        minLength={6}
                      />
                    </div>
                  </div>
                  {error && (
                    <p className="mt-2 text-sm text-red-500">{error}</p>
                  )}
                  {notice && (
                    <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300">
                      {notice}
                    </p>
                  )}
                </CardContent>
                <CardFooter>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isLoading || !newPassword || !confirmPassword}
                  >
                    {isLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-4 w-4" />
                    )}
                    Update password
                  </Button>
                </CardFooter>
              </form>
            ) : resetting ? (
              <form onSubmit={handleReset}>
                <CardContent className="space-y-4">
                  {emailInput}
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      setResetting(false);
                      setError(null);
                      setNotice(null);
                    }}
                    disabled={isLoading}
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back to sign in
                  </Button>
                  {error && (
                    <p className="mt-2 text-sm text-red-500">{error}</p>
                  )}
                  {notice && (
                    <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300">
                      {notice}
                    </p>
                  )}
                </CardContent>
                <CardFooter>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isLoading || !supabaseClientConfigured || !email}
                  >
                    {isLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-4 w-4" />
                    )}
                    Send reset link
                  </Button>
                </CardFooter>
              </form>
            ) : (
              <>
                <Tabs
                  value={mode}
                  onValueChange={(v) => {
                    setMode(v as Mode);
                    setError(null);
                    setNotice(null);
                    setExistingAccount(false);
                  }}
                  className="px-6"
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="signIn" className="flex-1">
                      <LogIn className="h-4 w-4" />
                      Sign in
                    </TabsTrigger>
                    <TabsTrigger value="signUp" className="flex-1">
                      <UserPlus className="h-4 w-4" />
                      Create account
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                <form onSubmit={handleSubmit}>
                  <CardContent className="space-y-4">
                    {mode === "signUp" && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="name"
                          className="text-xs font-medium text-muted-foreground"
                        >
                          Full name
                        </Label>
                        <Input
                          id="name"
                          name="name"
                          type="text"
                          autoComplete="name"
                          placeholder="Alex Rivera"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          disabled={isLoading || !supabaseClientConfigured}
                        />
                      </div>
                    )}
                    {emailInput}
                    {passwordInput}
                    {mode === "signUp" && companyInput}
                    {error && (
                      <p className="mt-2 text-sm text-red-500">{error}</p>
                    )}
                    {existingAccount && mode === "signUp" && (
                      <button
                        type="button"
                        onClick={switchToSignIn}
                        className="mt-1 text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
                      >
                        Sign in to this account instead
                      </button>
                    )}
                    {notice && (
                      <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300">
                        {notice}
                      </p>
                    )}

                    {mode === "signIn" && (
                      <div className="text-center">
                        <p className="text-sm text-muted-foreground">
                          Don't have an Atlas account?{' '}
                          <button
                            type="button"
                            onClick={() => {
                              navigate("/pricing");
                            }}
                            className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
                          >
                            Sign Up for Atlas
                          </button>
                        </p>
                      </div>
                    )}
                  </CardContent>
                  <CardFooter>
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={
                        isLoading ||
                        !supabaseClientConfigured ||
                        !email ||
                        !password
                      }
                    >
                      {isLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : mode === "signUp" ? (
                        <UserPlus className="mr-2 h-4 w-4" />
                      ) : (
                        <LogIn className="mr-2 h-4 w-4" />
                      )}
                      {mode === "signUp" ? "Create account" : "Sign in"}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </CardFooter>
                </form>
              </>
            )}
          </Card>
        </div>
      </div>

      <div className="py-4 px-6 text-xs text-center text-muted-foreground">
        Secured by{" "}
        <a
          href="https://freebuff.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-primary transition-colors"
        >
          freebuff.com
        </a>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
