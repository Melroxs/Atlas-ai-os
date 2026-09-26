import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const landing = readFileSync(resolve(here, "Landing.tsx"), "utf8");
const main = readFileSync(resolve(here, "../main.tsx"), "utf8");

describe("Landing pricing wiring", () => {
  it("renders a pricing section from the canonical billing catalog", () => {
    expect(landing).toContain('id="pricing"');
    expect(landing).toContain('from "@/lib/billing/checkout"');
    expect(landing).toContain("allPricingPlans(");
    expect(landing).toContain("planFeatureLines(");
    // The plan CTA must carry only plan + interval through the shared helper.
    expect(landing).toContain("checkoutReturnTo({ plan: plan.slug, interval: billing })");
  });

  it("sends signed-out buyers through /auth preserving plan + interval", () => {
    expect(landing).toContain('mode: "signup"');
    expect(landing).toContain("navigate(`/auth?${params.toString()}`)");
    // Signed-in buyers go straight to the checkout return path.
    expect(landing).toContain("navigate(returnTo)");
  });

  it("never hardcodes a plan price on the landing page", () => {
    for (const stale of ["$10", "$40", "$120", "$100", "$400", "$1,200"]) {
      expect(landing).not.toContain(stale);
    }
  });
});

describe("Landing blog links", () => {
  it("links Blog from the desktop and mobile navigation", () => {
    // NAV_LINKS is rendered by both the desktop and mobile nav, and internal
    // routes go through React Router's Link.
    expect(landing).toContain('{ label: "Blog", href: "/blog" }');
    expect(landing).toContain("<Link");
  });

  it("links Blog from the footer and routes internal links through the router", () => {
    expect(landing).toContain('["Blog", "/blog"]');
    // Internal footer routes render through <Link>, never a raw anchor reload.
    expect(landing).toContain('href.startsWith("/") ? (');
  });
});

describe("public blog routes", () => {
  it("registers /blog and /blog/:slug for the real blog pages", () => {
    expect(main).toContain('<Route path="/blog" element={<Blog />} />');
    expect(main).toContain('<Route path="/blog/:slug" element={<BlogPost />} />');
  });

  it("points the auth fallback at the authenticated destination, not the landing page", () => {
    expect(main).toContain('redirectAfterAuth="/dashboard"');
  });
});
