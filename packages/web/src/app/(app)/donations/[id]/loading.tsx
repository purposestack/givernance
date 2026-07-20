/**
 * Donation detail ghost loading state — rendered by Next.js while the
 * page's server data fetch runs on navigation (ADR-035 rule A5:
 * data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx — PageHeader (title + donor subtitle + the
 * back / edit / receipt action row), then the two-column card grid:
 * the info card's stacked detail rows and the allocations card's table
 * (header + rows + total) — so real content replaces the ghosts with
 * zero layout shift (rule A6). The header ghost is static structure
 * (rule A1); the two cards cascade subtly via `.cascade`, matching the
 * real page. Reduced motion collapses the cascade globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const DETAIL_ROW_GHOSTS = [
  "detail-1",
  "detail-2",
  "detail-3",
  "detail-4",
  "detail-5",
  "detail-6",
  "detail-7",
  "detail-8",
] as const;
const ALLOCATION_ROW_GHOSTS = ["alloc-1", "alloc-2", "alloc-3"] as const;

export default function DonationDetailLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 sm:space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* PageHeader ghost — breadcrumbs / title / donor + action row. */}
      <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="ghost mb-2 h-5 w-44 max-w-full" />
          <div className="ghost h-10 w-64 max-w-full sm:h-14 sm:w-80" />
          <div className="ghost mt-2 h-7 w-56 max-w-full" />
        </div>
        <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
          <div className="ghost h-[var(--btn-height-sm)] w-24" />
          <div className="ghost h-[var(--btn-height-sm)] w-28" />
          <div className="ghost h-[var(--btn-height-sm)] w-36" />
        </div>
      </div>

      <div className="cascade grid gap-6 md:grid-cols-2">
        {/* Info card ghost — heading + stacked detail rows. */}
        <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-6">
          <div className="ghost mb-4 h-6 w-40 max-w-full" />
          <div className="space-y-3">
            {DETAIL_ROW_GHOSTS.map((key) => (
              <div
                key={key}
                className="flex items-baseline gap-3 border-b border-outline-variant/50 pb-2 last:border-b-0"
              >
                <div className="ghost h-5 w-40 shrink-0" />
                <div className="ghost h-5 w-32 max-w-full" />
              </div>
            ))}
          </div>
        </div>

        {/* Allocations card ghost — heading + table (header / rows / total). */}
        <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-6">
          <div className="ghost mb-4 h-6 w-44 max-w-full" />
          <div>
            <div className="flex items-center gap-6 border-b border-outline-variant pb-3">
              <div className="ghost h-4 w-24" />
              <div className="ghost ml-auto h-4 w-20 shrink-0" />
              <div className="ghost h-4 w-12 shrink-0" />
            </div>
            {ALLOCATION_ROW_GHOSTS.map((key) => (
              <div
                key={key}
                className="flex items-center gap-6 border-b border-outline-variant/50 py-3"
              >
                <div className="ghost h-5 w-32 max-w-[40%]" />
                <div className="ghost ml-auto h-5 w-20 shrink-0" />
                <div className="ghost h-5 w-10 shrink-0" />
              </div>
            ))}
            <div className="flex items-center gap-6 py-3">
              <div className="ghost h-5 w-16" />
              <div className="ghost ml-auto h-5 w-20 shrink-0" />
              <div className="ghost h-5 w-10 shrink-0" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
