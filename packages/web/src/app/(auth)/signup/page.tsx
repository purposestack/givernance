import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { SignupForm } from "@/components/auth/signup-form";

/**
 * Public self-serve signup landing (issue #109 / ADR-016 / doc 22 §6.1).
 *
 * Server component resolves the best-effort country from the edge headers;
 * the form itself is client-side for debounced validation + submit handling.
 *
 * hCaptcha site key is read from env at render time (never from the client
 * bundle) so rotating it doesn't require a redeploy of the web chunk.
 */
export default async function SignupPage() {
  const t = await getTranslations("auth.signup");
  const hdrs = await headers();
  // CloudFront / Scaleway / Cloudflare country header, in rough priority.
  const country =
    hdrs.get("cf-ipcountry") ?? hdrs.get("x-vercel-ip-country") ?? hdrs.get("x-country") ?? "FR";
  const captchaSiteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;

  return (
    <AuthCard>
      <AuthLogo />
      <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
      <p className="mb-8 text-center text-sm text-text-secondary">{t("subtitle")}</p>

      <SignupForm
        defaultCountry={country.toUpperCase().slice(0, 2)}
        captchaSiteKey={captchaSiteKey}
      />
    </AuthCard>
  );
}
