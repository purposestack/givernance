## ADR-025: PDF Rendering Code Boundary — Lockstep Duplicate vs. Extracted `@givernance/pdf` Package

**Status**: Accepted (Epic #286, 2026-05-05; revisit on the third PDF surface)
**Related**: ADR-013 (frontend type boundary — no Node-only deps in `@givernance/shared`), `docs/23-postal-campaigns.md` (postal-letter renderer), `docs/24-branding-assets.md` (logo embedding)

### Context

Today the postal-letter PDF renderer exists **twice** in the codebase, by design:

- `packages/api/src/modules/campaigns/postal-pdf.ts` — the **preview** path. Returns a PDF buffer inline to the operator's browser when they click "Aperçu" before validating a campaign.
- `packages/worker/src/services/campaign-pdf.ts` — the **bulk** path. Streams thousands of PDFs into the ZIP archive that the print shop receives.

Both files MUST produce **byte-equivalent output** for the same input. The operator validates a campaign by inspecting the preview; if the bulk path renders differently, the print shop receives letters that don't match what the operator approved. This invariant is documented at the top of each file with a "lockstep duplicate" banner and is the load-bearing reason both paths share their per-locale copy table verbatim (see `docs/23-postal-campaigns.md` § 1.ter).

Epic #286 (org-logo upload) adds a logo to the cover panel of the postal letter — `doc.image(buffer, PAGE_MARGIN, 60mm, { fit: [30mm, 30mm] })`. This change must land in **both** files in lockstep, doubling the surface area where drift can sneak in.

The natural reaction is "extract this into a shared package and stop the duplication." But the obvious target — `@givernance/shared` — is **forbidden** by ADR-013:

> The web bundle imports from `@givernance/shared`. Any Node-only runtime dependency in that package will either crash the browser bundle or, worse, leak server-only code (PDF generation logic, secrets) into the client through tree-shaking gaps.

PDFKit (and any realistic PDF library) is irreducibly Node-only. So `@givernance/shared` is off the table.

### Decision

**Keep the lockstep duplicate for now.** Do **not** extract postal-PDF logic into `@givernance/shared`. When a third PDF surface lands, extract into a **new** `@givernance/pdf` package, consumable by `packages/api` and `packages/worker` only — explicitly **not** by `packages/web`.

Today (postal letter — Epic #274 + #286): two files, in lockstep.

Soon (donor receipts — adds a second PDF surface): the receipts renderer joins, also as a lockstep file pair. Two surfaces is still tractable; the duplicate PDF utility code is small (margin constants, font registration, MM→PT conversion).

Future (annual giving statements, third PDF surface): extract `@givernance/pdf`. At that point, three duplicate copies of the PDFKit setup + locale lookup + logo embedding code is enough drift surface to justify a package. The package boundary is `api + worker`, never `web`.

```
packages/
  shared/          ← types, Zod, domain events. Web-importable. NO PDFKit.
  pdf/             ← (FUTURE) PDFKit setup, page constants, MM→PT, logo embed,
                     locale copy table. Consumed by api + worker. NOT web.
  api/             ← imports @givernance/shared + (future) @givernance/pdf
  worker/          ← imports @givernance/shared + (future) @givernance/pdf
  web/             ← imports @givernance/shared ONLY (ADR-013)
```

#### Parity-guard strategy

The lockstep risk during the two-surface period (postal + receipts) is real: a contributor changes one file and forgets the other. The mitigations:

- **Top-of-file banner** in each renderer flagging its lockstep counterpart and the rule.
- **CI parity test** (shipped — issue #289): `packages/api/src/modules/campaigns/postal-pdf.parity.test.ts` renders three frozen fixtures (named + logo + description / door-drop fallback copy / cross-border address) through BOTH files and asserts SHA-256 equality after masking the only legitimately-varying bytes (`/CreationDate`, `/ModDate`, and a future-proofing `/ID` mask). Object numbers, xref offsets, and stream contents are deliberately NOT stripped — a difference there is a real drift. Failing the test blocks the PR. Two self-tests guard the guard: a one-character copy change must fail, and two same-input renders through one path must hash-match (so a future PDFKit salt points at the canonicaliser, not at a phantom drift). The worker renderer is loaded via a runtime-computed dynamic import (test-only, api → worker) so the package boundary and the "worker never imports api" direction stay intact; a static cross-package import would fail `tsc --noEmit` with TS6059 by design.
- **Await-point alignment**: byte-equivalence requires more than identical drawing calls — the *position of `await` points relative to the drawing sequence* changes the order in which PDFKit flushes image XObjects into the file. The parity test caught exactly this on day one (the API path pre-generated the QR raster before the doc existed; the worker awaits it at CTA-panel time — visually identical, byte-permuted output whenever a logo made it a two-image document). Both files now generate the QR at panel-render time. When editing either file, keep async boundaries in lockstep too, not just the layout calls.
- **Reviewer checklist** in `CLAUDE.md`: any PR touching a postal-PDF file MUST also touch its counterpart, OR explain in the PR description why they're allowed to drift.

The parity guard becomes redundant once the extraction lands; until then it's the cheapest defence.

### Rationale

- **ADR-013 forbids Node-only deps in `@givernance/shared`.** The "obvious" extraction is therefore not available to us.
- **Two PDF surfaces is below the extraction threshold.** Three duplicate utility files is annoying; two is tolerable. The cost of premature packaging (new tsconfig, new build target, new pnpm workspace entry, new release coordination) outweighs the cost of one extra `Edit` per PR.
- **A future `@givernance/pdf` is the correct destination.** It cleanly captures the constraint ("Node-only PDFKit setup shared by api + worker") and survives any future re-organisation that adds more PDF consumers.
- **The lockstep convention already works for Epic #274.** The locale copy table has lived in two files for several months without observed drift, because the convention is documented at the top of each file and the seed-fixture test exercises both renderers.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Extract now into `@givernance/shared`** | One source of truth | Violates ADR-013; PDFKit in the web bundle either crashes the browser or bloats it with server code; potential to leak server secrets (font paths, S3 keys) into the client | **REJECTED** — breaks ADR-013 |
| **Extract now into a new `@givernance/pdf`** | Single source of truth, ADR-013-safe | Premature for two consumers; package overhead (build target, tsconfig, release flow) > lockstep cost; no third surface in sight today | **REJECTED for now** — revisit on third surface |
| **Symlink the file from one package to the other** | Cheap | Breaks tooling assumptions (TypeScript project references, Biome formatter, jest/vitest test discovery); fragile across OSes (Windows symlinks); confusing for new contributors | **REJECTED** |
| **Code-generate one from the other at build time** | Eliminates manual sync | New build step to maintain; debugging the generated file is unpleasant; the generation rules become their own bug surface | **REJECTED** |
| **Drop the preview path; serve the bulk-path output to the operator** | Single renderer | Bulk path is async (BullMQ job); operator can't preview without queueing a job; preview is supposed to be instant feedback during campaign validation. The split exists for UX reasons, not duplication-laziness | **REJECTED** — different latency budgets justify different code paths |

### Consequences

- **Reviewers MUST verify both files when changing one.** This is enforced socially (PR description + reviewer checklist) and mechanically (the CI parity test above — a one-sided edit fails the build).
- **The lockstep convention is brittle but bounded.** The duplicated logic is small (page constants, MM→PT, logo embedding, locale copy table); the bound on damage is the per-letter rendering surface.
- **The third-surface trigger is explicit.** When receipts ship and a third PDF surface is on the roadmap, the extraction MUST happen — at that point three lockstep files cross the cost-benefit line and the package overhead is amortised across enough consumers.
- **`packages/web` never imports PDFKit.** This is the durable invariant: ADR-013's frontend-type boundary is preserved by the topology of the package graph, not by per-file discipline.

### Revisit criteria

Reopen this ADR when:

- A **third PDF surface** lands (currently scheduled: donor receipts, then annual giving statements). At that point extract `@givernance/pdf` — the cost-benefit has flipped.
- The lockstep parity test (once added) **fails twice in a six-month window** for non-cosmetic reasons. Two real drifts in half a year means the social convention isn't holding and the extraction should happen ahead of the third-surface trigger.
- **PDFKit is replaced** by a non-Node renderer (e.g. a server-side WASM PDF library, or a managed service). At that point the ADR-013 constraint may relax and `@givernance/shared` becomes a possible host.
