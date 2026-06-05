/**
 * Shared layout for all auth pages (login, forgot-password, reset-password, SSO).
 * Matches the auth-layout / auth-card / auth-footer structure from base.css mockups.
 *
 * The locale picker is hoisted here so every pre-auth page (login, signup,
 * invite/accept, forgot-password) inherits it without each page managing its own.
 */
import { getTranslations } from "next-intl/server";
import { AuthWaves } from "@/components/auth/auth-waves";
import { LocalePicker } from "@/components/auth/locale-picker";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("common");

  // AuthWaves is a single fixed -z-10 layer that paints BOTH the marketing
  // hero's cream background AND the drifting filigree waves, so the pre-auth
  // screens sit in the continuation of the marketing site. main is kept
  // transparent on purpose: an opaque bg here (step-3 block background) would
  // paint over the negative-z wave layer and hide it.
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-8 p-6"
    >
      <AuthWaves />
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
