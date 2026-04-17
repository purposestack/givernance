import { getTranslations } from "next-intl/server";

/**
 * Onboarding layout — full-screen wizard, no sidebar/topbar.
 * Matches `.onboarding-layout` + `.onboarding-container` from base.css.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("common");

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center gap-8 bg-background px-6 py-8"
    >
      <div className="mx-auto w-full max-w-[640px]">{children}</div>

      <footer className="mt-auto text-center text-xs tracking-wide text-text-muted">
        <span className="font-medium text-text-secondary">{t("footer.platform")}</span>
        <span className="mx-1 text-neutral-300">&mdash;</span>
        <span>{t("footer.tagline")}</span>
      </footer>
    </main>
  );
}
