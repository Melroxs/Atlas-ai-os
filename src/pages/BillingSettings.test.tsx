import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import BillingSettings from "./BillingSettings";

vi.mock("react-router", () => {
  const actual = vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: vi.fn(),
    useLocation: actual.useLocation,
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(),
}));

function wrapInRouter(element: React.ReactElement) {
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

    render(wrapInRouter(<BillingSettings />));

    expect(screen.getByRole("heading", { name: /billing/i })).toBeInTheDocument();
    expect(
      screen.getByText(/manage your atlas subscription/i),
    ).toBeInTheDocument();
  });
});
