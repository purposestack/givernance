## ADR-038: Terraform for durable cloud resources — the Terraform/Kamal boundary and the S3 state backend

**Status**: Accepted (Issue #564, 2026-07-28)
**Related**: ADR-009 (Scaleway as primary SaaS cloud — Terraform provisions *on* it, never replaces it), ADR-023 (bucket topology — the first module, `branding-bucket`, encodes one of its visibility classes), ADR-034 (SeaweedFS for self-hosted tiers — its `init.sh` provisioning is **on the Kamal side** of the boundary drawn here), CLAUDE.md § "Kamal config keys must be valid for the PINNED version" (the schema-validated-config failure class this ADR's CI gate addresses)

### Context

PR #557 (issue #291) shipped the repo's **first infrastructure-as-code artefact**: [`infra/terraform/branding-bucket/`](../../infra/terraform/branding-bucket/), provisioning the public-read prod `branding` bucket on Scaleway. It was the right call for its scope — Kamal deploys containers and has no vocabulary for "this bucket is public-read with these CORS origins and no expiry lifecycle", and the alternative was console clicking, where ACL drift is silent until a GDPR audit finds it.

But it landed as an island, in an infra estate that is otherwise split four ways:

| Concern | Managed by |
|---|---|
| App + accessories (Postgres, Redis, Keycloak, SeaweedFS) | Kamal — `config/deploy-staging.yml` |
| Dev/staging bucket provisioning | shell — `infra/seaweedfs/init.sh` + `s3config.json` |
| Prod buckets `receipts` / `campaigns` / `bank-statements` | `aws s3api`, by hand |
| VPS, DNS, Cockpit | Scaleway console, by hand |
| Prod `branding` bucket | **Terraform** (new) |

Partial adoption left two structural gaps (issue #564): **no state backend** — `terraform apply` wrote state to the applying operator's laptop, with no locking, no shared visibility, and a lost-state file bricking the module (Scaleway bucket names are region-global, so a re-create plan fails outright against the live donor-facing bucket) — and **no ADR** ratifying the tool choice or drawing the line between Terraform and Kamal, without which the next infra change either regresses to the console or starts terraforming things Kamal already owns.

### Decision

Three rulings, one per gap plus the standing gate:

**1. The boundary — who owns what:**

> **Terraform owns cloud resources that outlive a deployment** — object-storage buckets, DNS, CDN, managed databases/Redis, and any resource whose drift is invisible until an audit or an outage.
> **Kamal owns everything shipped with the app** — containers, accessories, proxy routes, env vars, and anything re-created by the next `kamal deploy`.

Corollaries: `infra/seaweedfs/init.sh` stays shell — it provisions *inside* a Kamal-managed accessory on the self-hosted tiers, so it lives and dies with the deployment (Kamal side). The hand-rolled `aws s3api` prod buckets (`receipts`, `campaigns`, `bank-statements`) are on the Terraform side of the line and get absorbed module by module (issue #564 gap 3; `bank-statements` first — 10-year lifecycle, versioning + MFA-delete, and an explicit public-access deny are too much posture to hold by hand). VPS + Cockpit may legitimately stay manual until their churn settles — being on the Terraform side of the line makes them *eligible*, not mandatory.

**2. State lives in a shared, versioned Scaleway Object Storage bucket** — `givernance-terraform-state` (fr-par, private, bucket versioning ON), declared as a full `backend "s3"` block in each module's `versions.tf` with a **committed, non-optional default** (no `-backend-config` incantations to get wrong). One key per module: `<module>/terraform.tfstate`. Locking uses Terraform ≥ 1.10's S3-native `use_lockfile` (conditional writes) — no DynamoDB equivalent exists on Scaleway, and a lock failure is loud at plan time, never silent. The state bucket itself is the **one hand-provisioned bootstrap resource** (Terraform cannot manage the bucket its own state lives in); its one-shot `aws s3api` bring-up is documented in [`branding-bucket-prod-bringup.md`](../runbooks/branding-bucket-prod-bringup.md) § 1a.

**3. HCL gets a CI validation job, now, not "once there is more than one module".** [`terraform-validate.yml`](../../.github/workflows/terraform-validate.yml) runs `terraform fmt -check` + `init -backend=false` + `validate` on every PR touching `infra/terraform/**`, pinned inside the floor minor of `required_version` so the floor stays honest. Rationale: HCL is a schema-validated config surface with the *exact* failure mode that cost days of broken staging deploys when an unknown Kamal key shipped unvalidated — and unlike Kamal, Terraform's blast radius is live donor-facing prod resources. `plan`/`apply` stay deliberate operator actions: CI holds no cloud credentials, by design. `.terraform.lock.hcl` is committed with multi-platform hashes (`linux_amd64` for CI, `darwin_*` for operators) so CI and operators validate the same provider build.

Two honest limits of this gate, so nobody over-trusts it:

- **The `backend "s3"` block is CI-blind.** `init -backend=false` skips backend schema-checking entirely — a typo'd or too-new backend key passes CI green and first fails at the operator's real `terraform init`. There is no offline backend-schema check in Terraform; the runbook's § 1b `init` is where the backend block gets validated, which is why it sits *before* `plan` in the bring-up order.
- **The job is advisory until a branch ruleset requires it.** `main` currently has no branch protection, so a red `validate` (like every other check in this repo, `api-tests-app` included) blocks nothing mechanically — review discipline is the enforcement. If/when checks become required, this workflow must first be converted from workflow-level `paths:` filtering to the in-job `dorny/paths-filter` pattern already used by `deploy-staging.yml` — a required-but-path-skipped check would otherwise wedge every non-Terraform PR on a forever-"Expected" status.

### Alternatives matrix

| Candidate | State + locking | Scaleway coverage | Drift detection (`plan`) | License | Operational weight | Verdict |
|-----------|----------------|-------------------|--------------------------|---------|--------------------|---------|
| **Terraform + S3 backend** | ✅ versioned bucket + native lockfile | ✅ first-party `scaleway/scaleway` provider | ✅ | BUSL 1.1 (fine for internal use) | 1 binary + 1 bucket | ✅ **CHOSEN** |
| OpenTofu | ✅ same | ✅ same provider registry | ✅ | MPL 2.0 | same | ➖ drop-in fallback if BUSL ever bites (see revisit criteria); no reason to diverge from the ecosystem default today |
| Pulumi | ✅ (managed or S3) | ✅ (bridged provider) | ✅ | Apache 2.0 (engine) | new language runtime + SDK in the repo | ❌ a general-purpose-language IaC runtime for ~4 bucket resources is weight without benefit |
| `scw` CLI / `aws s3api` scripts (status quo) | ❌ none | ✅ | ❌ imperative, no diff | — | none | ❌ no drift detection is the disease: "MUST be matched in prod via bucket policy" review comments instead of code |
| Scaleway console | ❌ | ✅ | ❌ | — | none | ❌ silent ACL drift on a public-read donor-facing bucket; the thing PR #557 existed to end |
| Terraform Cloud (state) | ✅ managed | n/a (state only) | ✅ | SaaS | new US-company SaaS dependency | ❌ a third-party state host for a GDPR-native EU product when a 5-line S3 backend on the existing Scaleway DPA does the job |

### Rejected alternatives

- **Keeping the backend undeclared ("operator decides at init")** — the PR #557 stance. Rejected by experience: the default is laptop state, which means no locking, no shared `plan`, and a lost laptop bricking the module against a region-global bucket name. A committed default the operator *can* override beats a blank the operator *must* fill.
- **`-backend-config` partial configuration** — keeps the module "reusable across environments", but this module *is* single-environment (prod; dev/staging get the bucket from SeaweedFS's init). Reusability that will never be exercised is not worth an un-committed, mis-typeable init incantation on the critical path of a prod bring-up.
- **Terraforming the state bucket itself** — chicken-and-egg; a bootstrap module with local state re-imports the same problem one level down. One documented `aws s3api` one-shot is honest about being a bootstrap.
- **DynamoDB-style lock table** — does not exist on Scaleway; `use_lockfile` (TF ≥ 1.10) covers the need with zero extra infrastructure.
- **Deferring the CI job until a second module exists** — the module README already carried a ⚠ "no CI validates HCL" warning; a standing warning that CI could replace is tech-debt by choice. The job is ~30 lines and loops over modules, so the second module costs zero workflow edits.

### Consequences

- **The first prod `terraform apply` is unblocked** — the bring-up runbook gains a § 1a (state-bucket bootstrap + `AWS_*` credential aliasing) ahead of the `init`/`apply` steps, and gap 1 of issue #564 closes.
- **`required_version` floor rises `1.6` → `1.10`** (for `use_lockfile`). CI pins the floor version; raising the floor and the pin together is a deliberate, reviewed act.
- **Every future module inherits the pattern**: full backend block, own state key in `givernance-terraform-state`, committed multi-platform lockfile, automatic CI coverage via the `infra/terraform/*/` loop.
- **Two credential env conventions coexist** — the scaleway provider reads `SCW_*`, the generic S3 backend reads `AWS_*`; the runbook aliases one from the other. Mildly ugly, standard for every non-AWS S3 backend, documented once.
- **The state file is a new sensitive artefact** — it holds resource metadata (bucket names, CORS origins; no secrets for current modules, but future modules may leak more). The bucket is private, versioned, and covered by the existing Scaleway DPA; treat state-bucket read access as operator-level.
- **Absorption debt is explicit, not implied**: `receipts` / `campaigns` / `bank-statements`, then DNS/CDN, remain hand-rolled until their modules land (issue #564 gap 3) — the boundary rule makes them *Terraform-eligible*, this ADR does not silently claim them.

### Revisit criteria

Reopen this ADR when:

- **HashiCorp's BUSL posture changes** in a way that affects internal use, or the `scaleway/scaleway` provider's cadence on Terraform diverges from OpenTofu's registry — the OpenTofu column above is the pre-approved exit.
- **Scaleway ships a managed state/locking primitive** (or rejects the conditional-write locking in practice) — the `use_lockfile` choice is the most Scaleway-behaviour-dependent line in this ADR.
- **A module needs secrets in state** (managed-database passwords, API tokens) — private-bucket-plus-versioning may no longer be enough; state encryption or a different backend comes into scope.
- **The self-hosted distribution needs IaC** — today Terraform is SaaS-prod-only by construction (self-hosters get Compose + `init.sh`); an NPO asking for terraformed self-hosting would need a provider-agnostic rethink.
