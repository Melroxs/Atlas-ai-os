import AuthPassword from "@/pages/AuthPassword";

/**
 * Legacy route: /reset-password.
 *
 * Supabase recovery emails were previously pointed at this path, so links that
 * are already sitting in inboxes must keep working. It now renders the shared
 * password page instead of its own implementation — one password-update code
 * path (`auth.updateUser`) for both the invitation and recovery flows, and no
 * reliance on an arbitrary timer to detect that the session has been restored
 * from the URL fragment.
 */
export default function ResetPassword() {
  return <AuthPassword mode="reset" />;
}
