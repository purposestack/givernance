## ADR-018: Offset Pagination for Phase 1 — Cursor Deferred

**Status**: Accepted (Phase 1 Sprint 5, issue #56 API #5)
**Related**: `docs/02-reference-architecture.md` (API design section), `docs/04-business-capabilities.md`

### Context

`docs/02` specified cursor pagination as the target for scale. Phase 1 Sprints 1–2 shipped offset-based (`page` / `perPage`) pagination on every list endpoint (`/v1/constituents`, `/v1/donations`, `/v1/campaigns`, `/v1/pledges`). PR #49 review flagged this as a gap: at tenant scale, offset pagination degrades (O(page) per request) and can produce duplicate / missing rows under concurrent writes. Reviewers asked us to either migrate to cursor now or document the decision with a revisit trigger.

### Decision

**Keep offset pagination through Phase 1. Migrate to cursor in Phase 2, scoped to endpoints that demonstrate the problem.**

- All existing list endpoints stay on `{ page, perPage, total, totalPages }`.
- New list endpoints follow the same shape unless the domain is strictly append-only (e.g. `GET /v1/audit-logs` when exposed publicly).
- Cursor migration is a per-endpoint opt-in — we don't flip the whole API at once.

### Why offset, for now

- **UI needs `total`.** Every dashboard view built from the existing Next.js mockups renders "Showing X–Y of N" and a pageable table. Cursor pagination without a separate `/count` call cannot provide this, and the count query is the exact work we'd try to avoid.
- **Tenant sizing.** Givernance tenants are 2–200 staff with ≤ 10k constituents / year. Offset cost is bounded by `page × perPage`; users rarely page past 5. The degradation case (page 900 on 50M rows) doesn't exist until we onboard multi-national federations — beyond Phase 1.
- **Write-concurrency drift is manageable.** Our list endpoints are `ORDER BY created_at DESC` (stable for hours after creation); a single UI client's requests fire fast enough that drift isn't the dominant UX issue.
- **Switching cost is one-way.** Once the client ships cursor support, reverting is painful. Offset → cursor is additive; cursor → offset regresses the `total` display.

### Rejected alternatives

- **Cursor everywhere, now.** Too large a client refactor for a gap that isn't biting, and we'd need `/count` endpoints to keep the UI honest — doubling request volume.
- **Hybrid (`cursor` when provided, else `page`).** A single endpoint with two pagination contracts is a documentation trap and a test-matrix nightmare.
- **Keyset on `(created_at, id)` without calling it cursor.** That *is* cursor by another name; not a real alternative.

### Revisit criteria

- Any list endpoint routinely serves pages > 200 and server-side p95 exceeds 500ms — migrate that endpoint to cursor.
- A federation / enterprise tenant lands with > 1M rows in any big table — migrate that table's list endpoint.
- `audit_logs` list endpoint exposed to customers — ship as cursor from day one.

### Consequences

- Phase 1 gets consistent UX with `total` counts and predictable page size.
- Implicit future Phase 2 task: build a `limit` + `before`/`after` cursor helper when an endpoint warrants it. Keep `PaginationQuery` / `PaginationSchema` live until then.

---

