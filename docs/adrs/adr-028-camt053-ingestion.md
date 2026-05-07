## ADR-028: camt.053 Ingestion — Parser, Validation, Idempotency, and Retention

**Status**: Accepted (Epic #318, 2026-05-07)
**Related**: ADR-013 (frontend type boundary), ADR-019 (cross-tenant 404), ADR-023 (object-storage bucket topology — `bank-statements` bucket added by this epic), ADR-027 (Swiss QR-bill — produces the QRR/SCOR references this ingestion reconciles), `docs/25-swiss-qr-bill.md`, issue #318

### Context

The Swiss QR-bill rail is only half a feature without **reconciliation**. The donor scans the QR-bill in their e-banking app, the bank books a credit on the NPO's account, and the daily ISO 20022 `camt.053` statement carries the structured reference back. Givernance has to:

1. Receive the camt.053 file (manual upload in V1, EBICS automated pull deferred to V2 — see Rejected alternatives).
2. Validate it as conformant XML against the SIX-published XSD.
3. Walk every credit entry, extract the QRR or SCOR reference, look it up in `swiss_qr_references`, and create a `donations` row attributed to the original campaign + recipient.
4. Surface unmatched credits in an operator-reviewable queue.
5. Be **idempotent under re-import** — operators will re-upload statements out of habit ("did that one go through?"), and a worker retry mid-batch must not double-book.

Three implementation choices need to be locked down:

- **Parser**: which Node library handles `camt.053.001.04` and `camt.053.001.08` reliably enough that QRR is not silently flattened into "SCOR" by an over-eager schema mapping?
- **Validation**: do we trust the parser's tolerance to malformed XML, or do we run an XSD validation pass first?
- **Idempotency key**: which combination of `GrpHdr.MsgId`, `Ntry.AcctSvcrRef`, and `EndToEndId` survives bank-side reuse?

### Decision

**Parser.** Use [`iso20022.js`](https://github.com/Svapnil/iso20022.js) (svapnil) as the **baseline** parser. It is the most-maintained Node-side ISO 20022 library, TypeScript-first, SEPA-shaped but generic enough for Swiss camt.053. **Open question carried into the implementation PR**: confirm with real PostFinance and UBS sample files that QRR (`Tp.CdOrPrtry.Prtry="QRR"`) is correctly surfaced, not collapsed to `Cd="SCOR"`. If `iso20022.js` flattens QRR, **fall back to `fast-xml-parser` + a hand-written mapper** that walks `Document/BkToCstmrStmt/Stmt/Ntry/NtryDtls/TxDtls/RmtInf/Strd/CdtrRefInf` directly. The codebase keeps the parser behind a thin interface so the swap costs one file.

**Validation.** Run an **XSD validation pass** via [`libxmljs2`](https://www.npmjs.com/package/libxmljs2) against the SIX-published `camt.053.001.08.xsd` before any parsing. A malformed file rejects with a structured error and never reaches the reconciler. This is defense-in-depth: the parser would reject many malformations on its own, but XSD-first gives us a uniform error surface and a forensic line ("rejected at validation, line N column M") that the operator can act on.

**Schema versions accepted.** Both `camt.053.001.04` (legacy) and `camt.053.001.08` (current). PostFinance plans its cutover for **November 2026**; we MUST stay tolerant on either side of that date. The parser interface returns the same canonical shape regardless of input version.

**Manual upload in V1, EBICS in V2.** The operator drag-and-drops the camt.053 XML into `Settings → Bank Accounts → :id → Upload statement` (multipart, `.xml`, ≤50 MB). EBICS automated pull requires per-bank contract negotiation (≥1 month per bank, plus T-Systems/Six BBS subscription) and is deferred to a separate epic. Operators check their e-banking weekly — manual upload is the right shape for V1.

**Idempotency key**: `(org_id, GrpHdr.MsgId, Ntry.AcctSvcrRef)`.

- File-level dedup via `MsgId`: re-uploading the same statement short-circuits before any work.
- Entry-level dedup via `AcctSvcrRef`: a worker retry inside a half-imported file resumes without double-booking.
- **Known caveat from ISO 20022 maintenance notes**: some banks reuse `AcctSvcrRef` across related entries (notably reversal pairs). We therefore add `EndToEndId` as a **secondary signal** in the unique constraint when present — `(org_id, MsgId, AcctSvcrRef, COALESCE(EndToEndId, ''))`. Per-bank QA verifies behaviour against real samples.

**Reconcile by reference only — never by amount.** The QR-bill spec lets the donor override the printed amount (counter payment, e-banking edit). Matching on amount would silently miss every partial-amount donation. The reference is the only trustworthy attribution; the amount is an audit signal we surface (`partial_match` flag when the donation amount differs from the printed `swiss_qr_references.amount_cents` AND the printed amount was non-zero).

**Reversal entries** (`Ntry.RvslInd=true`): reverse the prior donation rather than double-book. Look up the original `donations` row via the reference, INSERT a reversal donation linked back via `donations.parent_id`, emit `donation.refunded`. Orphan reversals (no original found) → `camt_unreconciled_entries(reason='orphan_reversal')`.

**Pending entries** (`Sts != BOOK`): skip silently and re-evaluate on next statement upload. The same `AcctSvcrRef` will eventually re-appear with `Sts=BOOK` and the entry-level idempotency key catches the dedup.

**Foreign-IBAN safety**: a camt.053 referencing an `Acct.Id.IBAN` not registered in the tenant's `bank_accounts` is **rejected outright at the file level**. This prevents the operator from accidentally importing a third-party's statement (data leakage) or a personal bank account.

**Storage and retention.** Raw camt.053 XML lands in a **new private `bank-statements` bucket** added by ADR-023 amendment. Keyed `{org_id}/camt053/{yyyy}/{mm}/{filename}.xml`. Signed URLs only; no CDN; encrypted at rest. Retention is **10 years** per **Swiss Code of Obligations Art. 958f** (electronic archival permitted; 10 years from end of business year). This is **distinct from the `receipts` bucket** (7-year retention) — see ADR-023 amendment for why the lifecycle policy difference forecloses sharing the bucket.

**GDPR Art. 17 erasure exception.** Camt-derived `donations` rows are **legal-hold protected** (same posture as Stripe-derived rows under existing `docs/06-security-compliance.md` policy). On constituent erasure, `swiss_qr_references.constituent_id` is set NULL (preserves campaign rollup); `camt_credit_entries.debtor_name` and `.debtor_iban` are kept (financial record) but flagged via the existing `gdpr_erased` mechanism.

### Consequences

- **A new BullMQ queue `camt`** is introduced with two processors: `camt-import.ts` (XSD-validate + parse + persist credit entries) and `camt-reconcile.ts` (match references + create donations).
- **A new private bucket `bank-statements`** ships per ADR-023 amendment, with its own 10-year lifecycle policy (vs 7 years for `receipts`).
- **The `find-or-create constituent` logic** currently in `packages/worker/src/processors/stripe-webhook.ts:179-242` is **extracted** into a shared service `packages/api/src/modules/donations/constituent-resolver.ts` and called from both the Stripe path and the camt.053 reconciler. Single source of truth for "given a name and an identifier (email, IBAN), find or create".
- **Three new tables** land in the same migration window: `camt_statements`, `camt_credit_entries`, `camt_unreconciled_entries`. RLS-scoped by `org_id`, indexed by `(statement_id, status)` for the queue page.
- **The `donations` table** gains `swiss_qr_reference_id`, `camt_credit_entry_id`, and a `payment_source` enum (`stripe | camt053 | manual`). All existing queries that filter on payment provenance use the new enum; aggregations stay unchanged.
- **Operator UX** carries a "Settings → Bank Accounts → :id → Unreconciled queue" surface where unmatched credits are reviewed manually (link to campaign+constituent, or write off with a note). Matches the spirit of the Stripe webhook's failure surface.
- **Per-bank fixtures required** under `packages/worker/src/tests/fixtures/camt053/` for at least PostFinance, UBS, ZKB, Raiffeisen, BCV — derisks parser quirks before the first real customer onboards.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| `xml2js` (callback-based, classic Node) | Battle-tested; ubiquitous | Maintenance has stalled; no XSD support; legacy callback API forces wrappers; no first-class TypeScript types for ISO 20022 | **REJECTED** — superseded |
| Hand-rolled `fast-xml-parser` mapper from V1 | Full control of every traversal; smallest dependency | Re-implementing a published ISO 20022 library is exactly the bug surface ADR-027 rejects for the QR-bill — write a parser, ship it, find out three weeks later that PostFinance puts `EndToEndId` under a niece element no one's ever seen | **REJECTED as primary** — kept as fallback if `iso20022.js` flattens QRR |
| Skip XSD validation, trust the parser | One fewer dependency | A truncated/malformed file would surface as a parser exception with no actionable line/column; XSD gives a uniform structured error; libxmljs2 is mature | **REJECTED** — XSD-first is cheap defense-in-depth |
| **EBICS automated pull in V1** | Zero operator action; daily fresh statements | Per-bank contract negotiation, T-Systems or Six BBS subscription, certificate management; ≥1 month per bank to onboard; operators happy with weekly e-banking checks; massive scope creep for the V1 shape | **REJECTED for V1** — separate epic post-V2 |
| **MT940 legacy import** | Some legacy systems still emit MT940 | Swiss banks have deprecated MT940; the customers asking for QR-bill support are by definition modern enough to receive ISO 20022; supporting MT940 is debt for no living user | **REJECTED** |
| **Match by amount + name fuzzy + reference** (multi-signal) | Catches typos in references | Defeats the entire structured-reference design; donor name on a bank statement is unreliable (joint accounts, abbreviations, family transfers); fuzzy matching is operator-toxic when wrong; if a reference is unreadable, the right move is the manual unreconciled queue, not a probabilistic guess | **REJECTED** — reference-only is the contract |
| **Match on amount alone** (when reference is missing/invalid) | Catches NON-reference donations | The QR-bill spec lets the donor change the amount; matching on amount silently mis-attributes; structurally false-positives that the operator can't audit; a missing reference is the unreconciled queue's job | **REJECTED** — amount is an audit signal, not a key |
| **No idempotency key, dedup by full file hash** | Simple | A re-uploaded statement with one entry added (next-day delta) would fail the dedup and require manual intervention; the per-entry granularity matters | **REJECTED** — too coarse |
| **Idempotency on `MsgId` alone** | Simplest possible | A worker retry mid-import has to redo every entry it already wrote; entry-level idempotency is essentially free at the DB layer (composite unique index) | **REJECTED** — leaves performance on the table for retries |

### Revisit criteria

Reopen this ADR when:

- `iso20022.js` proves to flatten QRR into SCOR on real PostFinance / UBS samples. Switch the implementation to `fast-xml-parser` + hand-written mapper (the open question is carried into the implementation PR; the swap is one file behind the parser interface).
- PostFinance, UBS, or ZKB ships a non-conformant camt.053 variant in production that XSD-validates but has reference encoding quirks not covered by the canonical mapper. Add per-bank parser shims keyed off `Acct.Ownr.Id` + `BkToCstmrStmt/Stmt/Acct/Svcr`.
- Operator demand for **near-real-time reconciliation** justifies EBICS pull (typically when the NPO's volume crosses ~CHF 100k / month and the daily upload becomes annoying). Then ship EBICS as a separate epic — this ADR's parser + validator + idempotency are unchanged; only the file-arrival mechanism flips.
- `camt.054` (real-time credit notifications) becomes a per-tenant requirement. The same parser path applies — a small extension to the import processor, no architecture change.
- The 10-year retention requirement evolves (Swiss CO Art. 958f revision, or a tenant in a different jurisdiction). Then split the bucket lifecycle by tenant region, or add a per-tenant `retention_years` column on `camt_statements`.
- A future tenant operates a non-Swiss EU bank (SEPA-only). The parser interface accepts SEPA-shaped camt.053 already; the reconciliation logic is reference-keyed and bank-agnostic. The pretext to revisit is operator UX (multi-bank-per-campaign, FX handling), not the ingestion layer.

### References

- [Swiss Implementation Guidelines for Cash Management (camt) — SPS 2026 v2.3](https://www.six-group.com/dam/download/banking-services/standardization/sps/ig-cash-management-sps-2026-en.pdf)
- ISO 20022 maintenance notes — `AcctSvcrRef` reuse caveat
- Swiss Code of Obligations [Art. 958f](https://www.fedlex.admin.ch/eli/cc/27/317_321_377/en#art_958_f) — 10-year retention of accounting records (electronic archival permitted)
- [`iso20022.js`](https://github.com/Svapnil/iso20022.js) — chosen baseline parser
- [`libxmljs2`](https://www.npmjs.com/package/libxmljs2) — XSD validator
- [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) — fallback parser if `iso20022.js` flattens QRR
- [ADR-023](./adr-023-object-storage-bucket-topology.md) — `bank-statements` bucket added by amendment
- [ADR-027](./adr-027-swiss-qr-bill.md) — produces the QRR/SCOR references this ingestion reconciles
- `docs/06-security-compliance.md` — GDPR Art. 17 legal-hold posture
- Issue #318 — Swiss QR-bill epic
