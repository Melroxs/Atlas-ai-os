// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import SuperAdminOrgs from "./SuperAdminOrgs";
import { orgAdmin } from "@/lib/actions/org-admin";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/lib/actions/org-admin", () => ({
  orgAdmin: {
    listOrgs: vi.fn(),
    listOrgMembers: vi.fn(),
    listComplimentary: vi.fn(),
    createOrg: vi.fn(),
    inviteMember: vi.fn(),
    removeMember: vi.fn(),
    deleteUser: vi.fn(),
    grantComplimentary: vi.fn(),
    revokeComplimentary: vi.fn(),
  },
}));

const ORGS = [
  { _id: "org-1", name: "Example Restoration Co.", member_count: 2 },
];

const MEMBERS = [
  {
    userId: "user-1",
    role: "owner",
    status: "active",
    joinedAt: 1,
    profile: { _id: "user-1", name: "Jane Doe", email: "jane@example.com", platform_role: "user", account_status: "active" },
  },
  {
    userId: "user-2",
    role: "analyst",
    status: "active",
    joinedAt: 2,
    profile: { _id: "user-2", name: "Bob", email: "bob@example.com", platform_role: "user", account_status: "active" },
  },
];

const GRANTS = [
  {
    id: "grant-1",
    organization_id: "org-1",
    user_id: null,
    granted_by: "admin-1",
    granted_at: 1,
    expires_at: Date.now() + 30 * 86400000,
    reason: "YC demo",
    status: "active" as const,
    revoked_at: null,
    user_name: null,
    user_email: null,
  },
];

function wrapInRouter(element: ReactElement) {
  return (
    <BrowserRouter>
      {element}
      <Toaster />
    </BrowserRouter>
  );
}

function mockSuperAdmin() {
  vi.mocked(useAuth).mockReturnValue({
    role: "super_admin",
    user: { _id: "admin-1", platform_role: "super_admin", account_status: "active" },
    isLoading: false,
    isAuthenticated: true,
  } as never);
}

describe("SuperAdminOrgs", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSuperAdmin();
    vi.mocked(orgAdmin.listOrgs).mockResolvedValue({ ok: true, data: { organizations: ORGS } });
    vi.mocked(orgAdmin.listOrgMembers).mockResolvedValue({ ok: true, data: { members: MEMBERS } });
    vi.mocked(orgAdmin.listComplimentary).mockResolvedValue({ ok: true, data: { grants: GRANTS } });
    vi.mocked(orgAdmin.inviteMember).mockResolvedValue({ ok: true, data: { invitation_sent: true } });
    vi.mocked(orgAdmin.deleteUser).mockResolvedValue({ ok: true, data: { ok: true } });
    vi.mocked(orgAdmin.revokeComplimentary).mockResolvedValue({ ok: true, data: { grant: null } });
  });

  it("blocks non-super-admins at the UI level (server re-enforces)", async () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "atlas_admin",
      user: { _id: "admin-2", platform_role: "atlas_admin", account_status: "active" },
      isLoading: false,
      isAuthenticated: true,
    } as never);

    render(wrapInRouter(<SuperAdminOrgs />));

    expect(await screen.findByText("Super Admin access required")).toBeInTheDocument();
    expect(orgAdmin.listOrgs).not.toHaveBeenCalled();
  });

  it("renders organizations and their members", async () => {
    render(wrapInRouter(<SuperAdminOrgs />));

    // Org name appears in the selector AND the selected-org header
    expect((await screen.findAllByText("Example Restoration Co.")).length).toBeGreaterThan(0);
    await waitFor(() => expect(orgAdmin.listOrgMembers).toHaveBeenCalledWith("org-1"));
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    // Org-wide complimentary grant badge shown on each member row
    expect((await screen.findAllByText(/Complimentary · /)).length).toBeGreaterThan(0);
  });

  it("requires confirmation before deleting a user account", async () => {
    render(wrapInRouter(<SuperAdminOrgs />));
    await screen.findByText("Jane Doe");

    // Open the delete flow
    fireEvent.click(screen.getAllByTitle("Delete user account permanently")[0]);
    expect(
      await screen.findByText("Delete this user account permanently?"),
    ).toBeInTheDocument();

    // Cancel must NOT delete
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(orgAdmin.deleteUser).not.toHaveBeenCalled());

    // Confirm must delete via the server-side path
    fireEvent.click(screen.getAllByTitle("Delete user account permanently")[0]);
    await screen.findByText("Delete this user account permanently?");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(orgAdmin.deleteUser).toHaveBeenCalledWith("user-1"));
  });

  it("requires confirmation before revoking complimentary access", async () => {
    render(wrapInRouter(<SuperAdminOrgs />));
    await screen.findAllByText(/Complimentary · /);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(
      await screen.findByRole("heading", { name: "Revoke complimentary access?" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(orgAdmin.revokeComplimentary).not.toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await screen.findByRole("heading", { name: "Revoke complimentary access?" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(orgAdmin.revokeComplimentary).toHaveBeenCalledWith("grant-1"));
  });

  it("rejects an invalid invite email without calling the edge function", async () => {
    render(wrapInRouter(<SuperAdminOrgs />));
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getAllByRole("button", { name: /Add Team Member/ })[0]);
    await screen.findByRole("heading", { name: "Add Team Member" });

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Invitation/ }));

    expect(await screen.findByText("A valid email address is required.")).toBeInTheDocument();
    expect(orgAdmin.inviteMember).not.toHaveBeenCalled();
  });

  it("sends a valid invitation with first name, last name, email, and org role", async () => {
    render(wrapInRouter(<SuperAdminOrgs />));
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getAllByRole("button", { name: /Add Team Member/ })[0]);
    await screen.findByRole("heading", { name: "Add Team Member" });

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Alex" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alex@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Invitation/ }));

    await waitFor(() =>
      expect(orgAdmin.inviteMember).toHaveBeenCalledWith({
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.com",
        tenantId: "org-1",
        orgRole: "analyst",
      }),
    );
  });

  it("requires a reason before granting complimentary access", async () => {
    render(wrapInRouter(<SuperAdminOrgs />));
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getAllByTitle("Grant complimentary access")[0]);
    await screen.findByRole("heading", { name: "Grant Complimentary Access" });

    // Leave reason empty and submit
    fireEvent.click(screen.getByRole("button", { name: /Grant Access/ }));

    expect(await screen.findByText("A reason is required for complimentary access.")).toBeInTheDocument();
    expect(orgAdmin.grantComplimentary).not.toHaveBeenCalled();
  });
});