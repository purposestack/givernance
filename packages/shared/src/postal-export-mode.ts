/**
 * Postal-export mode resolution (Epic #318 PR #4).
 *
 * The mode is a deterministic function of two booleans on the campaign:
 *   - `hasBank` — is a Swiss bank account linked? (`campaign.bank_account_id IS NOT NULL`)
 *   - `hasPage` — is the public donation page published?
 *
 * Pure function — no DB, no IO, no Node-only deps. Lives in `@givernance/shared`
 * so the API readiness-gate evaluator AND the web mode-summary panel call the
 * exact same code path. Drifting the two would silently re-introduce the
 * "preview doesn't match generation" bug PR #4 was opened to fix.
 *
 * See `docs/25-swiss-qr-bill.md` §1.bis "Mode resolution matrix" and ADR-027
 * "Page layout" for the rationale.
 */

/**
 * Three valid + one degenerate operator states. The operator picks the mode
 * upstream by linking (or not) a bank account and by publishing (or not) the
 * public page — the export panel reflects that choice rather than re-asking.
 */
export type PostalExportRunMode = "standard" | "qr_bill_only" | "hybrid" | "blocked";

export interface PostalExportRunModeInputs {
  /** True when `campaign.bank_account_id IS NOT NULL` AND the account is not soft-deleted. */
  hasBank: boolean;
  /**
   * True when a `campaign_public_pages` row exists for this campaign at
   * all — regardless of publish status. Drives mode resolution, NOT the
   * publish-readiness gate.
   *
   * The publish-status gate (`public_page_missing` / `public_page_draft`)
   * fires separately inside the standard/hybrid mode at the API layer.
   * Using only `status === 'published'` here would silently flip a
   * draft-page-only campaign into the `blocked` mode and surface an
   * unhelpful "not-configured" banner when the operator clearly intended
   * a standard postal export and just needs to publish.
   */
  hasPage: boolean;
}

/**
 * Resolve the mode. Pure function — total over the 4 input combinations.
 *
 * Tie-breaking on the both-true case → `hybrid` (NOT `standard`). Reason:
 * `docs/25-swiss-qr-bill.md` §1.bis is explicit that the Swiss flow MUST be
 * a strict superset of the French tracking surface. Dropping the scan-tracking
 * QR when the operator clearly published a public donation page would silently
 * kill the 3-stage funnel they already configured.
 */
export function resolvePostalExportMode(inputs: PostalExportRunModeInputs): PostalExportRunMode {
  const { hasBank, hasPage } = inputs;
  if (hasBank && hasPage) return "hybrid";
  if (hasBank) return "qr_bill_only";
  if (hasPage) return "standard";
  return "blocked";
}

/**
 * Whether this mode emits an appeal-letter PDF with a Givernance scan-QR
 * pointing at the public donation page. True for `standard` and `hybrid`,
 * false otherwise (QR-bill-only mode has no public page to scan to).
 */
export function modeEmitsAppealLetter(mode: PostalExportRunMode): boolean {
  return mode === "standard" || mode === "hybrid";
}

/**
 * Whether this mode emits a Swiss QR-bill PDF (with the canonical bottom
 * 105mm strip). True for `qr_bill_only` and `hybrid`.
 */
export function modeEmitsQrBill(mode: PostalExportRunMode): boolean {
  return mode === "qr_bill_only" || mode === "hybrid";
}

/**
 * Number of distinct PDF artefacts per recipient at the ZIP level:
 *   - `standard`     → 1 (appeal letter)
 *   - `qr_bill_only` → 1 (bundled 2-page PDF: appeal page 1 + QR-bill page 2)
 *   - `hybrid`       → 2 (appeal + sibling rich QR-bill)
 *   - `blocked`      → 0
 *
 * Used by the worker to allocate filenames in the streaming ZIP and by the
 * web preview UI to decide between PDF-inline vs ZIP-download.
 */
export function modePdfCount(mode: PostalExportRunMode): 0 | 1 | 2 {
  if (mode === "blocked") return 0;
  if (mode === "hybrid") return 2;
  return 1;
}
