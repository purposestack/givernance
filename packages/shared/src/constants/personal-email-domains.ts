/**
 * Personal / consumer email domains that cannot be bound to a tenant via
 * `tenant_domains`. A tiny NPO using `tresorier@gmail.com` has a perfectly
 * valid self-serve signup, but it MUST NOT be allowed to "claim" gmail.com
 * as a Home-IdP-Discovery routing domain — that would lock every gmail user
 * out of every other tenant.
 *
 * List is intentionally conservative and covers the dominant providers used
 * by French/Belgian/Swiss/German NPOs (per `docs/16-greg-field-insights.md`).
 * Expand cautiously: false positives are worse than false negatives here.
 * ADR-016 / `docs/22-tenant-onboarding.md` §4.2.
 */
export const PERSONAL_EMAIL_DOMAINS: readonly string[] = Object.freeze([
  // Global consumer providers
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.fr",
  "hotmail.co.uk",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "tutanota.com",
  "tutamail.com",
  "tuta.io",
  "fastmail.com",
  "zoho.com",
  "yandex.com",
  "gmx.com",
  "gmx.net",
  "gmx.fr",
  "gmx.de",
  "mail.com",
  "mail.ru",

  // France
  "laposte.net",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "neuf.fr",
  "bbox.fr",
  "bouyguestelecom.fr",
  "aliceadsl.fr",
  "club-internet.fr",
  "noos.fr",
  "numericable.fr",
  "voila.fr",
  "cegetel.net",

  // Belgium / Netherlands
  "skynet.be",
  "telenet.be",
  "scarlet.be",
  "proximus.be",
  "mail.be",
  "kpnmail.nl",
  "ziggo.nl",
  "xs4all.nl",
  "planet.nl",

  // Germany / DACH
  "web.de",
  "t-online.de",
  "freenet.de",
  "arcor.de",
  "gmx.ch",
  "bluewin.ch",
  "hispeed.ch",
  "sunrise.ch",
  "sunrise.net",

  // Italy
  "libero.it",
  "virgilio.it",
  "tin.it",
  "tiscali.it",
  "alice.it",

  // Spain / Portugal
  "terra.com",
  "ya.com",
  "sapo.pt",

  // Other disposable-adjacent providers Greg's field data flagged
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "tempmail.com",
  "throwawaymail.com",
  "sharklasers.com",
  "trashmail.com",
  "maildrop.cc",
  "mohmal.com",
  "dispostable.com",
]);

/** Lowercase set for O(1) membership checks. */
const PERSONAL_EMAIL_DOMAIN_SET: ReadonlySet<string> = new Set(PERSONAL_EMAIL_DOMAINS);

/**
 * Returns `true` when `domain` is a personal / consumer email domain that
 * cannot be claimed as a tenant-binding domain. Input is normalised to
 * lowercase; callers should pre-validate syntax (it's a host, not an email).
 */
export function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAIN_SET.has(domain.trim().toLowerCase());
}
