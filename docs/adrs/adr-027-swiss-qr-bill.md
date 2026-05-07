## ADR-027: Swiss QR-bill — Library, Layout, and Reference-Type Matrix

**Status**: Accepted (Epic #318, 2026-05-07)
**Related**: ADR-013 (frontend type boundary, no Node-only deps in `@givernance/shared`), ADR-023 (object-storage bucket topology), ADR-025 (PDF rendering code boundary — lockstep duplicate policy), `docs/25-swiss-qr-bill.md`, `docs/23-postal-campaigns.md`, issue #318

### Context

The Swiss QR-bill ("QR-Rechnung" / "QR-facture") is the **only** standardised payment slip a Swiss-resident donor can pay against by bank transfer. The orange ESR / red ES bulletins were discontinued on **2022-09-30**; there is no fallback. A Swiss NPO that prints postal appeals without a QR-bill cannot be paid through the bank rail at all. Field input from Greg (2026-05-07) re-classified Swiss QR-bill from "Future work" in `docs/23-postal-campaigns.md` §9 to **MVP-1 mandatory** for `.ch` tenants.

The feature ships as a sibling to the existing French postal rail (Epic #274). Each Swiss-mode personalised letter produces:

- The existing **appeal letter** (page 1, A4) carrying the Givernance opaque-token QR for scan tracking.
- A new **Swiss QR-bill** (page 2, A4) carrying a per-letter QRR or SCOR reference for reconciliation.

Both PDFs are appended to the same ZIP archive — the print partner staples or distributes them as one mailing.

Three coupled choices need to be locked down before the implementation lands:

1. **Library**: Node-side, MIT-compatible, IG-2.4-ready, validated against real Swiss-bank fixtures.
2. **Page layout**: separate A4 sheet, perforated bottom strip on the appeal letter, or a third hybrid?
3. **Reference type**: QRR only, SCOR only, both, or include NON ("no reference")?

Each of these has been analysed against the Swiss IG QR-bill v2.4 (Feb 2026, in force from Nov 2027 with v2.3 still valid until then), the SIX Style Guide, and the maintained Node ecosystem.

### Decision

**Library.** Use [`swissqrbill`](https://github.com/schoero/SwissQRBill) v4 (schoero, MIT) as the PDF generator, paired with [`boessu/SwissQRBill`](https://github.com/boessu/SwissQRBill) algorithms used **only** in unit tests for cross-validation of QRR mod-10 and SCOR mod-97 check digits. `swissqrbill` v4:

- Composes natively on top of PDFKit (`SwissQRBill.attachTo(doc)`), so the worker keeps its existing PDFKit setup unchanged.
- Ships built-in IBAN, QRR, SCOR, and SPC payload validation.
- Is TypeScript-first and IG-2.4-ready (the v4.x line tracks the Feb 2026 spec).
- Is on a monthly release cadence and MIT-licensed.

**Page layout.** Render the QR-bill on its **own A4 portrait sheet**, sibling to the appeal letter in the ZIP. The IG QR-bill Style Guide explicitly authorises this layout. The bottom 105 mm strip carries the canonical IG-mandated structure (Receipt 62 mm + Payment Part 148 mm); the top 192 mm carries a minimal Givernance summary banner (org name, campaign, reference, amount).

**Reference type.** Support **both QRR and SCOR**, decided per bank account (not per campaign):

| `bank_account.iban_kind` | Reference | When |
|---|---|---|
| `qr_iban` (IID 30000–31999) | **QRR** — 27 numeric digits, mod-10 recursive | UBS, ZKB, PostFinance default — banks that issue a QR-IBAN |
| `iban` (any other CH/LI IBAN) | **SCOR** — `RF` + 2 mod-97 + ≤21 alphanum (ISO 11649) | Some Raiffeisen / smaller cantonals that only issue regular IBANs |

A **fresh reference is minted per recipient per export**, never reused across exports. Idempotency is enforced by the partial unique index on `swiss_qr_references(export_id, constituent_id)` plus the `swiss_qr_references(org_id, bank_account_id, reference)` UNIQUE constraint.

**Currency rule.** `EUR + QRR` is **illegal** under IG QR-bill v2.4 (euroSIC discontinuation). The readiness gate `swiss_qr_bill_currency_mismatch` rejects this combination at PATCH time on the campaign and again at export time.

**Code-boundary placement.** `swissqrbill` is Node-only, like PDFKit. ADR-013 forbids Node-only deps in `@givernance/shared`, so the QR-bill renderer lives in `packages/worker/src/services/swiss-qr-bill.ts` (bulk path) with a lockstep preview duplicate in `packages/api/src/modules/campaigns/swiss-qr-bill-preview.ts` (or co-located in `postal-pdf.ts`). The lockstep duplicate policy follows ADR-025 verbatim — extraction into a future `@givernance/pdf` package is the path when the third PDF surface lands (donor receipts being the second).

### Consequences

- **Two PDFs per recipient in the ZIP** (`{recipient}-letter.pdf` + `{recipient}-qr-bill.pdf`). Worker streaming archive size approximately doubles for Swiss campaigns; storage cost remains bounded by the existing `AbortIncompleteMultipartUpload` lifecycle.
- **The existing scan-to-donate funnel is preserved.** The Givernance opaque-token QR continues to ride on the appeal letter (page 1). The Swiss QR-bill (page 2) adds the payment dimension on top — see `docs/25-swiss-qr-bill.md` §1.bis.
- **Per-bank fixtures required.** PostFinance, UBS, ZKB, Raiffeisen, BCV samples land in `packages/worker/src/tests/fixtures/camt053/` to verify QRR/SCOR round-trip parsing.
- **Locale support: FR/EN ship in MVP**, DE/IT cheap to add since `swissqrbill` exposes all four locales.
- **Door-drop mode is unsupported in V1** — door-drop has no recipient, so per-recipient QRR/SCOR has no anchor. A campaign-level QRR is technically possible but offers no per-donor reconciliation; deferred until field demand emerges.
- **No `swiss_qr_bill_enabled` boolean.** The presence of `campaigns.bank_account_id` IS the on/off switch. Modelling a separate flag would introduce an invalid state (`enabled=true && bank_account_id=NULL`) with no operator meaning.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| `@nexys/swiss-qr-invoice` | Used by some Swiss-side projects | Last meaningful release > 2 years old; no IG v2.4 support; types lag behind PDFKit's; would saddle us with maintenance debt | **REJECTED** — unmaintained |
| Raw PDF generation (handcrafted Receipt + Payment Part via PDFKit primitives) | Zero dependency surface; fully under our control | The IG mandates pixel-precise typography, Helvetica weights, exact label positioning, and a 7 mm Swiss cross overlaid on a 46×46 mm QR with exact ECC level M; rebuilding this passes every QA test until the day SIX moves a label by 0.5 mm in v2.5 and we don't notice; no value gained | **REJECTED** — bug surface for no benefit |
| Rust / WASM QR-bill generator (e.g. a future binding) | Memory-bounded, fast | No production-grade option exists today; introducing a non-Node runtime in the worker is a deployment regression for one PDF type; ADR-013's constraint is about web/server boundary, not Rust | **REJECTED** — no viable candidate |
| **Perforated bottom strip on the appeal letter** (single A4, perforation at y=192mm) | Single sheet per recipient; donor doesn't lose the slip | Requires print-partner perforation negotiation per print run; perforation alignment tolerance is ±1 mm but many small print shops can't guarantee it; the IG Style Guide explicitly authorises both layouts, so we choose the one without supply-chain coupling; a future epic can add perforation as an opt-in print-shop feature | **REJECTED for V1** — supply-chain coupling |
| **NON reference type** ("no structured reference") | Simplest from the operator perspective | camt.053 reconciliation collapses to fuzzy donor-name matching; we will not ship a reconciliation flow that depends on string similarity over donor first names; structurally unreconcilable donations are operator-toxic ("why isn't this paid donation showing up?") | **REJECTED** — defeats reconciliation |
| **Per-campaign reference** (one QRR/SCOR shared by all recipients) | Fewer references to mint and store | Two letters of the same campaign sent to the same constituent (re-mailing, address correction) become indistinguishable in camt.053; partial-amount duplicate-payment risk doubles; tracking widget loses the per-recipient funnel; the storage win is negligible (a few thousand 27-byte strings) | **REJECTED** — destroys per-recipient attribution |
| EUR + QRR pairing | Allows a single config for cross-border NPOs | Illegal under IG QR-bill v2.4 since euroSIC discontinuation; banks reject the slip at submission; not a tradeoff, a bug | **REJECTED** — non-conformant |

### Revisit criteria

Reopen this ADR when:

- `swissqrbill` v4 misses an IG v2.5 upgrade by more than 6 months from spec publication. At that point either contribute upstream or fork; if neither is viable, re-evaluate the raw-PDF rebuild.
- A second IG-conformant Node library reaches `swissqrbill`'s feature parity AND adds a feature we need (e.g. native multi-page reference batching). Then run a parity test and migrate if the cost is low.
- Print-partner negotiation for perforated bottom strips becomes table-stakes for one of our top tenants. Then add the perforated layout as an opt-in mode alongside the separate-sheet default; do not flip the default — silent re-layout would surprise existing operators.
- The third PDF surface lands (donor receipts being the second). At that point the lockstep duplicate of the QR-bill renderer joins the postal-letter and receipts duplicates and the cost-benefit flips per ADR-025 — extract `@givernance/pdf` and host all three.
- Door-drop QR-bill demand emerges. Then design a campaign-level QRR with deliberate per-donor reconciliation gap (operator accepts that "this donation came from someone in this neighborhood" is the entire signal).

### References

- [Swiss Implementation Guidelines QR-bill v2.4 — SIX, Feb 2026](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.4-en.pdf)
- [Swiss Implementation Guidelines QR-bill v2.3 — SIX](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf) (in force until Nov 2027)
- [Style Guide QR-bill — SIX](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/style-guide-qr-bill-en.pdf)
- [`swissqrbill`](https://github.com/schoero/SwissQRBill) v4 (MIT) — chosen library
- [`boessu/SwissQRBill`](https://github.com/boessu/SwissQRBill) — validator algorithms used in unit tests
- ISO 11649 — RF Creditor Reference (SCOR)
- [ADR-013](./adr-013-frontend-type-boundary-no-drizzle-imports-in-web-package.md) — frontend type boundary, no Node-only deps in shared
- [ADR-023](./adr-023-object-storage-bucket-topology.md) — bucket topology (`bank-statements` bucket added in the same epic)
- [ADR-025](./adr-025-pdf-rendering-code-boundary.md) — lockstep duplicate policy this renderer follows
- Issue #318 — Swiss QR-bill epic
