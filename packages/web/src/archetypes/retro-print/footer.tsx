import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function RetroFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="retro-footer">
      {data.organisationName || "The Quarterly"} · {t("footer.poweredBy")}
    </footer>
  );
}
