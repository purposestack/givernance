/**
 * Shared layout for all auth pages (login, forgot-password, reset-password, SSO).
 * Matches the auth-layout / auth-card / auth-footer structure from base.css mockups.
 */
import { getTranslations } from "next-intl/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("common");

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background p-6"
    >
      {children}

      {/* Footer — shared across all auth pages */}
      <footer className="text-center text-xs tracking-wide text-text-muted">
        <span className="font-medium text-text-secondary">{t("footer.platform")}</span>
        <span className="mx-1 text-neutral-300">&mdash;</span>
        <span>{t("footer.tagline")}</span>
      </footer>
    </main>
  );
}
