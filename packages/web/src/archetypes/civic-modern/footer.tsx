import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function CivicFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="civic-footer">
      {data.organisationName || t("badge")} · {t("footer.poweredBy")}
    </footer>
  );
}
