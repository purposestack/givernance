## ADR-019: Cross-Tenant Foreign-Key Violations Return 404 (Not 422)

**Status**: Accepted (Phase 1 Sprint 5, issue #56 Data)
**Related**: `docs/06-security-compliance.md` (tenant isolation)

### Context

`POST /v1/donations` accepted a `campaignId` / `fundId` that existed in *another* tenant: the FK passed (the id is a real UUID), and our tenant-scoped write landed a donation bound to a different tenant's campaign (QA review of PR #53, issue #56 Data #1/#2). We are adding explicit `assertCampaignBelongsToOrg` / `assertFundsBelongToOrg` checks in the donation service. Question: what HTTP status should the route return for a cross-tenant reference?

### Decision

**Return 404 Not Found for any reference to a resource that exists in another tenant.**

Applied uniformly across cross-tenant FK violations: `campaignId`, `fundId`, and any future FK the services validate themselves. The response body uses the problem+json shape with the same `detail` a genuinely-missing resource returns.

### Why 404 over 422 / 403

- **Existence leakage is the threat model.** An attacker enumerating UUIDs to fish for cross-tenant resources only needs a status-code difference to distinguish "doesn't exist" from "exists elsewhere." 404 for both denies that signal.
- **422 Unprocessable Entity** would fit if the FK were *structurally* wrong (bad UUID format). "UUID is syntactically fine, just not yours" is a semantic mismatch: from the client's reachable graph, the resource doesn't exist.
- **403 Forbidden** implies the client *could* have authorised this with more permissions. They cannot — cross-tenant access is structurally impossible.
- **Industry precedent.** Stripe, GitHub, Notion all 404 for cross-account references.

### Exception: malformed UUIDs

Bad UUID format fails TypeBox validation → 400 Bad Request. Cross-tenant semantics only apply when the id *is* a valid UUID and *does* name a real row elsewhere.

### Rejected alternatives

- **422 everywhere.** Leaks existence.
- **403 with a generic body.** Reveals the id as "reachable in principle" and tells the client the wrong fix.
- **Same 404 envelope with a distinct `detail`.** The `detail` string is part of the observable response; matching the "genuine 404" detail is a small defence-in-depth choice.

### Consequences

- A client that typoed a UUID they do own gets the same 404 as a cross-tenant attempt — negligible UX cost.
- Server logs still carry `orgId`, id, resource type so operators can distinguish the cases at support time. The asymmetry is only public.

---

