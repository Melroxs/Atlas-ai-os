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
    deleteOrganization: vi.fn(),
    grantComplimentary: vi.fn(),
    revokeComplimentary: vi.fn(),
    extendPilot: vi.fn(),
    setPilotStatus: vi.fn(),
    convertPilot: vi.fn(),
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
    vi.mocked(orgAdmin.deleteOrganization).mockResolvedValue({
      ok: true,
      data: { members: 2, storage_removed: 0, users_deleted: 0 },
    });
    vi.mocked(orgAdmin.revokeComplimentary).mockResolvedValue({ ok: true, data: { grant: null } });
    vi.mocked(orgAdmin.extendPilot).mockResolvedValue({ ok: true, data: { status: "active" } });
    vi.mocked(orgAdmin.setPilotStatus).mockResolvedValue({ ok: true, data: { status: "suspended" } });
    vi.mocked(orgAdmin.convertPilot).mockResolvedValue({ ok: true, data: { account_type: "standard" } });
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

  describe("organization deletion", () => {
    async function openDeleteDialog() {
      render(wrapInRouter(<SuperAdminOrgs />));
      await screen.findByText("Jane Doe");
      fireEvent.click(screen.getByRole("button", { name: /Delete organization/ }));
      return screen.findByRole("heading", { name: /Permanently delete Example Restoration Co\./ });
    }

    it("never deletes without a reason and the exact organization name typed", async () => {
      await openDeleteDialog();

      const confirm = screen.getByRole("button", { name: "Confirm" });
      // Both the reason and the typed name start empty, so Confirm is inert.
      expect(confirm).toBeDisabled();

      // A reason alone is still not enough.
      fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "duplicate org" } });
      expect(confirm).toBeDisabled();
      await waitFor(() => expect(orgAdmin.deleteOrganization).not.toHaveBeenCalled());

      // A wrong name is still not enough.
      fireEvent.change(screen.getByLabelText(/Type Example Restoration Co\./), {
        target: { value: "Example Restoration" },
      });
      expect(confirm).toBeDisabled();
      await waitFor(() => expect(orgAdmin.deleteOrganization).not.toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText(/Type Example Restoration Co\./), {
        target: { value: "Example Restoration Co." },
      });
      await waitFor(() => expect(confirm).toBeEnabled());
    });

    it("sends the tenant, reason and typed name to the server, keeping user accounts by default", async () => {
      await openDeleteDialog();

      fireEvent.change(screen.getByLabelText(/Reason/), {
        target: { value: "  duplicate of org-9  " },
      });
      fireEvent.change(screen.getByLabelText(/Type Example Restoration Co\./), {
        target: { value: "Example Restoration Co." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      await waitFor(() =>
        expect(orgAdmin.deleteOrganization).toHaveBeenCalledWith({
          tenantId: "org-1",
          reason: "duplicate of org-9",
          confirmName: "Example Restoration Co.",
          deleteUsers: false,
        }),
      );
    });

    it("deletes the member accounts only when the operator opts in", async () => {
      await openDeleteDialog();

      fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "offboarding" } });
      fireEvent.change(screen.getByLabelText(/Type Example Restoration Co\./), {
        target: { value: "Example Restoration Co." },
      });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      await waitFor(() =>
        expect(orgAdmin.deleteOrganization).toHaveBeenCalledWith(
          expect.objectContaining({ deleteUsers: true }),
        ),
      );
    });

    it("cancelling the dialog never calls the server", async () => {
      await openDeleteDialog();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(orgAdmin.deleteOrganization).not.toHaveBeenCalled());
    });
  });
});

// ---------------------------------------------------------------------------
// Free Pilot lifecycle controls
// ---------------------------------------------------------------------------

function pilotOrg(pilot_status: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: "org-1",
    name: "Pilot Restoration Co.",
    member_count: 1,
    account_type: "free_pilot",
    pilot_status,
    pilot_expires_at: Date.now() + 30 * 86400000,
    pilot_converted_at: null,
    billing: { has_stripe_subscription: false, has_stripe_customer: false, status: null },
    ...overrides,
  };
}

