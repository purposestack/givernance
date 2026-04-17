import { getTranslations } from "next-intl/server";

export default async function HomePage() {
  const t = await getTranslations("home");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="font-heading text-page-title text-text">{t("title")}</h1>
        <p className="mt-4 text-md text-text-secondary">{t("subtitle")}</p>
      </div>
    </div>
  );
}
