import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function CalmFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  // Lowercase voice comes from `.calm-footer { text-transform }`, not the string.
  return (
    <footer className="calm-footer">
      {data.organisationName || "respire"} · ✦ {t("footer.poweredBy")}
    </footer>
  );
}
