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

**Validation.** Run an **XSD validation pass** via [`libxmljs2`](https://www.npmjs.com/package/libxmljs2) against the SIX-published XSD before any parsing. A malformed file rejects with a structured error and never reaches the reconciler. This is defense-in-depth: the parser would reject many malformations on its own, but XSD-first gives us a uniform error surface and a forensic line ("rejected at validation, line N column M") that the operator can act on.

**Schema versions accepted.** Both `camt.053.001.04` (legacy) and `camt.053.001.08` (current). Version is detected from the root `Document/@xmlns` namespace, then the matching XSD bundle is selected (`camt.053.001.04.xsd` OR `camt.053.001.08.xsd`). PostFinance plans its cutover for **November 2026**; we MUST stay tolerant on either side of that date. The parser interface returns the same canonical shape regardless of input version. Any other namespace (`camt.053.001.02`, future `…001.10`, etc.) is **rejected with a structured `camt_unsupported_version` error** at validation time — silent best-effort parsing of an off-spec version is the worst possible behaviour for a reconciliation pipeline.

**Hardening — XXE / DTD / billion-laughs / zip-bomb.** `libxmljs2` is a libxml2 binding and resolves external entities **by default** unless the parse flags are set explicitly. A compromised org-admin (real threat in a multi-tenant SaaS) can submit a crafted camt.053 that reads arbitrary worker-pod files via XXE, exhausts memory via billion-laughs entity expansion, or smuggles a 10 GB uncompressed payload. The 50 MB upload cap doesn't help against entity expansion. The implementation MUST therefore:

- Parse with `{ noent: false, nonet: true, dtdload: false, dtdvalid: false, huge: false, noblanks: true }` — no external entity substitution, no network entity resolution, no DTD loading, no DTD validation, no "huge" mode (caps entity expansion), no insignificant whitespace.
- Cap the parsed-tree node count at 1 000 000 nodes (`libxmljs2` exposes a counter — abort if exceeded).
- Reject any file whose decompressed size (after a gzip/zlib pre-pass) exceeds 200 MB. Camt.053 is XML — text-compressible — and any reasonable monthly statement fits in 10 MB. A 200× compression ratio is the canonical zip-bomb signature.
- Run the entire validation step in a child worker with a `--max-old-space-size=512` cap so a malicious payload bounded to a single worker process rather than the pod.

**Manual upload in V1, EBICS in V2.** The operator drag-and-drops the camt.053 XML into `Settings → Bank Accounts → :id → Upload statement` (multipart, `.xml`, ≤50 MB). EBICS automated pull requires per-bank contract negotiation (≥1 month per bank, plus T-Systems/Six BBS subscription) and is deferred to a separate epic. Operators check their e-banking weekly — manual upload is the right shape for V1.

**Idempotency key**: `(org_id, statement_id, AcctSvcrRef, COALESCE(EndToEndId, ''))` at the entry level + `(org_id, GrpHdr.MsgId)` at the file level.

- File-level dedup via `MsgId`: re-uploading the same statement short-circuits before any work (`camt_statements_org_msg_id_uniq`).
- Entry-level dedup is implemented as a partial-unique-index-with-COALESCE on `camt_credit_entries` (`camt_credit_entries_org_statement_entry_uniq`) — the COALESCE collapses NULL `EndToEndId` to the empty string so the unique still de-duplicates when the bank omits the field. Some banks reuse `AcctSvcrRef` across related entries (notably reversal pairs); the `EndToEndId` disambiguates them per ISO 20022 maintenance notes. The widened tuple lands in this foundation PR (not deferred) — cheap to add now, expensive to retrofit once data accumulates.
- Per-bank QA verifies behaviour against real PostFinance / UBS / ZKB / Raiffeisen / BCV samples before the first production tenant.

**Reconcile by reference only — never by amount.** The QR-bill spec lets the donor override the printed amount (counter payment, e-banking edit). Matching on amount would silently miss every partial-amount donation. The reference is the only trustworthy attribution; the amount is an audit signal we surface (`partial_match` flag when the donation amount differs from the printed `swiss_qr_references.amount_cents` AND the printed amount was non-zero).

**Reversal entries** (`Ntry.RvslInd=true`): reverse the prior donation rather than double-book. Look up the original `donations` row via the reference, INSERT a reversal donation linked back via `donations.parent_id`, emit `donation.refunded`. Orphan reversals (no original found) → `camt_unreconciled_entries(reason='orphan_reversal')`.

**Pending entries** (`Sts != BOOK`): skip silently and re-evaluate on next statement upload. The same `AcctSvcrRef` will eventually re-appear with `Sts=BOOK` and the entry-level idempotency key catches the dedup.

**Foreign-IBAN safety**: a camt.053 referencing an `Acct.Id.IBAN` not registered in the tenant's `bank_accounts` is **rejected outright at the file level**. This prevents the operator from accidentally importing a third-party's statement (data leakage) or a personal bank account. This is a *file-level rejection* — distinct from ADR-019's cross-tenant 404 (which covers FK-lookup paths after entry-level persistence). ADR-019 still applies inside the reconciler when a `swiss_qr_references.id` lookup matches a different tenant; the foreign-IBAN check above happens earlier, at upload validation, with no DB lookup needed.

**Storage and retention.** Raw camt.053 XML lands in a **new private `bank-statements` bucket** added by ADR-023 amendment. Keyed `{org_id}/camt053/{yyyy}/{mm}/{filename}.xml`. Signed URLs only; no CDN; encrypted at rest. Retention is **10 years** per **Swiss Code of Obligations Art. 958f** (electronic archival permitted; 10 years from end of business year). This is **distinct from the `receipts` bucket** (7-year retention) — see ADR-023 amendment for why the lifecycle policy difference forecloses sharing the bucket.

**GDPR Art. 17 erasure exception.** Camt-derived `donations` rows are **legal-hold protected** (same posture as Stripe-derived rows under existing `docs/06-security-compliance.md` policy). On constituent erasure (`constituents.deleted_at IS NOT NULL`), `swiss_qr_references.constituent_id` is set NULL via the FK's `ON DELETE SET NULL` (preserves campaign rollup); `camt_credit_entries.debtor_name` and `.debtor_iban` are retained for the legally required 10 years per CO Art. 958f and surfaced only to the accountant role. Donor-facing surfaces (annual statement, donor portal) filter out erased rows by joining on `constituents.deleted_at IS NULL` — no separate `gdpr_erased` flag is introduced; `deleted_at` is the single source of truth.

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
- **Bank-by-bank donor-data variance reaches the long tail.** The reconciler extracts donor name + postal address from `RltdPties.Dbtr.PstlAdr` (structured) with a fallback heuristic on `AdrLine` (free-form) per `docs/25-swiss-qr-bill.md` §5.5. Production data will expose per-bank quirks — PostFinance vs UBS vs Raiffeisen address ordering, compound surname splits, free-form `AdrLine` rendering. Once the deterministic parser hits its tail, evolve to an LLM normalisation layer (Scaleway Generative APIs, EU residency) per `docs/25` §5.6. That's a separate ADR (`adr-029-ai-camt053-normalisation.md`, TBD) and a separate epic; this ADR's parser + validator + idempotency are unchanged. The principle is **deterministic-first, AI-enrichment-only-on-low-confidence** — never silently rewrite a deterministic-extracted field with an LLM-normalised one.

### Implementation notes (PR #5 — 2026-05-12)

The original Decision section above is preserved verbatim; this subsection records the implementation choices PR #5 actually made where the original Decision was either silent or non-prescriptive. Reading order: Context → Decision → Consequences → Rejected alternatives → Revisit criteria → *these notes*.

- **Reversal backlink column** — the original Decision wording referenced `donations.parent_id` for the reversal linkage. PR #5 instead introduces a dedicated nullable FK column `donations.reverses_donation_id` (FK → `donations.id`, `ON DELETE SET NULL`) for the 1:1 reversal backlink. Rationale: the `parent_id` pattern is already in use on `campaigns` as a recursive-tree shape (parent → child → grandchild); a refund is a flat 1:1 backlink, not a tree. A dedicated column keeps the semantics explicit and lets the operator's audit query (`SELECT … WHERE reverses_donation_id = $original.id`) read cleanly without overloading the recursive-tree convention. The reversal row carries `amount_cents = -original.amount_cents`, `status='refunded'`, and the same `swiss_qr_reference_id` as the original. The original row is never mutated. Documented in `docs/25-swiss-qr-bill.md` §5.2.
- **Per-TxDtls granularity** — `camt_credit_entries` writes one row per `NtryDtls.TxDtls`, not per `Ntry`. Some banks batch multiple TxDtls under a single Ntry; per-TxDtls granularity preserves the donation-level audit trail. Documented in §5.4 step 4.a.
- **Partial-match handling** — match-by-amount is NEVER a reason to leave a credit unreconciled. When the printed expected amount is non-zero and the credited amount differs, the donation is STILL booked AND a `camt_unreconciled_entries(reason='partial_match', status='resolved')` row is written for the same credit entry so the operator surfaces the discrepancy in the queue. This is the only case where one credit entry creates both a donation and an unreconciled row. Documented in §5.4 step 4.d.
- **Rejected-XML storage** — XSD failures, unsupported schema versions, and foreign-IBAN file-level rejections all persist the raw XML to `{org_id}/camt053/rejected/{yyyy}/{mm}/{uuid}.xml` (same `bank-statements` bucket, same 10-year lifecycle) so the operator can audit *why* a file was rejected. The `camt_statements.status='failed'` row carries the rejection reason in `error`; structured logs at WARN/ERROR carry the parse details. Documented in `docs/25` §7.

These notes do NOT amend the Decision — they pin the concrete shape PR #5 ships where the original wording was a sketch.

### Parser library — fast-xml-parser (PR #5)

PR #5 ships `fast-xml-parser` as the primary parser instead of `libxmljs2` mentioned in the original Decision. Rationale:

- The §5.5 enrichment matrix needs deterministic access to `RltdPties.Dbtr.{Nm, PstlAdr.{StrtNm, BldgNb, PstCd, TwnNm, Ctry}, PstlAdr.AdrLine[]}` as bare data structures. `fast-xml-parser` exposes them directly; an iso20022.js-style wrapper would mediate through a typed surface that adds latency to per-field access.
- libxmljs2 carries a native libxml2 binding. fast-xml-parser is pure JS; one fewer build-environment concern (matters for the `pnpm test` matrix and for future Bun/Deno experimentation).
- **XXE / billion-laughs hardening:** fast-xml-parser disables DTD/entity resolution by default — the threat model that motivated libxmljs2's parse-flag tuning is mitigated by parser choice. If we ever swap back, the original Decision's hardening flags still apply.
- The parser interface in `packages/worker/src/services/camt053-parser.ts` exposes a swap-friendly surface: parser function + typed output. iso20022.js or libxmljs2 can replace fast-xml-parser as a single-file change.

XSD validation against the `camt.053.001.{04,08}.xsd` schemas is intentionally deferred — the parser's structural validation (namespace + root tag + required-field presence) already catches malformed XML, missing-namespace, and missing-required-field defects. Adding XSD on top is a future hardening if production sees XSD-passing-but-semantically-broken files.

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
