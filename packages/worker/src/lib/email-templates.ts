/**
 * Email templates for signup verification.
 *
 * Bilingual (EN/FR) — Givernance's initial markets. Picks FR when the
 * tenant's country is France, defaults to English otherwise. Keep the
 * HTML intentionally tiny and table-free-safe so Mailpit / most inbox
 * clients render it sensibly; we're not trying to be MJML here.
 */

export interface SignupVerifyTemplateInput {
  tenantName: string;
  verifyUrl: string;
  expiresAt: Date;
  country?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function pickLocale(country?: string | null): "en" | "fr" {
  return country?.toUpperCase() === "FR" ? "fr" : "en";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSignupVerifyEmail(input: SignupVerifyTemplateInput): RenderedEmail {
  const locale = pickLocale(input.country);
  const expires = input.expiresAt.toUTCString();
  const safeName = escapeHtml(input.tenantName);
  const safeUrl = escapeHtml(input.verifyUrl);

  if (locale === "fr") {
    return {
      subject: `Confirmez votre espace ${input.tenantName} sur Givernance`,
      text: [
        `Bienvenue sur Givernance !`,
        ``,
        `Confirmez votre adresse email pour finaliser la création de l'espace "${input.tenantName}" en cliquant sur ce lien :`,
        ``,
        input.verifyUrl,
        ``,
        `Ce lien expire le ${expires}.`,
        ``,
        `Si vous n'avez pas demandé la création de cet espace, ignorez ce message — aucune action n'a été effectuée.`,
      ].join("\n"),
      html: `<!doctype html><html lang="fr"><body style="font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#111;max-width:560px;margin:32px auto;padding:0 16px">
<h1 style="font-size:20px;margin:0 0 16px">Bienvenue sur Givernance</h1>
<p>Confirmez votre adresse email pour finaliser la création de l'espace <strong>${safeName}</strong>.</p>
<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#1a56db;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Confirmer mon email</a></p>
<p style="font-size:13px;color:#555">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all">${safeUrl}</span></p>
<p style="font-size:13px;color:#555">Ce lien expire le ${expires}.</p>
<p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px">Si vous n'avez pas demandé la création de cet espace, ignorez ce message — aucune action n'a été effectuée.</p>
</body></html>`,
    };
  }

  return {
    subject: `Confirm your Givernance workspace "${input.tenantName}"`,
    text: [
      `Welcome to Givernance!`,
      ``,
      `Confirm your email to finish creating the workspace "${input.tenantName}" by clicking this link:`,
      ``,
      input.verifyUrl,
      ``,
      `This link expires on ${expires}.`,
      ``,
      `If you didn't request this workspace, ignore this message — nothing has been activated.`,
    ].join("\n"),
    html: `<!doctype html><html lang="en"><body style="font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#111;max-width:560px;margin:32px auto;padding:0 16px">
<h1 style="font-size:20px;margin:0 0 16px">Welcome to Givernance</h1>
<p>Confirm your email to finish creating the workspace <strong>${safeName}</strong>.</p>
<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#1a56db;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Confirm my email</a></p>
<p style="font-size:13px;color:#555">Or copy this link into your browser:<br><span style="word-break:break-all">${safeUrl}</span></p>
<p style="font-size:13px;color:#555">This link expires on ${expires}.</p>
<p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px">If you didn't request this workspace, ignore this message — nothing has been activated.</p>
</body></html>`,
  };
}
