import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function ActivistFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="activist-footer">
      <span>{data.organisationName || "Mobilise"}</span>
      <span>★ {t("footer.poweredBy")}</span>
    </footer>
  );
}
