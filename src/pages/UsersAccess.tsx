import { api } from "@/lib/api";
import { useQuery, useMutation } from "@/hooks/use-supabase";
import { provisionUserViaEdge } from "@/lib/actions/provision-user";
import { PageHeader } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Shield, Search, Users, RefreshCw, UserPlus } from "lucide-react";
import { useState, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";

const ROLES = [
  { value: "super_admin", label: "Super Admin", color: "destructive" },
  { value: "atlas_admin", label: "Atlas Admin", color: "default" },
  { value: "customer_admin", label: "Customer Admin", color: "secondary" },
  { value: "customer_user", label: "Customer User", color: "secondary" },
  { value: "pilot_user", label: "Pilot User", color: "outline" },
  { value: "user", label: "User", color: "outline" },
] as const;

const STATUSES = [
  { value: "active", label: "Active", color: "default" },
  { value: "pending", label: "Pending", color: "secondary" },
  { value: "suspended", label: "Suspended", color: "destructive" },
  { value: "revoked", label: "Revoked", color: "destructive" },
] as const;

interface UserRow {
  _id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  platform_role: string | null;
  account_status: string | null;
  company_name: string | null;
  created_at: string | null;
  membership: {
    tenant_id: string;
    role: string;
    tenant_name: string;
  } | null;
}

function roleBadgeVariant(role: string): "destructive" | "default" | "secondary" | "outline" {
  const found = ROLES.find((r) => r.value === role);
  return (found?.color ?? "outline") as "destructive" | "default" | "secondary" | "outline";
}

function statusBadgeVariant(status: string): "destructive" | "default" | "secondary" | "outline" {
  const found = STATUSES.find((s) => s.value === status);
  return (found?.color ?? "outline") as "destructive" | "default" | "secondary" | "outline";
}

export default function UsersAccess() {
  const { role: myRole } = useAuth();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("customer_user");
  const [inviteStatus, setInviteStatus] = useState("active");
  const [inviteCompany, setInviteCompany] = useState("");

  const users = useQuery(
    api.admin.listUsers,
    {
      search: search || undefined,
      role: roleFilter === "all" ? undefined : roleFilter,
      status: statusFilter === "all" ? undefined : statusFilter,
      limit: 100,
    },
  );

  const updateUserRole = useMutation(api.admin.updateUserRole);
  const updateUserStatus = useMutation(api.admin.updateUserStatus);
  const updateUserCompany = useMutation(api.admin.updateUserCompany);
  const handleUpdateRole = useCallback(async () => {
    if (!editingUser || !editRole) return;
    try {
      await updateUserRole({ userId: editingUser._id, newRole: editRole });
      toast.success(`Role updated to ${editRole}`);
      setEditingUser(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update role");
    }
  }, [editingUser, editRole, updateUserRole]);

  const handleUpdateStatus = useCallback(async () => {
    if (!editingUser || !editStatus) return;
    try {
      await updateUserStatus({ userId: editingUser._id, newStatus: editStatus });
      toast.success(`Status updated to ${editStatus}`);
      setEditingUser(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update status");
    }
  }, [editingUser, editStatus, updateUserStatus]);

  const handleUpdateCompany = useCallback(async () => {
    if (!editingUser) return;
    try {
      await updateUserCompany({ userId: editingUser._id, newCompany: editCompany || null });
      toast.success(editCompany ? `Company updated to ${editCompany}` : "Company cleared");
      setEditingUser(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update company");
    }
  }, [editingUser, editCompany, updateUserCompany]);

  const handleInvite = useCallback(async () => {
    if (!inviteEmail) {
      toast.error("Email is required");
      return;
    }
    try {
      const result = await provisionUserViaEdge({
        email: inviteEmail,
        name: inviteName || undefined,
        role: inviteRole,
        status: inviteStatus,
        companyName: inviteCompany || undefined,
      });
      if (!result.ok) {
        toast.error(result.error || "Failed to provision user");
        return;
      }
      if (result.warning) {
        toast.warning(result.message || "User created with warnings", {
          description: result.warning,
        });
      } else {
        toast.success(result.message || "User provisioned successfully", {
          description: result.invitation_sent
            ? `Invitation email sent to ${inviteEmail}`
            : result.action === "existing_user_provisioned"
              ? "Existing user has been provisioned"
              : undefined,
        });
      }
      setShowInvite(false);
      setInviteEmail("");
      setInviteName("");
      setInviteRole("customer_user");
      setInviteStatus("active");
      setInviteCompany("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to provision user");
    }
  }, [inviteEmail, inviteName, inviteRole, inviteStatus, inviteCompany]);

  // NOTE: Route-level access control is handled by RequireInternalAuth.
  // This component no longer redirects — it trusts the route guard.

  const userList = Array.isArray(users) ? users : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & Access"
        description="Manage Atlas users, roles, and account status"
        actions={
          <Button
            size="sm"
            onClick={() => setShowInvite(true)}
            className="gap-2"
          >
            <UserPlus className="size-4" />
            Invite User
          </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            {ROLES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSearch("");
            setRoleFilter("all");
            setStatusFilter("all");
          }}
        >
          <RefreshCw className="mr-2 size-3" />
          Reset
        </Button>
      </div>

      {/* Users table */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {userList.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  <Users className="mx-auto mb-2 size-8 opacity-40" />
                  <p>No users found</p>
                </TableCell>
              </TableRow>
            ) : (
              userList.map((u) => (
                <TableRow key={u._id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                        {(u.name ?? u.email ?? "?")[0]?.toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{u.name ?? "Unknown"}</p>
                        <p className="text-xs text-muted-foreground">{u.email ?? ""}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={roleBadgeVariant(u.platform_role ?? "user")}>
                      {u.platform_role ?? "user"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(u.account_status ?? "pending")}>
                      {u.account_status ?? "pending"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {u.membership?.tenant_name ?? u.company_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingUser(u as UserRow);
                        setEditRole((u as UserRow).platform_role ?? "user");
                        setEditStatus((u as UserRow).account_status ?? "pending");
                        setEditCompany((u as UserRow).company_name ?? "");
                      }}
                    >
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        {userList.length} user{userList.length === 1 ? "" : "s"} found
      </p>

      {/* Invite / Invite User dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
            <DialogDescription>
              Provision a new user or activate an existing Supabase Auth user into Atlas.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Email *</label>
              <Input
                type="email"
                placeholder="user@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="Jane Smith"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Company</label>
              <Input
                placeholder="ABC Roofing"
                value={inviteCompany}
                onChange={(e) => setInviteCompany(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Role</label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {myRole === "super_admin"
                    ? ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))
                    : ROLES.filter((r) => !["super_admin", "atlas_admin"].includes(r.value)).map(
                        (r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ),
                      )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Status</label>
              <Select value={inviteStatus} onValueChange={setInviteStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setShowInvite(false)}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={!inviteEmail}>
              Provision User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit user dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update role, status, or company for {editingUser?.name ?? editingUser?.email ?? "this user"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Platform Role</label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {myRole === "super_admin"
                    ? ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))
                    : ROLES.filter((r) => !["super_admin", "atlas_admin"].includes(r.value)).map(
                        (r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ),
                      )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Account Status</label>
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Company</label>
              <Input
                placeholder="Company name"
                value={editCompany}
                onChange={(e) => setEditCompany(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setEditingUser(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={handleUpdateCompany}
              disabled={editCompany === (editingUser?.company_name ?? "")}
            >
              Update Company
            </Button>
            <Button
              variant="destructive"
              onClick={handleUpdateStatus}
              disabled={editStatus === (editingUser?.account_status ?? "pending")}
            >
              Update Status
            </Button>
            <Button onClick={handleUpdateRole}>
              Update Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
