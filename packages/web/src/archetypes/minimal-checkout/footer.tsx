import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function MinimalFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="minimal-footer">
      {t("metrics.trustValue")} · {data.organisationName || "Givernance"}
    </footer>
  );
}
