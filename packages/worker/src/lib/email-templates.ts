/**
 * Email templates for signup verification + team invitations.
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

export interface TeamInviteTemplateInput {
  tenantName: string;
  /** Inviter's display name — falls back to "your colleague" when null. */
  inviterName: string | null;
  /** `org_admin` | `user` | `viewer` — surfaced to the invitee for transparency. */
  role: string;
  acceptUrl: string;
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

const ROLE_LABELS: Record<"en" | "fr", Record<string, string>> = {
  en: {
    org_admin: "organisation admin",
    user: "team member",
    viewer: "viewer",
  },
  fr: {
    org_admin: "administrateur·trice",
    user: "membre de l'équipe",
    viewer: "lecteur·trice",
  },
};

function roleLabel(locale: "en" | "fr", role: string): string {
  return ROLE_LABELS[locale][role] ?? role;
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

/**
 * Render the "X invited you to Y" email for team invitations.
 *
 * The inviter's display name is interpolated when known so the recipient
 * sees a personal name rather than a generic "Someone invited you".
 */
export function renderTeamInviteEmail(input: TeamInviteTemplateInput): RenderedEmail {
  const locale = pickLocale(input.country);
  const expires = input.expiresAt.toUTCString();
  const safeName = escapeHtml(input.tenantName);
  const safeUrl = escapeHtml(input.acceptUrl);
  const safeRole = escapeHtml(roleLabel(locale, input.role));

  if (locale === "fr") {
    const inviter = input.inviterName ? escapeHtml(input.inviterName) : "Un·e collègue";
    const subjectInviter = input.inviterName ?? "Un·e collègue";
    return {
      subject: `${subjectInviter} vous invite à rejoindre ${input.tenantName} sur Givernance`,
      text: [
        `${subjectInviter} vous invite à rejoindre l'espace "${input.tenantName}" sur Givernance avec le rôle ${roleLabel(locale, input.role)}.`,
        ``,
        `Acceptez l'invitation en cliquant sur ce lien et en choisissant votre mot de passe :`,
        ``,
        input.acceptUrl,
        ``,
        `Ce lien expire le ${expires}.`,
        ``,
        `Si vous n'attendiez pas cette invitation, ignorez ce message — aucune action n'a été effectuée.`,
      ].join("\n"),
      html: `<!doctype html><html lang="fr"><body style="font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#111;max-width:560px;margin:32px auto;padding:0 16px">
<h1 style="font-size:20px;margin:0 0 16px">Vous êtes invité·e à rejoindre ${safeName}</h1>
<p>${inviter} vous invite à rejoindre l'espace <strong>${safeName}</strong> sur Givernance avec le rôle <strong>${safeRole}</strong>.</p>
<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#1a56db;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Accepter l'invitation</a></p>
<p style="font-size:13px;color:#555">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all">${safeUrl}</span></p>
<p style="font-size:13px;color:#555">Ce lien expire le ${expires}.</p>
<p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px">Si vous n'attendiez pas cette invitation, ignorez ce message — aucune action n'a été effectuée.</p>
</body></html>`,
    };
  }

  const inviter = input.inviterName ? escapeHtml(input.inviterName) : "A colleague";
  const subjectInviter = input.inviterName ?? "A colleague";
  return {
    subject: `${subjectInviter} invited you to join ${input.tenantName} on Givernance`,
    text: [
      `${subjectInviter} invited you to join the workspace "${input.tenantName}" on Givernance as a ${roleLabel(locale, input.role)}.`,
      ``,
      `Accept the invitation by clicking this link and choosing your password:`,
      ``,
      input.acceptUrl,
      ``,
      `This link expires on ${expires}.`,
      ``,
      `If you weren't expecting this invitation, ignore this message — nothing has been activated.`,
    ].join("\n"),
    html: `<!doctype html><html lang="en"><body style="font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#111;max-width:560px;margin:32px auto;padding:0 16px">
<h1 style="font-size:20px;margin:0 0 16px">You're invited to join ${safeName}</h1>
<p>${inviter} invited you to join the workspace <strong>${safeName}</strong> on Givernance as a <strong>${safeRole}</strong>.</p>
<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#1a56db;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Accept the invitation</a></p>
<p style="font-size:13px;color:#555">Or copy this link into your browser:<br><span style="word-break:break-all">${safeUrl}</span></p>
<p style="font-size:13px;color:#555">This link expires on ${expires}.</p>
<p style="font-size:12px;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:16px">If you weren't expecting this invitation, ignore this message — nothing has been activated.</p>
</body></html>`,
  };
}
