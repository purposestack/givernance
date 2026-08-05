## ADR-039: Keycloak Admin Client Fork — Lockstep Duplicate vs. Extracted `@givernance/keycloak-admin` Package

**Status**: Accepted (issue #292, 2026-08-05; revisit when the extraction trigger fires)
**Related**: ADR-013 (frontend type boundary — no Node-only deps in `@givernance/shared`), ADR-016 (tenant onboarding — the api client's origin), ADR-025 (the `@givernance/pdf` trigger pattern this ADR reuses), `docs/24-branding-assets.md` (the worker's `keycloak.sync_org_logo` job)

### Context

The Keycloak Admin REST client exists **twice** in the codebase, by design:

- `packages/api/src/lib/keycloak-admin.ts` (~940 lines) — the **canonical** client. Full-featured: `client_credentials` token caching with early-refresh margin, in-flight request deduplication, conservative retry policy (5xx/429/network on idempotent methods only; POST never retried on 5xx), a circuit breaker, and structured pino logging with secret redaction. Consumed by the signup, invitations, tenant-admin, and platform-admins modules.
- `packages/worker/src/lib/keycloak-admin.ts` (~175 lines) — a **stripped-down fork** added by PR #287 (Epic #286, org-logo sync). It reproduces only the slice the `keycloak.sync_org_logo` processor needs: token cache with safety margin, retry-once-on-401 token rotation, and the `getOrganization` + `updateOrganization` GET-then-PUT attribute merge, idempotent on 404. No circuit breaker, no in-flight dedup, no retry-on-5xx.

The fork exists because neither "obvious" de-duplication is available:

- **The worker cannot import from `packages/api/*`** — the dependency direction is api → worker via queues, never worker → api. A static cross-package import would also break TypeScript project references (same TS6059 mechanism ADR-025 leans on for the PDF parity test).
- **The client cannot be hoisted to `@givernance/shared`** — ADR-013 forbids Node-only runtime code in the one package the web bundle imports. An HTTP admin client carrying `env` access and admin-credential handling is exactly what must never be tree-shaken into a browser bundle.

The **security-critical slice is already un-forked**: `SAFE_ORG_ATTRIBUTES` + `assertSafeOrgAttributes` (the allowlist that keeps secrets out of Keycloak Organization attributes — issue #114) live in `@givernance/shared/constants/keycloak-org-attributes` and are imported by both copies. The guard cannot drift; only the transport/behaviour layer around it can.

What *can* drift is real, though: the 401-rotate-retry shape, the token-cache safety margin, 404-idempotence semantics, and any future KC quirk fixed on one side only (e.g. a 401-then-rotate edge case patched in the api client after an incident, silently absent from the worker copy until the next `sync_org_logo` failure).

### Decision

**Keep the fork for now.** Two consumers is below the extraction threshold — the same cost-benefit call as ADR-025's two-PDF-surface period. Do **not** extract pre-emptively, do **not** import across the worker/api boundary, do **not** hoist to `@givernance/shared`.

**Extract into a new `@givernance/keycloak-admin` package when either trigger fires:**

1. **A third consumer of the KC Admin API lands** — e.g. a CLI tool, the migrate package needing org provisioning, or a separate service; or
2. **A KC-related bug needs a two-file fix** for the *second* time — i.e. the second occasion on which the same behavioural change must be applied to both copies. (The first two-file fix is tolerable; the second proves the fork is drifting faster than the convention can hold, same logic as ADR-025's "parity test fails twice in six months" criterion.)

When the trigger fires, the extraction target is:

```
packages/
  shared/            ← types, Zod, domain events. Web-importable. NO admin client.
                       (keeps SAFE_ORG_ATTRIBUTES + assertSafeOrgAttributes — web-safe pure code)
  keycloak-admin/    ← (FUTURE) token cache, retry/rotation, circuit breaker,
                       Organizations/IdP/member operations. Node-only.
                       Consumed by api + worker. NOT web (ADR-013).
  api/               ← imports @givernance/shared + (future) @givernance/keycloak-admin
  worker/            ← imports @givernance/shared + (future) @givernance/keycloak-admin
  web/               ← imports @givernance/shared ONLY (ADR-013)
```

The extracted package ships the **full-featured** behaviour (circuit breaker, dedup, retry policy) for both consumers — the worker inherits the protections it currently lacks, which is a side benefit of extraction, not a reason to extract early.

#### Drift-guard strategy until then

- **Top-of-file banner** in each copy naming its counterpart, this ADR, and the two-condition trigger — so the engineer making the *first* two-file fix knows they are one fix away from mandatory extraction.
- **Shared allowlist stays shared.** Any new attribute-safety or input-validation logic goes into `@givernance/shared/constants`, never into either fork copy. Pure, web-safe validation code is the one slice that must never be duplicated.
- **PR discipline**: a PR changing KC admin *behaviour* (token handling, retry shape, error mapping — not endpoint additions the other side doesn't need) in one file MUST either apply it to the counterpart or state in the PR description why the copies are allowed to diverge. Endpoint surface is expected to differ (the worker needs 2 of the api's ~15 operations); cross-cutting behaviour is not.

### Rationale

- **Two consumers is premature for a fourth workspace package.** New tsconfig + build target + pnpm workspace entry + release coordination costs more than the occasional lockstep edit, exactly as ADR-025 concluded for the PDF pair.
- **The fork is small and intentionally minimal.** ~175 lines, two operations. The worker copy's *lack* of circuit breaker/dedup is acceptable for a low-frequency BullMQ job with its own retry/backoff semantics (BullMQ attempts + ADR-020 dead-letter handling already bound the blast radius).
- **The dangerous slice is already extracted.** The attribute allowlist — the piece where drift is a *security* bug rather than a reliability bug — lives in shared. What remains fork-able is reliability behaviour, where drift degrades gracefully (a job retry) rather than catastrophically (a secret in a JWT).
- **An explicit trigger beats a standing "someday".** ADR-025 proved the pattern: naming the exact conditions under which extraction becomes mandatory prevents both premature packaging and indefinite drift-by-default.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Extract `@givernance/keycloak-admin` now** | Single source of truth; worker gains circuit breaker + dedup | Package overhead for exactly two consumers, one of which needs 2 operations; no third consumer in sight | **REJECTED for now** — revisit on trigger |
| **Worker imports the api client directly** | Zero duplication | Breaks the worker → api dependency direction; couples worker builds to api internals; TS project-reference violation | **REJECTED** |
| **Hoist the client into `@givernance/shared`** | Both consumers already depend on shared | ADR-013 violation — Node-only admin-credential code in the web-importable package | **REJECTED** — breaks ADR-013 |
| **Worker calls an internal api endpoint instead of KC directly** | One KC client total | Invents a new internal auth surface + availability coupling (worker jobs fail when api deploys); the worker exists precisely to do async work off the api's critical path | **REJECTED** |
| **Symlink / codegen one copy from the other** | Mechanical sync | Same tooling/debugging objections as ADR-025 (project references, Biome, test discovery, cross-OS) | **REJECTED** |

### Consequences

- **The fork is legitimate and bounded** — reviewers should not flag the duplication as an oversight; they should check the banner is intact and behaviour changes are mirrored.
- **The first two-file KC fix must be logged.** Whoever makes it should note "first two-file fix — ADR-039 trigger is now half-armed" in the PR description, so the *second* one is recognisable as the trigger rather than routine.
- **Extraction, when it happens, is mandatory, not optional.** Once either condition fires, the next KC-touching PR carries the extraction (or is blocked on a PR that does).
- **`packages/web` never sees the admin client.** As with ADR-025, the durable invariant is enforced by package topology, not per-file discipline.

### Revisit criteria

Reopen this ADR when:

- Either **extraction trigger fires** (third consumer, or second two-file behavioural fix) — the decision flips to "extract now".
- **Keycloak is replaced or its Admin API is dropped** (e.g. a move off KC Organizations) — the fork and the trigger both dissolve.
- **The worker's KC surface grows past attribute sync** (member management, IdP operations) — a widening worker slice weighs like a third consumer even if package count stays at two.
