/**
 * Postal-print layout constants + locale-driven copy table (Epic #274 + Epic #318 PR #4).
 *
 * Single source of truth for:
 *   - the PDF measurement constants (mm-to-points conversion factor, the
 *     175 mm "appeal-body safe zone" ceiling, the predicted QR-bill hint
 *     paragraph height);
 *   - the `LetterCopy` interface + per-locale `LETTER_COPY` strings table
 *     used by every postal-letter renderer (standard rail + Swiss QR-bill
 *     rail, API preview + worker bulk export);
 *   - the `localeToQrBillLanguage` pure mapper used by the `swissqrbill`
 *     v4 `language` option (so a French appeal never lands under a German
 *     payment strip — the library's default);
 *   - the `hasPageFromStatus` helper that turns a `campaign_public_pages`
 *     row status (or its absence) into the `hasPage` boolean fed to the
 *     mode resolver.
 *
 * Lives in `@givernance/shared` because every consumer (api preview,
 * worker render, web mode panel) needs the same values verbatim — drift
 * across them would silently re-introduce the "preview lies about
 * generation" bug PR #4 was opened to fix.
 *
 * No PDFKit / Node-only deps — pure values + pure functions. ADR-013-safe.
 */

import type { Locale } from "./i18n/locales.js";

// ─── Measurement constants ──────────────────────────────────────────────────

/**
 * PDF point per millimetre. PDFKit measures everything in points (1pt =
 * 1/72 inch); we author the layout in mm because the Swiss IG QR-bill spec
 * (v2.4 §3.4) and the French postal C5 envelope geometry both publish their
 * dimensions in mm. Six-decimal precision matches the original constant
 * value in the lockstep renderers and avoids a sub-pixel drift between
 * the API preview and the worker bulk render.
 */
export const MM_TO_PT = 2.834645;

/**
 * Y-coordinate ceiling for compressed-appeal content on a Swiss QR-bill
 * 1-page layout (~496 pt, 17 mm above the BVR strip start at y=192 mm).
 * When the renderer's `doc.y` would cross this line after writing the
 * pay-via-QR-bill hint + reference token, we fall back to a 2-page
 * layout (strip alone on page 2) instead of overprinting the strip's
 * quiet zone (IG QR-bill v2.4 §3.4 — payment strip must stay
 * unobstructed).
 */
export const APPEAL_MAX_Y_PT = 175 * MM_TO_PT;

/**
 * Conservative predicted height for the pay-via-QR-bill hint paragraph
 * plus the reference-token line that follows it (~85 pt). The compressed-
 * appeal renderer uses this to decide whether the strip will fit on the
 * SAME page or overflow to the NEXT page BEFORE actually writing the
 * hint, so the wording (`payViaQrBillSamePage` / `payViaQrBillNextPage`)
 * matches the artefact the donor receives.
 */
export const QR_BILL_HINT_HEIGHT_PT = 30 * MM_TO_PT;

// ─── Strip-location prediction ──────────────────────────────────────────────

/**
 * Outcome the compressed-appeal renderer commits to:
 *   - `same_page` → BVR strip lands at y=192 mm on this page (canonical 1-page).
 *   - `next_page` → caller must `addPage()` before attaching the strip
 *                   (overflow fallback; the appeal letter occupies a full
 *                   page 1, the strip lands alone on page 2 with the
 *                   "Payment slip" header).
 *
 * The wording in the rendered hint is picked to match this prediction so
 * the donor never reads "below" when the strip is on the next page (or
 * vice versa).
 */
export type QrBillStripLocation = "same_page" | "next_page";

// ─── Locale-driven copy ─────────────────────────────────────────────────────

/**
 * Locale-specific copy for the static parts of the postal letter
 * (salutation, generic fallback body, call-to-scan, Swiss QR-bill
 * payment hints, preview watermark). FR and EN are the only two
 * supported locales today; if a tenant is set to a locale we don't
 * translate yet, the renderer falls back to FR (the MVP's primary
 * market) via `copyForLocale`.
 *
 * `greetingNamed(first, last)` and `greetingDoorDrop` are the salutation.
 * `thanksWithDescription*` plays AFTER the operator's description;
 * `thanksFallback*` plays INSTEAD of it when missing. `callToScan` is the
 * lead-in to the QR panel. `payViaQrBillSamePage` / `payViaQrBillNextPage`
 * are the Swiss QR-bill rail CTA variants (Epic #318 PR #4) — two strings
 * because the BVR strip can land on the SAME page as the appeal (1-page
 * canonical) or on the NEXT page (auto-fallback on overflow). Country
 * labels are not translated — the recipient block is meant to be parsed
 * by a postal sorter, not the donor.
 *
 * `previewWatermark` is API-side only (the worker bulk-export path never
 * renders a preview), but the field is part of the canonical shape so
 * the worker and API can share the same `LetterCopy` interface without
 * branching.
 */
export interface LetterCopy {
  greetingNamed: (firstName: string, lastName: string) => string;
  greetingDoorDrop: string;
  thanksWithDescriptionNamed: string;
  thanksWithDescriptionDoorDrop: string;
  thanksFallbackNamed: string;
  thanksFallbackDoorDrop: string;
  callToScan: string;
  referenceLabel: (token: string) => string;
  previewWatermark: string;
  payViaQrBillSamePage: string;
  payViaQrBillNextPage: string;
}

