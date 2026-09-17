import { useTranslations } from "next-intl";
import type { FooterSlotProps } from "../types";

export function NeoBrutalistFooter({ data }: FooterSlotProps) {
  const t = useTranslations("publicDonationPage");
  // Shouting voice comes from `.neo-footer { text-transform }`, not the string.
  return (
    <footer className="neo-footer">
      {data.organisationName || "ANON"} {"//"} {t("footer.poweredBy")}
    </footer>
  );
}
