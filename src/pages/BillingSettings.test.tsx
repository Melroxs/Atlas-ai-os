// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BrowserRouter } from "react-router";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
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

    expect(
      screen.getByRole("heading", { level: 1, name: /billing/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/manage your atlas subscription/i),
    ).toBeInTheDocument();
  });
});