describe("SuperAdminOrgs — Free Pilot lifecycle", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSuperAdmin();
    vi.mocked(orgAdmin.listOrgMembers).mockResolvedValue({ ok: true, data: { members: MEMBERS } });
    vi.mocked(orgAdmin.listComplimentary).mockResolvedValue({ ok: true, data: { grants: GRANTS } });
    vi.mocked(orgAdmin.extendPilot).mockResolvedValue({ ok: true, data: { status: "active" } });
    vi.mocked(orgAdmin.setPilotStatus).mockResolvedValue({ ok: true, data: { status: "suspended" } });
    vi.mocked(orgAdmin.convertPilot).mockResolvedValue({ ok: true, data: { account_type: "standard" } });
  });

  async function renderPilot(status: string, overrides: Record<string, unknown> = {}) {
    vi.mocked(orgAdmin.listOrgs).mockResolvedValue({
      ok: true,
      data: { organizations: [pilotOrg(status, overrides)] },
    });
    render(wrapInRouter(<SuperAdminOrgs />));
    await screen.findByText("Free Pilot lifecycle");
  }

  it("shows Extend, Suspend and Convert for an active pilot", async () => {
    await renderPilot("active");
    expect(screen.getByRole("button", { name: /Extend \/ clear expiration/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Convert to paid" })).toBeInTheDocument();
  });

  it("shows Reactivate (not Suspend) and Convert for an expired pilot", async () => {
    await renderPilot("expired");
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Convert to paid" })).toBeInTheDocument();
  });

  it("shows no pilot controls for a converted organization", async () => {
    await renderPilot("converted", { pilot_converted_at: Date.now() - 1000 });
    expect(await screen.findByText(/paid entitlement is authoritative/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Extend \/ clear expiration/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Convert to paid/ })).not.toBeInTheDocument();
  });

  it("requires confirmation before suspending a pilot", async () => {
    await renderPilot("active");
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(
      await screen.findByRole("heading", { name: "Suspend this pilot?" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(orgAdmin.setPilotStatus).toHaveBeenCalledWith({
        tenantId: "org-1",
        status: "suspended",
        reason: null,
      }),
    );
  });

  it("reactivates an expired pilot through the confirmation dialog", async () => {
    await renderPilot("expired");
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    await screen.findByRole("heading", { name: "Reactivate this pilot?" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(orgAdmin.setPilotStatus).toHaveBeenCalledWith({
        tenantId: "org-1",
        status: "active",
        reason: null,
      }),
    );
  });

  it("requires confirmation before converting a pilot to paid", async () => {
    await renderPilot("active");
    fireEvent.click(screen.getByRole("button", { name: "Convert to paid" }));
    expect(
      await screen.findByRole("heading", { name: "Convert this pilot to a paid organization?" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(orgAdmin.convertPilot).toHaveBeenCalledWith({
        tenantId: "org-1",
        reason: null,
      }),
    );
  });

  it("sends a new expiration when extending a pilot", async () => {
    await renderPilot("active");
    fireEvent.click(screen.getByRole("button", { name: /Extend \/ clear expiration/ }));
    await screen.findByRole("heading", { name: "Extend pilot" });

    const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    fireEvent.change(screen.getByLabelText("New expiration"), { target: { value: future } });
    fireEvent.click(screen.getByRole("button", { name: /Save expiration/ }));

    await waitFor(() => expect(orgAdmin.extendPilot).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(orgAdmin.extendPilot).mock.calls[0][0];
    expect(arg.tenantId).toBe("org-1");
    expect(arg.expiresAt).toBe(Date.UTC(Number(future.slice(0, 4)), Number(future.slice(5, 7)) - 1, Number(future.slice(8, 10)), 23, 59, 59, 999));
});
});
