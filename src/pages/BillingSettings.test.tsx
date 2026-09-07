// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BrowserRouter } from "react-router";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@/hooks/use-supabase";
import { api } from "@/lib/api";
import BillingSettings from "./BillingSettings";

vi.mock(import("react-router"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: vi.fn(),
    useLocation: actual.useLocation,
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(),
}));

// The page reads billing state through useQuery (RPC-backed). The tests
// control what the queries return so the page renders deterministically
// without a Supabase connection.
vi.mock("@/hooks/use-supabase", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

function wrapInRouter(element: ReactElement) {
  return (
    <BrowserRouter>
      {element}
    </BrowserRouter>
  );
}

describe("BillingSettings placeholder UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to the auth page with the billing returnTo", () => {
    const navigate = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigate);
    vi.mocked(useAuth).mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    vi.mocked(useQuery).mockReturnValue(undefined);

    render(wrapInRouter(<BillingSettings />));

    expect(navigate).toHaveBeenCalledWith(
      "/auth?returnTo=/settings/billing",
    );
  });

  it("renders a placeholder billing state when no provider is configured", () => {
    const navigate = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigate);
    vi.mocked(useAuth).mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    // Workspace resolves with a tenant; billing state resolves to null (no
    // subscription row yet) — the page renders the "not on a paid plan"
    // placeholder instead of spinning.
    vi.mocked(useQuery).mockImplementation((fn, _args, _options) => {
      if (fn === api.tenants.getMyWorkspace) {
        return {
          tenant: { _id: "tenant-1" },
          membership: { tenantId: "tenant-1" },
        } as never;
      }
      if (fn === api.billing.getState) {
        return null as never;
      }
      return undefined as never;
    });

    render(wrapInRouter(<BillingSettings />));

    expect(
      screen.getByRole("heading", { level: 1, name: /billing/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/manage your atlas subscription/i),
    ).toBeInTheDocument();
  });
});
