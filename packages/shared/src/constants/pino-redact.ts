/**
 * Centralised Pino `redact.paths` list used by every service that emits logs
 * (API, Worker, Relay). Owning this list in @givernance/shared means a new
 * sensitive field only needs adding in one place — otherwise PII policy drifts
 * across services.
 *
 * Scope (docs/17 §6.1 — GDPR defence in depth):
 *   • Auth / session headers and secret bodies — the original Phase 1 list.
 *   • PII mandated by docs/06 and issue #56: email, phone, names, address,
 *     national ID, free-text notes, and dynamic customFields (which can hold
 *     arbitrary donor data entered by staff).
 *
 * Each path is expressed for Pino's `redact` option: dot-separated JSON path,
 * with wildcards where a field can appear at multiple depths (e.g. `body.*`
 * nested or top-level).
 *
 * Pino's `redact` has matching caveats:
 *   • Wildcards only expand one level — `*.email` covers `req.email`, `body.email`,
 *     but not `body.contact.email`. We enumerate likely containers explicitly
 *     rather than rely on a catch-all.
 *   • Arrays need `[*]` — `body.constituents[*].email`.
 *
 * Adding a new PII field: add its path here and update docs/17 §6.1 to stay
 * aligned.
 */
export const PINO_REDACT_PATHS: readonly string[] = [
  // ─── Auth / session ────────────────────────────────────────────────────────
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.Authorization",

  // ─── Secrets / credentials in request bodies ───────────────────────────────
  "body.password",
  "body.token",
  "body.client_secret",
  "body.refresh_token",
  "body.access_token",
  "accessToken",
  "*.accessToken",

  // ─── Payment instruments (card + bank) ─────────────────────────────────────
  "body.iban",
  "body.cardNumber",
  "body.cvv",
  "body.pan",

  // ─── PII (docs/17 §6.1, docs/06) ──────────────────────────────────────────
  // Direct identifiers — covered on request bodies, responses, and anywhere
  // they end up attached under a `constituent` object logged by mistake.
  "body.email",
  "body.phone",
  "body.firstName",
  "body.lastName",
  "body.address",
  "body.nationalId",
  "body.notes",
  "body.customFields",
  "email",
  "phone",
  "firstName",
  "lastName",
  "address",
  "nationalId",
  "notes",
  "customFields",
  "*.email",
  "*.phone",
  "*.firstName",
  "*.lastName",
  "*.address",
  "*.nationalId",
  "*.notes",
  "*.customFields",

  // ─── Nested domain objects (two-level reach) ───────────────────────────────
  // Pino's wildcard is one-level only; enumerate the likely carrier keys so a
  // log line like `log.info({ constituent: {...full row...} })` still redacts
  // the PII fields. Catches the common "I just spread the whole entity into
  // the log context" mistake highlighted in PR #142 review M3.
  "body.constituent.email",
  "body.constituent.phone",
  "body.constituent.firstName",
  "body.constituent.lastName",
  "body.constituent.address",
  "body.constituent.nationalId",
  "req.body.constituent.email",
  "req.body.constituent.phone",
  "req.body.constituent.firstName",
  "req.body.constituent.lastName",
  "req.body.constituent.address",
  "req.body.constituent.nationalId",
  "constituent.email",
  "constituent.phone",
  "constituent.firstName",
  "constituent.lastName",
  "constituent.address",
  "constituent.nationalId",
  "volunteer.email",
  "volunteer.phone",
  "volunteer.firstName",
  "volunteer.lastName",
  "donor.email",
  "donor.phone",
  "donor.firstName",
  "donor.lastName",
];
