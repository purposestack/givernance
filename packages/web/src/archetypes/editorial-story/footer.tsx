import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function EditorialFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <footer className="editorial-footer">
      {data.organisationName || "The Editorial"} · {t("footer.poweredBy")}
    </footer>
  );
}
