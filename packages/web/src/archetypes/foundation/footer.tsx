import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

/**
 * Foundation `Footer` slot — institutional signature. A non-
 * decorative line of text that names the operator's legal entity
 * (constructed by the operator at registration; not implemented
 * yet but the slot is the place it'll land).
 *
 * The "Powered by Givernance" attribution is owned by the shell,
 * not by the archetype — Givernance has one attribution surface,
 * not ten. ADR-030 § Decision.
 */
export function FoundationFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="mt-9 border-t border-outline-variant pt-6 text-xs leading-relaxed text-on-surface-variant">
      <p className="max-w-prose">
        {t.rich("footer.institutionalSignature", {
          org: () => <span className="font-medium text-on-surface">{data.organisationName}</span>,
        })}
      </p>
    </footer>
  );
}
