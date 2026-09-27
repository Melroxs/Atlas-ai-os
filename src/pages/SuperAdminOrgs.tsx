/**
 * Super Admin — Organization & Team Administration
 *
 * Strictly organization/team administration (not CRM, not Pilot). Every
 * mutating action goes through the admin-provision-user Edge Function, which
 * re-verifies super_admin server-side. Hiding buttons here is a convenience,
 * never the security boundary.
 *
 * Capabilities:
 *   - Create / view organizations
 *   - View organization members + their access status
 *   - Invite a member (first name, last name, email, organization role)
 *   - Remove a member (membership only — the Auth account stays intact)
 *   - Delete a user (permanent Auth deletion, confirmation required)
 *   - Grant / revoke complimentary access (7d, 30d, 90d, 1y, lifetime)
 */
import { PageHeader, EmptyPanel } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  Building2,
  Gift,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  PILOT_STATUS_LABELS,
  computePilotStatus,
  describePilotBilling,
  describePilotLimits,
  formatPilotExpiration,
  parsePilotExpiration,
  type PilotStatus,
} from "@/lib/admin/super-admin";
import {
  orgAdmin,
  type ComplimentaryDuration,
  type ComplimentaryGrant,
  type OrgMember,
  type OrgRole,
} from "@/lib/actions/org-admin";

const ORG_ROLES: OrgRole[] = ["owner", "admin", "manager", "analyst", "viewer"];

const DURATIONS: Array<{ value: ComplimentaryDuration; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "lifetime", label: "Lifetime" },
];

/** Create-dialog account type. Standard = normal paid-track org. */
type CreateAccountType = "standard" | "free_pilot";

const REASON_SUGGESTIONS = [
  "Pilot customer",
  "Strategic partner",
  "YC demo",
  "Investor",
  "Internal testing",
  "Promotional access",
  "Support resolution",
  "Founder-approved complimentary account",
];

interface OrgRow {
  _id: string;
  name: string | null;
  slug?: string | null;
  member_count?: number;
  /** Internal administrative classification. */
  account_type?: string | null;
  /** Derived lifecycle state, computed server-side. */
  pilot_status?: string | null;
  pilot_expires_at?: number | null;
  pilot_converted_at?: number | null;
  billing?: {
    has_stripe_subscription?: boolean | null;
    has_stripe_customer?: boolean | null;
    status?: string | null;
    internal_plan?: string | null;
  } | null;
}

