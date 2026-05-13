/**
 * Shared layout for all auth pages (login, forgot-password, reset-password, SSO).
 * Matches the auth-layout / auth-card / auth-footer structure from base.css mockups.
 *
 * The locale picker is hoisted here so every pre-auth page (login, signup,
 * invite/accept, forgot-password) inherits it without each page managing its own.
 */
import { getTranslations } from "next-intl/server";
import { AuthBackground } from "@/components/auth/auth-background";
import { LocalePicker } from "@/components/auth/locale-picker";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("common");

  // main is intentionally transparent — body already paints bg-background,
  // and AuthBackground layers a fixed icon-rain animation behind every
  // pre-auth screen (login, signup, invite/accept, forgot-password, …).
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-8 p-6"
    >
      <AuthBackground />
      {children}

      {/* Locale picker — below the card, above the footer on all pre-auth pages */}
      <LocalePicker />

      {/* Footer — shared across all auth pages */}
      <footer className="text-center text-xs tracking-wide text-text-muted">
        <span className="font-medium text-text-secondary">{t("footer.platform")}</span>
        <span className="mx-1 text-neutral-300">&mdash;</span>
        <span>{t("footer.tagline")}</span>
      </footer>
    </main>
  );
}
