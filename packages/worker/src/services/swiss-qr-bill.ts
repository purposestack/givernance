/**
 * Swiss QR-bill (BVR) rendering + reference minting service (Epic #318).
 *
 * Hooked into the postal-export processor — when a campaign has a
 * `bank_account_id` set, every letter in the export gains a second
 * PDF (`{recipient}-qr-bill.pdf`) carrying a canonical IG QR-bill on
 * a separate A4 sheet. Reference granularity is mode-dependent (per
 * ADR-027):
 *
 *   - personalised → one QRR/SCOR per (recipient, export)
 *   - door-drop    → one campaign-level QRR/SCOR per export
 *
 * Idempotency on retry comes from `swiss_qr_references_export_recipient_uniq`
 * (partial unique with `COALESCE(constituent_id, sentinel)`): a Kamal
 * pod crash mid-export resumes with the same minted reference instead
 * of issuing a new one.
 *
 * `swissqrbill` v4 composes onto a PDFKit document. Reference SHA-pinned
 * via `package.json` — output spot-checked locally against PostFinance /
 * UBS / Raiffeisen samples (see `/tmp/qr-bill-preview/` scratch script
 * used during PR #319 derisking).
 */

import { randomBytes } from "node:crypto";
import {
  type BankAccount,
  bankAccounts,
  type SwissQrReferenceType,
  swissQrReferences,
} from "@givernance/shared/schema";
import { computeQrr, computeScor } from "@givernance/shared/validators";
import { and, eq, isNull, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { SwissQRBill } from "swissqrbill/pdf";
import { withWorkerContext } from "../lib/db.js";

/**
 * Effective reference type given a campaign's mode override + the bank
 * account's IBAN kind. Mirror of ADR-027's reference-type decision matrix
 * — keep this and the form-side hint in `bank-account-form.tsx` in lockstep.
 */
export function resolveReferenceType(
  qrReferenceMode: "auto" | "qrr" | "scor",
  ibanKind: "iban" | "qr_iban",
): SwissQrReferenceType {
  if (qrReferenceMode !== "auto") return qrReferenceMode;
  return ibanKind === "qr_iban" ? "qrr" : "scor";
}

/**
 * Mint a fresh QRR or SCOR reference string (the worker computes the
 * checksum via the shared validators). The body is sourced from
 * `crypto.randomBytes` so two concurrent retries that both miss the DB
 * lookup don't collide on the same numeric sequence — the partial
 * unique on `(org_id, bank_account_id, reference)` is the
 * source-of-truth.
 *
 *   QRR: 26 random digits + 1 mod-10-recursive check digit
 *   SCOR: `RF` + 2 mod-97-10 check digits + up to 21 alphanumerics
 *
 * The body is digit-only (QRR) or alphanumeric-uppercase (SCOR). Tests
 * cover the checksum round-trip; this routine sits behind the partial-
 * unique retry-idempotency so a malformed mint is never persisted.
 */
function mintReferenceString(type: SwissQrReferenceType): string {
  if (type === "qrr") {
    // 26 random digits (0-9) — derived from raw bytes mod 10.
    const bytes = randomBytes(26);
    let body = "";
    for (let i = 0; i < 26; i++) {
      body += (bytes[i]! % 10).toString();
    }
    return computeQrr(body);
  }
  // SCOR — 21 base32-like alphanumerics. `randomBytes(13).toString('base32')`
  // doesn't exist in Node, so use base64url then strip non-alnum and
  // upper-case.
  const raw = randomBytes(16)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const body = raw.slice(0, 21) || "X"; // defensive: never empty
  return computeScor(body);
}

/**
 * Get-or-mint the `swiss_qr_references` row for this (export, recipient)
 * tuple. Returns the canonical reference string for the worker to print
 * on the QR-bill. The lookup runs under `withWorkerContext` (RLS) so
 * cross-tenant retries return no rows by construction.
 *
 * Retry-safe: a partial unique index on `(export_id, COALESCE(constituent_id,
 * sentinel))` enforces 1 ref per recipient per export. On the rare race
 * between two concurrent retries, one INSERT wins and the loser falls
 * through to a SELECT.
 */
export async function ensureSwissQrReference(args: {
  orgId: string;
  campaignId: string;
  exportId: string;
  bankAccountId: string;
  /** NULL for door-drop (one campaign-level reference per export). */
  constituentId: string | null;
  referenceType: SwissQrReferenceType;
  currency: "CHF" | "EUR";
}): Promise<{ reference: string; referenceType: SwissQrReferenceType }> {
  return withWorkerContext(args.orgId, async (tx) => {
    // 1. Idempotent SELECT — pick up an existing ref if a previous
    //    attempt already minted one for this (export, recipient).
    const [existing] = await tx
      .select({
        reference: swissQrReferences.reference,
        referenceType: swissQrReferences.referenceType,
      })
      .from(swissQrReferences)
      .where(
        and(
          eq(swissQrReferences.orgId, args.orgId),
          eq(swissQrReferences.exportId, args.exportId),
          // Match the partial-unique predicate exactly: NULL constituent_id
          // for door-drop, set constituent_id for personalised.
          args.constituentId === null
            ? isNull(swissQrReferences.constituentId)
            : eq(swissQrReferences.constituentId, args.constituentId),
        ),
      );

    if (existing) {
      return existing;
    }

    // 2. Mint fresh + INSERT. The partial unique catches concurrent
    //    duplicates; on a clash we fall through to a re-SELECT.
    const reference = mintReferenceString(args.referenceType);
    try {
      await tx.insert(swissQrReferences).values({
        orgId: args.orgId,
        campaignId: args.campaignId,
        constituentId: args.constituentId,
        exportId: args.exportId,
        bankAccountId: args.bankAccountId,
        referenceType: args.referenceType,
        reference,
        currency: args.currency,
        amountCents: 0, // donor-fills (the standard Swiss UX)
      });
      return { reference, referenceType: args.referenceType };
    } catch (err) {
      // Concurrent retry won the race — re-SELECT and use that row.
      const [racer] = await tx
        .select({
          reference: swissQrReferences.reference,
          referenceType: swissQrReferences.referenceType,
        })
        .from(swissQrReferences)
        .where(
          and(
            eq(swissQrReferences.orgId, args.orgId),
            eq(swissQrReferences.exportId, args.exportId),
            args.constituentId === null
              ? isNull(swissQrReferences.constituentId)
              : eq(swissQrReferences.constituentId, args.constituentId),
          ),
        );
      if (racer) return racer;
      throw err;
    }
  });
}

/**
 * Load the bank account by ID under worker context. Returns the full row
 * (incl. holder address) for the renderer to read. Worker-context lookup
 * never returns a soft-deleted row — the readiness gate already rejected
 * those at API time, but defense-in-depth: a stale postal-export row
 * pointing at a since-deleted bank account would otherwise crash the
 * render with `undefined` field accesses.
 */
export async function loadBankAccountForRender(
  orgId: string,
  bankAccountId: string,
): Promise<BankAccount | null> {
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, bankAccountId),
          eq(bankAccounts.orgId, orgId),
          isNull(bankAccounts.deletedAt),
        ),
      );
    return row ?? null;
  });
}

