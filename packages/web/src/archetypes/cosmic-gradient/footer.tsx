import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function CosmicFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="cosmic-footer">
      <span>
        {data.organisationName || t("badge")} · ▲ {t("footer.poweredBy")}
      </span>
    </footer>
  );
}
