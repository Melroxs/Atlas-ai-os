import { COMPANY_REGISTRATION_NUMBER, LEGAL_ENTITY_NAME, TRADING_NAME } from "@/lib/legal/company-identity";
import { cn } from "@/lib/utils";

/**
 * Footer attribution line stating the legal operator.
 *
 * Atlas AI OS is a trading name, not an incorporated company, so the footer
 * names the registered entity that operates it. The SARS tax number is
 * deliberately not displayed. Shared across the public footers so the wording
 * cannot drift between surfaces — the values themselves come from
 * `src/lib/legal/company-identity`.
 */
export function LegalIdentityFooter({
  className,
  tagline,
}: {
  className?: string;
  /** Optional product tagline rendered after the operator attribution. */
  tagline?: string;
}) {
  return (
    <div className={cn("text-center text-[11px] leading-relaxed text-muted-foreground/60", className)}>
      <p>
        © {new Date().getFullYear()} {LEGAL_ENTITY_NAME} t/a {TRADING_NAME}.{" "}
        Registration No. {COMPANY_REGISTRATION_NUMBER}.
        {tagline ? ` ${tagline}` : ""}
      </p>
    </div>
  );
}

export default LegalIdentityFooter;