function formatExpiration(expiresAt: number | null): string {
  if (expiresAt === null || expiresAt === undefined) return "Lifetime";
  return new Date(expiresAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatGrantWindow(grant: ComplimentaryGrant): string {
  if (grant.status === "revoked") return `Revoked ${formatExpiration(grant.revoked_at)}`;
  return `Expires ${formatExpiration(grant.expires_at)}`;
}

function initials(name?: string | null, email?: string | null): string {
  const src = name ?? email ?? "?";
  return (
    src
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

export default function SuperAdminOrgs() {
  const { role } = useAuth();
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [grants, setGrants] = useState<ComplimentaryGrant[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createAccountType, setCreateAccountType] = useState<CreateAccountType>("standard");
  const [createAdminEmail, setCreateAdminEmail] = useState("");
  const [createAdminName, setCreateAdminName] = useState("");
  const [createExpires, setCreateExpires] = useState("");
  const [createNotes, setCreateNotes] = useState("");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    orgRole: "analyst" as OrgRole,
  });

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantForm, setGrantForm] = useState({
    userId: "",
    duration: "30d" as ComplimentaryDuration,
    reason: "",
  });

  const [pilotExtendOpen, setPilotExtendOpen] = useState(false);
  const [pilotExtendForm, setPilotExtendForm] = useState({ expires: "", reason: "" });

  const [confirmState, setConfirmState] = useState<{
    kind:
      | "remove_member"
      | "delete_user"
      | "revoke_grant"
      | "suspend_pilot"
      | "reactivate_pilot"
      | "convert_pilot";
    title: string;
    message: string;
    /** Convert is irreversible bookkeeping; mark it destructive. */
    destructive?: boolean;
    /** Render a (required) reason field before confirming. */
    needsReason?: boolean;
    run: (reason: string) => Promise<void>;
  } | null>(null);
  const [confirmReason, setConfirmReason] = useState("");

  const selectedOrg = orgs?.find((o) => o._id === selectedOrgId) ?? null;

  const loadOrgs = useCallback(async () => {
    const res = await orgAdmin.listOrgs();
    if (!res.ok) {
      toast.error(res.error ?? "Could not load organizations.");
      setOrgs([]);
      return;
    }
    const list = res.data?.organizations ?? [];
    setOrgs(list);
    if (!selectedOrgId && list.length > 0) setSelectedOrgId(list[0]._id);
  }, [selectedOrgId]);

  const loadSelected = useCallback(async () => {
    if (!selectedOrgId) {
      setMembers(null);
      setGrants([]);
      return;
    }
    setBusy("load");
    try {
      const [mRes, gRes] = await Promise.all([
        orgAdmin.listOrgMembers(selectedOrgId),
        orgAdmin.listComplimentary(selectedOrgId),
      ]);
      if (!mRes.ok) {
        toast.error(mRes.error ?? "Could not load members.");
        return;
      }
      setMembers(mRes.data?.members ?? []);
      setGrants(gRes.ok ? (gRes.data?.grants ?? []) : []);
    } finally {
      setBusy(null);
    }
  }, [selectedOrgId]);

  // Only load data for super admins (the route guard + server also enforce).
  const isSuperAdmin = role === "super_admin";

  useEffect(() => {
    if (!isSuperAdmin) return;
    void loadOrgs();
  }, [isSuperAdmin, loadOrgs]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    void loadSelected();
  }, [isSuperAdmin, loadSelected]);

  // Server-authoritative role check (the route guard also enforces this).
  if (!isSuperAdmin) {
    return (
      <main className="p-6">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-8 text-center">
          <ShieldAlert className="size-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Super Admin access required</h1>
          <p className="text-sm text-muted-foreground">
            Organization administration is restricted to Super Admins. Every
            operation is also verified server-side.
          </p>
        </div>
      </main>
    );
  }

  /**
   * Prefer the server-derived status. Fall back to the local computation only
   * when the server value is missing (older response shape), so the UI never
   * invents a state the database did not report.
   */
  const pilotStatusOf = (org: OrgRow): PilotStatus => {
    const server = org.pilot_status;
    if (server && server in PILOT_STATUS_LABELS) return server as PilotStatus;
    return computePilotStatus(
      { account_type: org.account_type, pilot_converted_at: org.pilot_converted_at },
      // The list endpoint does not return grants; an absent grant means the
      // pilot is not active, which is the fail-closed reading.
      null,
      Date.now(),
    );
  };

  const resetCreateForm = () => {
    setCreateName("");
    setCreateAccountType("standard");
    setCreateAdminEmail("");
    setCreateAdminName("");
    setCreateExpires("");
    setCreateNotes("");
  };

  const createOrg = async () => {
    const name = createName.trim();
    if (!name) {
      toast.error("Organization name is required.");
      return;
    }

    // A Free Pilot org needs its primary admin up front: the server creates
    // the organization, the owner membership and the Free Pilot entitlement
    // together, in one audited transaction.
    if (createAccountType === "free_pilot") {
      const email = createAdminEmail.trim();
      if (!email) {
        toast.error("A primary admin email is required for a Free Pilot organization.");
        return;
      }
      const parsed = parsePilotExpiration(createExpires, Date.now());
      if (!parsed.ok) {
        toast.error(parsed.error ?? "Enter a valid pilot expiration.");
        return;
      }

      setBusy("create");
      try {
        const res = await orgAdmin.createPilotOrg({
          name,
          adminEmail: email,
          adminName: createAdminName.trim() || null,
          expiresAt: parsed.expiresAt,
          notes: createNotes.trim() || null,
        });
        if (!res.ok) {
          toast.error(res.error ?? "Could not create the pilot organization.");
          return;
        }
        toast.success(
          "Free Pilot organization created. Invite the primary admin to finish setup.",
        );
        setCreateOpen(false);
        resetCreateForm();
        setOrgs(null);
        await loadOrgs();
      } finally {
        setBusy(null);
      }
      return;
    }

    setBusy("create");
    try {
      const res = await orgAdmin.createOrg(name);
      if (!res.ok) {
        toast.error(res.error ?? "Could not create organization.");
        return;
      }
      toast.success("Organization created");
      setCreateOpen(false);
      resetCreateForm();
      setOrgs(null);
      await loadOrgs();
    } finally {
      setBusy(null);
    }
  };

  const inviteMember = async () => {
    const email = inviteForm.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("A valid email address is required.");
      return;
    }
    if (!selectedOrgId) return;
    setBusy("invite");
    try {
      const res = await orgAdmin.inviteMember({
        firstName: inviteForm.firstName,
        lastName: inviteForm.lastName,
        email,
        tenantId: selectedOrgId,
        orgRole: inviteForm.orgRole,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not send invitation.");
        return;
      }
      toast.success(
        res.data?.invitation_sent
          ? `Invitation sent to ${email}`
          : `${email} was added (invitation email could not be sent)`,
      );
      setInviteOpen(false);
      setInviteForm({ firstName: "", lastName: "", email: "", orgRole: "analyst" });
      await loadSelected();
    } finally {
      setBusy(null);
    }
  };

  const grantComplimentary = async () => {
    if (!selectedOrgId) return;
    const reason = grantForm.reason.trim();
    if (!reason) {
      toast.error("A reason is required for complimentary access.");
      return;
    }
    setBusy("grant");
    try {
      const userId = grantForm.userId === "__org_wide__" ? null : grantForm.userId || null;
      const res = await orgAdmin.grantComplimentary({
        tenantId: selectedOrgId,
        userId,
        duration: grantForm.duration,
        reason,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not grant complimentary access.");
        return;
      }
      toast.success(
        res.data?.email_sent
          ? "Complimentary access granted and notification sent"
          : "Complimentary access granted",
      );
      setGrantOpen(false);
      setGrantForm({ userId: "", duration: "30d", reason: "" });
      await loadSelected();
    } finally {
      setBusy(null);
    }
  };

  const confirmRemoveMember = (member: OrgMember) => {
    if (!selectedOrgId) return;
    setConfirmState({
      kind: "remove_member",
      title: "Remove from organization?",
      message: `${member.profile?.name ?? member.profile?.email ?? member.userId} will be removed from ${selectedOrg?.name ?? "this organization"}. Their Atlas account stays intact and they can be invited to another organization later.`,
      run: async () => {
        const res = await orgAdmin.removeMember(selectedOrgId, member.userId);
        if (!res.ok) {
          toast.error(res.error ?? "Could not remove member.");
          return;
        }
        toast.success("Member removed from organization");
        await loadSelected();
      },
    });
  };

  const confirmDeleteUser = (member: OrgMember) => {
    setConfirmState({
      kind: "delete_user",
      title: "Delete this user account permanently?",
      message: `${member.profile?.name ?? member.profile?.email ?? member.userId}'s Supabase Auth account and all associated data will be permanently deleted. This cannot be undone. The organization itself is never deleted.`,
      run: async () => {
        const res = await orgAdmin.deleteUser(member.userId);
        if (!res.ok) {
          toast.error(res.error ?? "Could not delete user.");
          return;
        }
        toast.success("User account deleted");
        await loadSelected();
        await loadOrgs();
      },
    });
  };

  const confirmRevokeGrant = (grant: ComplimentaryGrant) => {
    setConfirmState({
      kind: "revoke_grant",
      title: "Revoke complimentary access?",
      message: `Complimentary access for ${grant.user_name ?? grant.user_email ?? "this organization"} (${formatGrantWindow(grant)}) will be revoked.`,
      run: async () => {
        const res = await orgAdmin.revokeComplimentary(grant.id);
        if (!res.ok) {
          toast.error(res.error ?? "Could not revoke complimentary access.");
          return;
        }
        toast.success("Complimentary access revoked");
        await loadSelected();
      },
    });
  };

  /** Refresh both the org list (pilot_status/expiration) and the detail view. */
  const reloadAfterPilotChange = async () => {
    setOrgs(null);
    await loadOrgs();
    await loadSelected();
  };

  const openExtendPilot = () => {
    setPilotExtendForm({ expires: "", reason: "" });
    setPilotExtendOpen(true);
  };

  const submitExtendPilot = async () => {
    if (!selectedOrgId) return;
    const parsed = parsePilotExpiration(pilotExtendForm.expires, Date.now());
    if (!parsed.ok) {
      toast.error(parsed.error ?? "Enter a valid pilot expiration.");
      return;
    }
    setBusy("pilot-extend");
    try {
      const res = await orgAdmin.extendPilot({
        tenantId: selectedOrgId,
        expiresAt: parsed.expiresAt,
        reason: pilotExtendForm.reason.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not extend the pilot.");
        return;
      }
      toast.success(
        parsed.expiresAt ? "Pilot expiration updated" : "Pilot set to no expiration",
      );
      setPilotExtendOpen(false);
      await reloadAfterPilotChange();
    } finally {
      setBusy(null);
    }
  };

  const confirmSetPilotStatus = (status: "active" | "suspended") => {
    if (!selectedOrgId) return;
    const tenantId = selectedOrgId;
    const orgName = selectedOrg?.name ?? "this organization";
    setConfirmReason("");
    if (status === "suspended") {
      setConfirmState({
        kind: "suspend_pilot",
        title: "Suspend this pilot?",
        message: `${orgName} keeps its organization, members, data and Free Pilot classification, but its pilot access is revoked immediately. Reactivating later restores access; the expiration date is never silently changed.`,
        needsReason: true,
        run: async (reason) => {
          const res = await orgAdmin.setPilotStatus({
            tenantId,
            status: "suspended",
            reason: reason || null,
          });
          if (!res.ok) {
            toast.error(res.error ?? "Could not suspend the pilot.");
            return;
          }
          toast.success("Pilot suspended — data preserved");
          await reloadAfterPilotChange();
        },
      });
      return;
    }
    setConfirmState({
      kind: "reactivate_pilot",
      title: "Reactivate this pilot?",
      message: `Access is restored for ${orgName}. If a live grant still applies, its expiration is left unchanged — reactivating never silently extends a pilot.`,
      run: async (reason) => {
        const res = await orgAdmin.setPilotStatus({
          tenantId,
          status: "active",
          reason: reason || null,
        });
        if (!res.ok) {
          toast.error(res.error ?? "Could not reactivate the pilot.");
          return;
        }
        toast.success("Pilot reactivated");
        await reloadAfterPilotChange();
      },
    });
  };

  const confirmConvertPilot = () => {
    if (!selectedOrgId) return;
    const tenantId = selectedOrgId;
    const orgName = selectedOrg?.name ?? "this organization";
    setConfirmReason("");
    setConfirmState({
      kind: "convert_pilot",
      title: "Convert this pilot to a paid organization?",
      message: `This revokes ${orgName}'s Free Pilot access and marks it converted. The organization id, its members and all of its data are preserved. Only do this once the Stripe subscription is authoritative — a completed or failed checkout alone does not convert a pilot.`,
      destructive: true,
      needsReason: true,
      run: async (reason) => {
        const res = await orgAdmin.convertPilot({ tenantId, reason: reason || null });
        if (!res.ok) {
          toast.error(res.error ?? "Could not convert the pilot.");
          return;
        }
        toast.success("Pilot converted to a standard paid organization");
        await reloadAfterPilotChange();
      },
    });
  };

  const activeGrantForUser = (userId: string): ComplimentaryGrant | undefined =>
    grants.find((g) => g.status === "active" && (g.user_id === userId || g.user_id === null));

  return (
    <main className="p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Organizations"
          description="Super Admin organization and team administration"
        />
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void loadOrgs()} disabled={busy === "load"}>
            <RefreshCw className="mr-2 size-4" /> Refresh
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 size-4" /> Create Organization
          </Button>
        </div>
      </div>

      {orgs === null ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : orgs.length === 0 ? (
        <EmptyPanel
          icon={Building2}
          title="No organizations yet"
          description="Create the first organization to start managing teams."
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
          {/* Organization list */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="size-4 text-teal-600" /> Organizations
              </CardTitle>
              <CardDescription>
                Select an organization to manage its team.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {orgs.map((org) => (
                <button
                  key={org._id}
                  type="button"
                  onClick={() => setSelectedOrgId(org._id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    selectedOrgId === org._id
                      ? "border-teal-500/40 bg-teal-50 dark:bg-teal-950/40"
                      : "border-transparent hover:bg-muted"
                  }`}
                >
                  <div className="font-medium">{org.name ?? "Unnamed organization"}</div>
                  <div className="text-xs text-muted-foreground">
                    {org.member_count ?? 0} members
                  </div>
                  {org.account_type === "free_pilot" && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-teal-900 dark:bg-teal-900/50 dark:text-teal-100">
                        Free Pilot
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {PILOT_STATUS_LABELS[pilotStatusOf(org)] ?? pilotStatusOf(org)}
                        {formatPilotExpiration(org.pilot_expires_at) !== "Never" &&
                          ` \u00b7 expires ${formatPilotExpiration(org.pilot_expires_at)}`}
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Selected organization */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Users className="size-4 text-teal-600" />
                    {selectedOrg?.name ?? "Organization"}
                  </CardTitle>
                  <CardDescription>
                    Members and their access status.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setInviteOpen(true)}
                  disabled={!selectedOrgId}
                >
                  <UserPlus className="mr-2 size-4" /> Add Team Member
                </Button>
              </CardHeader>
              <CardContent>
                {busy === "load" || members === null ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                ) : members.length === 0 ? (
                  <EmptyPanel
                    icon={Users}
                    title="No members"
                    description="Invite the first team member to this organization."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-3 font-medium">Member</th>
                          <th className="pb-2 pr-3 font-medium">Organization role</th>
                          <th className="pb-2 pr-3 font-medium">Account</th>
                          <th className="pb-2 pr-3 font-medium">Access</th>
                          <th className="pb-2 text-right font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((member) => {
                          const grant = activeGrantForUser(member.userId);
                          return (
                            <tr key={member.userId} className="border-b last:border-0">
                              <td className="py-2.5 pr-3">
                                <div className="flex items-center gap-2.5">
                                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-400/15 text-xs font-semibold text-teal-600 dark:text-teal-300">
                                    {initials(
                                      member.profile?.name,
                                      member.profile?.email,
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="truncate font-medium">
                                      {member.profile?.name ?? "—"}
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">
                                      {member.profile?.email ?? "no email"}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="py-2.5 pr-3">
                                <Badge variant="secondary">{member.role}</Badge>
                              </td>
                              <td className="py-2.5 pr-3">
                                <Badge
                                  variant={
                                    member.status === "active" ? "default" : "outline"
                                  }
                                >
                                  {member.status}
                                </Badge>
                              </td>
                              <td className="py-2.5 pr-3">
                                {grant ? (
                                  <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                    <Gift className="mr-1 size-3" />
                                    Complimentary · {formatExpiration(grant.expires_at)}
                                  </Badge>
                                ) : (
                                  <Badge variant="outline">
                                    {member.profile?.account_status === "active"
                                      ? "Active"
                                      : member.profile?.account_status ?? "Pending"}
                                  </Badge>
                                )}
                              </td>
                              <td className="py-2.5 text-right">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setGrantOpen(true)}
                                    disabled={!selectedOrgId}
                                    title="Grant complimentary access"
                                  >
                                    <Gift className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => confirmRemoveMember(member)}
                                    title="Remove from organization"
                                  >
                                    <UserMinus className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => confirmDeleteUser(member)}
                                    title="Delete user account permanently"
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Free Pilot lifecycle (only for pilot organizations) */}
            {selectedOrg && selectedOrg.account_type === "free_pilot" && (
              <Card className="border-teal-500/30">
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Gift className="size-4 text-teal-600 dark:text-teal-300" /> Free Pilot lifecycle
                    </CardTitle>
                    <CardDescription>
                      Internal pilot administration. Data is never deleted by these actions.
                    </CardDescription>
                  </div>
                  <Badge
                    variant={
                      pilotStatusOf(selectedOrg) === "active" ? "default" : "outline"
                    }
                  >
                    {PILOT_STATUS_LABELS[pilotStatusOf(selectedOrg)] ?? pilotStatusOf(selectedOrg)}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Expiration</dt>
                      <dd className="font-medium">
                        {formatPilotExpiration(selectedOrg.pilot_expires_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Billing</dt>
                      <dd className="font-medium">{describePilotBilling(selectedOrg.billing)}</dd>
                    </div>
                    {selectedOrg.pilot_converted_at != null && (
                      <div>
                        <dt className="text-xs text-muted-foreground">Converted</dt>
                        <dd className="font-medium">
                          {formatPilotExpiration(selectedOrg.pilot_converted_at)}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs text-muted-foreground">Limits</dt>
                      <dd className="font-medium">{describePilotLimits()}</dd>
                    </div>
                  </dl>

                  {pilotStatusOf(selectedOrg) === "converted" ? (
                    <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                      This organization is a standard paid organization. Its paid
                      entitlement is authoritative, so pilot controls are not shown.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openExtendPilot}
                        disabled={busy !== null}
                      >
                        Extend / clear expiration
                      </Button>
                      {pilotStatusOf(selectedOrg) === "active" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-rose-600 dark:text-rose-300"
                          onClick={() => confirmSetPilotStatus("suspended")}
                          disabled={busy !== null}
                        >
                          Suspend
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"                          onClick={() => confirmSetPilotStatus("active")}
                          disabled={busy !== null}
                        >
                          Reactivate
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={confirmConvertPilot}
                        disabled={busy !== null}
                      >
                        Convert to paid
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Complimentary access */}
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Gift className="size-4 text-amber-500" /> Complimentary Access
                  </CardTitle>
                  <CardDescription>
                    Atlas-controlled entitlement — independent of Stripe billing.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setGrantOpen(true)}
                  disabled={!selectedOrgId}
                >
                  <Gift className="mr-2 size-4" /> Grant Complimentary Access
                </Button>
              </CardHeader>
              <CardContent>
                {grants.length === 0 ? (
                  <EmptyPanel
                    icon={Gift}
                    title="No complimentary grants"
                    description="Grant complimentary access to pilot customers, partners, or internal testers."
                  />
                ) : (
                  <div className="space-y-2">
                    {grants.map((grant) => (
                      <div
                        key={grant.id}
                        className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {grant.user_name ?? grant.user_email ?? "Organization-wide"}
                            </span>
                            <Badge
                              variant={grant.status === "active" ? "default" : "outline"}
                            >
                              {grant.status}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatGrantWindow(grant)}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {grant.reason}
                          </div>
                        </div>
                        {grant.status === "active" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => confirmRevokeGrant(grant)}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Create organization */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Organization</DialogTitle>
            <DialogDescription>
              Creates a new Atlas organization. Members are added afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Example Restoration Co."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="org-account-type">Account type</Label>
              <select
                id="org-account-type"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={createAccountType}
                onChange={(e) => setCreateAccountType(e.target.value as CreateAccountType)}
              >
                <option value="standard">Standard</option>
                <option value="free_pilot">Free Pilot</option>
              </select>
            </div>

            {createAccountType === "free_pilot" && (
              <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  Free Pilot organizations use the Atlas complimentary entitlement. No Stripe
                  customer, subscription, invoice or payment is created. The primary admin is
                  invited and sets their own password.
                </p>

                <div className="space-y-1.5">
                  <Label htmlFor="pilot-admin-email">Primary admin email</Label>
                  <Input
                    id="pilot-admin-email"
                    type="email"
                    value={createAdminEmail}
                    onChange={(e) => setCreateAdminEmail(e.target.value)}
                    placeholder="owner@example.com"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pilot-admin-name">Primary admin name</Label>
                  <Input
                    id="pilot-admin-name"
                    value={createAdminName}
                    onChange={(e) => setCreateAdminName(e.target.value)}
                    placeholder="Optional"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pilot-expires">Pilot expiration</Label>
                  <Input
                    id="pilot-expires"
                    type="date"
                    value={createExpires}
                    onChange={(e) => setCreateExpires(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty for no expiration — the pilot stays active until revoked.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pilot-notes">Internal notes</Label>
                  <Input
                    id="pilot-notes"
                    value={createNotes}
                    onChange={(e) => setCreateNotes(e.target.value)}
                    placeholder="Not shown to the customer"
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createOrg()} disabled={busy === "create"}>
              {busy === "create" && <Loader2 className="mr-2 size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite team member */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Team Member</DialogTitle>
            <DialogDescription>
              Invite a person to {selectedOrg?.name ?? "this organization"}. The
              invitation email is sent automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="first-name">First name</Label>
              <Input
                id="first-name"
                value={inviteForm.firstName}
                onChange={(e) =>
                  setInviteForm((f) => ({ ...f, firstName: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="last-name">Last name</Label>
              <Input
                id="last-name"
                value={inviteForm.lastName}
                onChange={(e) =>
                  setInviteForm((f) => ({ ...f, lastName: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={inviteForm.email}
              onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="teammate@company.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Organization role</Label>
            <Select
              value={inviteForm.orgRole}
              onValueChange={(v) =>
                setInviteForm((f) => ({ ...f, orgRole: v as OrgRole }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORG_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Organization roles only — this workflow never grants platform
              admin privileges.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void inviteMember()} disabled={busy === "invite"}>
              {busy === "invite" && <Loader2 className="mr-2 size-4 animate-spin" />}
              <Mail className="mr-2 size-4" /> Send Invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Grant complimentary access */}
      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant Complimentary Access</DialogTitle>
            <DialogDescription>
              Grants Atlas access independent of Stripe billing. Complimentary
              access never creates Stripe records.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Member (optional)</Label>
              <Select
                value={grantForm.userId}
                onValueChange={(v) => setGrantForm((f) => ({ ...f, userId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Entire organization" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__org_wide__">Entire organization</SelectItem>
                  {(members ?? []).map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.profile?.name ?? m.profile?.email ?? m.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Access duration</Label>
              <Select
                value={grantForm.duration}
                onValueChange={(v) =>
                  setGrantForm((f) => ({ ...f, duration: v as ComplimentaryDuration }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-reason">Reason (required)</Label>
              <Textarea
                id="grant-reason"
                value={grantForm.reason}
                onChange={(e) => setGrantForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="e.g. Pilot customer, Strategic partner, Internal testing…"
                rows={2}
              />
              <div className="flex flex-wrap gap-1.5">
                {REASON_SUGGESTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setGrantForm((f) => ({ ...f, reason: r }))}
                    className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void grantComplimentary()} disabled={busy === "grant"}>
              {busy === "grant" && <Loader2 className="mr-2 size-4 animate-spin" />}
              <Gift className="mr-2 size-4" /> Grant Access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extend / clear pilot expiration */}
      <Dialog open={pilotExtendOpen} onOpenChange={setPilotExtendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend pilot</DialogTitle>
            <DialogDescription>
              Choose a new expiration date for {selectedOrg?.name ?? "this pilot"}, or leave
              it empty for no expiration. A past date is rejected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pilot-extend-expires">New expiration</Label>
              <Input
                id="pilot-extend-expires"
                type="date"
                value={pilotExtendForm.expires}
                onChange={(e) =>
                  setPilotExtendForm((f) => ({ ...f, expires: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Empty means no expiration — the pilot stays active until revoked.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pilot-extend-reason">Reason (optional)</Label>
              <Textarea
                id="pilot-extend-reason"
                rows={2}
                value={pilotExtendForm.reason}
                onChange={(e) =>
                  setPilotExtendForm((f) => ({ ...f, reason: e.target.value }))
                }
                placeholder="e.g. Pilot extended for 30 more days"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPilotExtendOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitExtendPilot()} disabled={busy === "pilot-extend"}>
              {busy === "pilot-extend" && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save expiration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation dialog (remove / delete / revoke / suspend / convert) */}
      <Dialog
        open={confirmState !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmState(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmState?.title}</DialogTitle>
            <DialogDescription>{confirmState?.message}</DialogDescription>
          </DialogHeader>
          {confirmState?.needsReason && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-reason">Reason (recommended)</Label>
              <Textarea
                id="confirm-reason"
                rows={2}
                value={confirmReason}
                onChange={(e) => setConfirmReason(e.target.value)}
                placeholder="Recorded in the audit log"
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmState(null)}>
              Cancel
            </Button>
            <Button
              variant={
                confirmState?.destructive || confirmState?.kind === "delete_user"
                  ? "destructive"
                  : "default"
              }
              onClick={() => {
                const run = confirmState?.run;
                const reason = confirmReason.trim();
                setConfirmState(null);
                if (run) void run(reason);
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}