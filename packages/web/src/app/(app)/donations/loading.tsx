/**
 * Donations list ghost loading state — rendered by Next.js while the
 * page's server data fetch runs on navigation (ADR-035 rule A5:
 * data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx + ./donations-table.tsx — PageHeader, the
 * date-range FilterBar, then the search row and the DataTable frame
 * with its toolbar, header row, and six comfortable-density rows
 * (text-only cells, `py-4` ≈ 52px) — so real content replaces the
 * ghosts with zero layout shift (rule A6). The header/filter ghosts are
 * static structure (rule A1); only the row ghosts cascade subtly via
 * `.cascade`. Reduced motion collapses the cascade globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const ROW_GHOSTS = ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"] as const;

export default function DonationsLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 sm:space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* PageHeader ghost — breadcrumbs / title / subtitle + primary action. */}
      <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="ghost mb-2 h-5 w-44 max-w-full" />
          <div className="ghost h-10 w-64 max-w-full sm:h-14 sm:w-80" />
          <div className="ghost mt-2 h-7 w-72 max-w-full" />
        </div>
        <div className="flex w-full justify-end gap-2 sm:w-auto">
          <div className="ghost h-[var(--btn-height-sm)] w-40" />
        </div>
      </div>

      {/* FilterBar ghost — the two date-range fields (h-8 inputs). */}
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-border-brand bg-surface-container-lowest px-4 py-3">
        <div className="ghost h-8 w-52 max-w-full" />
        <div className="ghost h-8 w-52 max-w-full" />
      </div>

      <div>
        {/* Search row ghost — search input + receipt-status select. */}
        <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="ghost h-[var(--input-height)] flex-1" />
          <div className="ghost h-[var(--input-height)] w-full sm:w-[180px]" />
        </div>

        {/* DataTable ghost — toolbar / header row / 6 comfortable rows. */}
        <div className="overflow-hidden rounded-2xl border border-border-brand bg-surface-container-lowest">
          <div className="flex items-center justify-between gap-3 border-b border-border-brand px-5 py-4">
            <div className="ghost h-5 w-44 max-w-full" />
            <div className="ghost h-5 w-16 shrink-0" />
          </div>
          <div className="bg-surface-container-low px-5 py-3">
            <div className="ghost h-4 w-full max-w-3xl" />
          </div>
          <div className="cascade">
            {ROW_GHOSTS.map((key) => (
              <div
                key={key}
                className="flex items-center gap-6 border-t border-border-brand px-5 py-4"
              >
                <div className="ghost h-5 w-28 shrink-0" />
                <div className="ghost h-5 w-40 max-w-[30%]" />
                <div className="ghost ml-auto h-5 w-20 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