/**
 * Render a Swiss QR-bill on its own A4 portrait page and return the PDF
 * buffer. `swissqrbill` v4 attaches onto a PDFKit document; we manage the
 * stream → Buffer collection ourselves so the postal-export processor
 * can `archive.append(buffer, { name })` synchronously alongside the
 * appeal letter.
 *
 * IG QR-bill v2.4 structured-address (S) shape — combined-address (K)
 * is intentionally not produced (see ADR-027 §"Address-type readiness").
 *
 * `amount` is left `undefined` so the slip prints "donor-fills" — the
 * Swiss fundraising default. Future operators can pass a suggested amount
 * per ADR-027's "amount" guidance once the campaign form exposes it.
 */
export async function renderSwissQrBillPdf(args: {
  bankAccount: BankAccount;
  reference: string;
  /** Surfaced near the QR for donor context. */
  campaignName: string;
}): Promise<Buffer> {
  const { bankAccount, reference, campaignName } = args;
  const pdf = new PDFDocument({ size: "A4", autoFirstPage: false });
  const chunks: Buffer[] = [];

  const finished = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk) => chunks.push(chunk as Buffer));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  // Page header (the top 192 mm of the A4 — see docs/25 §1.ter ASCII layout).
  pdf.addPage({ size: "A4" });
  pdf.fontSize(14).font("Helvetica-Bold").text(bankAccount.holderName, 50, 60);
  pdf.fontSize(10).font("Helvetica").fillColor("#555555").text(`Campaign: ${campaignName}`, 50, 82);
  pdf
    .fontSize(10)
    .fillColor("#000000")
    .text(`Reference: ${reference}`, 50, 100)
    .text(`Currency: ${bankAccount.currency} (amount specified by donor)`, 50, 116)
    .text("Pay this QR-bill from your e-banking app — scan the QR below.", 50, 145);

  // swissqrbill v4 attaches the canonical bottom 105 mm strip
  // (Receipt 62 mm + Payment Part 148 mm + 46×46 mm QR with Swiss cross).
  // Address shape passed in IG `StrtNm` / `BldgNb` / `PstCd` / `TwnNm` /
  // `Ctry` — the v4 library renders the S form natively when these
  // structured fields are present.
  const qrBill = new SwissQRBill({
    currency: bankAccount.currency,
    reference,
    creditor: {
      account: bankAccount.iban,
      name: bankAccount.holderName,
      address: bankAccount.holderStreet,
      buildingNumber: bankAccount.holderBuildingNumber ?? undefined,
      zip: bankAccount.holderPostalCode,
      city: bankAccount.holderTown,
      country: bankAccount.holderCountryCode,
    },
    message: campaignName,
  });
  qrBill.attachTo(pdf);

  pdf.end();
  return finished;
}