export const LETTER_COPY: Record<Locale, LetterCopy> = {
  fr: {
    greetingNamed: (firstName, lastName) => `Bonjour ${firstName} ${lastName},`,
    greetingDoorDrop: "Bonjour,",
    thanksWithDescriptionNamed:
      "Merci pour votre soutien — chaque contribution, petite ou grande, fait une différence concrète.",
    thanksWithDescriptionDoorDrop:
      "Chaque contribution, petite ou grande, fait une différence concrète.",
    thanksFallbackNamed:
      "Merci pour votre soutien continu. Votre générosité est ce qui rend cette campagne possible — chaque contribution, petite ou grande, fait une différence concrète.",
    thanksFallbackDoorDrop:
      "Votre soutien peut faire une vraie différence pour cette campagne. Chaque contribution, petite ou grande, nous aide à aller plus loin.",
    callToScan: "Pour en savoir plus ou contribuer, scannez le QR code ci-dessous :",
    referenceLabel: (token) => `Référence · ${token}`,
    previewWatermark: "APERÇU — données factices, cette lettre n'a pas été enregistrée.",
    payViaQrBillSamePage:
      "Pour régler ce don, scannez le BVR ci-dessous depuis votre application d'e-banking. Il contient toutes les informations de paiement nécessaires.",
    payViaQrBillNextPage:
      "Pour régler ce don, scannez le BVR sur la page suivante depuis votre application d'e-banking. Il contient toutes les informations de paiement nécessaires.",
  },
  en: {
    greetingNamed: (firstName, lastName) => `Dear ${firstName} ${lastName},`,
    greetingDoorDrop: "Dear Supporter,",
    thanksWithDescriptionNamed:
      "Thank you for your continued support — every contribution, big or small, makes a tangible difference.",
    thanksWithDescriptionDoorDrop: "Every contribution, big or small, makes a tangible difference.",
    thanksFallbackNamed:
      "Thank you for your continued support. Your generosity is what makes this campaign possible — every contribution, big or small, makes a tangible difference.",
    thanksFallbackDoorDrop:
      "Your support could make a real difference for this campaign. Every contribution, big or small, helps us go further.",
    callToScan: "To learn more or contribute, scan the QR code below:",
    referenceLabel: (token) => `Reference · ${token}`,
    previewWatermark: "PREVIEW — sample data, this letter has not been registered.",
    payViaQrBillSamePage:
      "To make your donation, scan the QR-bill below from your e-banking app. It carries all the payment details you need.",
    payViaQrBillNextPage:
      "To make your donation, scan the QR-bill on the next page from your e-banking app. It carries all the payment details you need.",
  },
};

/**
 * Resolve the `LetterCopy` for a tenant default locale. FR is the MVP's
 * primary market and the schema-level default for new tenants — fall back
 * there if a tenant somehow ends up with an unsupported locale (defensive;
 * the validator pins the column to SUPPORTED_LOCALES).
 */
export function copyForLocale(locale: Locale | null | undefined): LetterCopy {
  return LETTER_COPY[locale ?? "fr"] ?? LETTER_COPY.fr;
}

// ─── Swiss QR-bill language mapper ──────────────────────────────────────────

/**
 * Map our internal `tenants.default_locale` (FR/EN today; DE/IT cheap to
 * add when those locales land — see `docs/25` §8) to the `swissqrbill`
 * v4 `language` option which accepts `"DE" | "EN" | "FR" | "IT" | "RM"`.
 *
 * Default `FR` matches the MVP's primary market and the schema-level
 * default for new tenants — never `DE` (the swissqrbill library default)
 * so a French/English appeal never ends up with a German payment strip.
 */
export function localeToQrBillLanguage(
  locale: Locale | null | undefined,
): "DE" | "EN" | "FR" | "IT" {
  if (locale === "en") return "EN";
  // FR is the MVP default — covers `fr`, `null`, `undefined`, and any
  // locale the schema-level validator might let through that this
  // mapper doesn't explicitly know.
  return "FR";
}

// ─── Public-page status → hasPage boolean ───────────────────────────────────

/**
 * Resolve the `hasPage` input to the postal-export mode resolver from a
 * `campaign_public_pages.status` value (or its absence). Returns `true`
 * when a page row EXISTS for the campaign — regardless of draft/published
 * status. Drives mode resolution, NOT the publish-readiness gate.
 *
 * The publish-status gate (`public_page_missing` / `public_page_draft`)
 * fires separately inside the standard/hybrid path at the API layer.
 * Using only `status === 'published'` here would silently flip a
 * draft-page-only campaign into the `blocked` mode and surface an
 * unhelpful "not-configured" banner when the operator clearly intended a
 * standard postal export and just needs to publish.
 *
 * Note: `archived` would map to `false` if/when that status is added to
 * the enum (today `public_page_status` is `draft | published`). The
 * truth table in `docs/25-swiss-qr-bill.md` §1.bis.0 documents this.
 *
 * Lives here so the API, the worker, and the future web mode-summary
 * panel all derive `hasPage` the same way.
 */
export function hasPageFromStatus(status: "draft" | "published" | null | undefined): boolean {
  // Only the two extant statuses count. NULL = no row in
  // `campaign_public_pages` (page was never created) → no page.
  return status === "draft" || status === "published";
}
