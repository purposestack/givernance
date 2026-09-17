import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function EmergencyFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="emergency-footer">
      {data.organisationName || t("badge")} · {t("footer.poweredBy")}
    </footer>
  );
}