/** Sanitised filename for the QR-bill PDF, paired with the appeal letter. */
export function qrBillFilenameFor(letterFilename: string): string {
  // `something.pdf` → `something-qr-bill.pdf`. Keep the ZIP entries
  // adjacent so the print partner can staple/distribute as one mailing.
  return letterFilename.replace(/\.pdf$/i, "") + "-qr-bill.pdf";
}

/**
 * Validate that `swissqrbill` v4 can actually serialise this payload —
 * the library throws synchronously on malformed IBAN/reference/address
 * combinations. Used by integration tests to confirm the readiness gate
 * + lib agreement holds for every supported scenario.
 */
export function prebuildQrBillForValidation(
  args: Parameters<typeof renderSwissQrBillPdf>[0],
): void {
  // Construct in-memory; no `attachTo` (no PDFKit doc), no IO. Throws
  // if the data shape is invalid per the lib's validators.
  new SwissQRBill({
    currency: args.bankAccount.currency,
    reference: args.reference,
    creditor: {
      account: args.bankAccount.iban,
      name: args.bankAccount.holderName,
      address: args.bankAccount.holderStreet,
      buildingNumber: args.bankAccount.holderBuildingNumber ?? undefined,
      zip: args.bankAccount.holderPostalCode,
      city: args.bankAccount.holderTown,
      country: args.bankAccount.holderCountryCode,
    },
    message: args.campaignName,
  });
}

/**
 * Stats helper for retries that need to know if a previous attempt
 * already minted a reference for this (export, recipient). Not used by
 * the worker today — exported so tests can assert idempotency without
 * re-implementing the SELECT.
 */
export async function getExistingSwissQrReference(
  orgId: string,
  exportId: string,
  constituentId: string | null,
): Promise<{ reference: string; referenceType: SwissQrReferenceType } | null> {
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        reference: swissQrReferences.reference,
        referenceType: swissQrReferences.referenceType,
      })
      .from(swissQrReferences)
      .where(
        and(
          eq(swissQrReferences.orgId, orgId),
          eq(swissQrReferences.exportId, exportId),
          constituentId === null
            ? isNull(swissQrReferences.constituentId)
            : eq(swissQrReferences.constituentId, constituentId),
        ),
      );
    return row ?? null;
  });
}

/** Re-exported so downstream callers can guard their inputs. */
export type { BankAccount, SwissQrReferenceType };

/** Side-effect-free shape used by the postal-export integration. */
export interface SwissQrBillRenderContext {
  bankAccount: BankAccount;
  referenceType: SwissQrReferenceType;
  campaignName: string;
}

// Suppress unused-import lint on `sql` until the post-PR-3 follow-up
// adds a denormalised counter (per ADR-027's sequential minting note).
void sql;
