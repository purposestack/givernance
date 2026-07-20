/**
 * Campaign detail ghost loading state — rendered by Next.js while the
 * page's server data fetches run on navigation (ADR-035 rule A5:
 * data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx — PageHeader (title + status-badge row +
 * actions), then the two-column grid: stats/status card stack in the
 * aside, description + ROI chart + cost breakdown + donation breakdown
 * in the main column — so real content replaces the ghosts with zero
 * layout shift (rule A6). Card frames render for real (container before
 * content, rule A3); the header ghost is static structure (rule A1) and
 * each column's cards cascade via `.cascade`, exactly like the real
 * page. The goal-meter track is a muted ghost stand-in (rule A5).
 * Reduced motion collapses the cascade globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const COST_GHOSTS = ["cost-1", "cost-2", "cost-3"] as const;
const DONATION_ROW_GHOSTS = ["row-1", "row-2", "row-3", "row-4"] as const;

export default function CampaignDetailLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 sm:space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* PageHeader ghost — breadcrumbs / title / badge row + actions. */}
      <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="ghost mb-2 h-5 w-44 max-w-full" />
          <div className="ghost h-10 w-64 max-w-full sm:h-14 sm:w-80" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="ghost h-6 w-20" />
            <div className="ghost h-6 w-24" />
          </div>
        </div>
        <div className="flex w-full justify-end gap-2 sm:w-auto">
          <div className="ghost h-[var(--btn-height-sm)] w-24" />
          <div className="ghost h-[var(--btn-height-sm)] w-28" />
          <div className="ghost h-[var(--btn-height-sm)] w-36" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        {/* Aside — stats card + status card. */}
        <div className="cascade space-y-6">
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="ghost h-6 w-32 max-w-full" />
            <div className="mt-5 space-y-4">
              {/* Goal progress block — muted meter track (rule A5). */}
              <div className="rounded-xl bg-surface-container p-4">
                <div className="ghost h-5 w-24" />
                <div className="ghost mt-1 h-8 w-36 max-w-full" />
                <div className="mt-3 h-2 rounded-md bg-surface-container-highest" />
                <div className="ghost mt-2 h-4 w-full max-w-64" />
              </div>
              <div className="rounded-xl bg-surface-container p-4">
                <div className="ghost h-5 w-20" />
                <div className="ghost mt-1 h-8 w-24" />
                <div className="ghost mt-1 h-4 w-32" />
              </div>
              <div className="rounded-xl bg-surface-container p-4">
                <div className="ghost h-5 w-24" />
                <div className="ghost mt-1 h-8 w-40 max-w-full" />
                <div className="ghost mt-1 h-4 w-36" />
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="ghost h-6 w-36 max-w-full" />
            <div className="ghost mt-1.5 h-5 w-full max-w-56" />
            <div className="mt-5 space-y-2">
              <div className="ghost h-[var(--btn-height-sm)] w-full" />
              <div className="ghost h-[var(--btn-height-sm)] w-full" />
            </div>
          </div>
        </div>

        {/* Main column — description / ROI chart / cost breakdown / donations. */}
        <div className="cascade space-y-6">
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="ghost h-6 w-40 max-w-full" />
            <div className="ghost mt-1.5 h-5 w-64 max-w-full" />
            <div className="mt-5 space-y-2">
              <div className="ghost h-5 w-full" />
              <div className="ghost h-5 w-2/3" />
            </div>
          </div>
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="ghost h-6 w-44 max-w-full" />
            <div className="ghost mt-1.5 h-5 w-64 max-w-full" />
            {/* Chart region ghost — bar-chart-shaped block. */}
            <div className="ghost mt-5 h-48 w-full" />
          </div>
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="ghost h-6 w-48 max-w-full" />
                <div className="ghost mt-2 h-5 w-64 max-w-full" />
              </div>
              <div className="ghost h-12 w-full sm:max-w-52 lg:w-44" />
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              {COST_GHOSTS.map((key) => (
                <div key={key} className="rounded-xl bg-surface-container p-4">
                  <div className="ghost h-5 w-24" />
                  <div className="ghost mt-1 h-8 w-28 max-w-full" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="ghost h-6 w-48 max-w-full" />
                <div className="ghost mt-1 h-5 w-36" />
              </div>
              <div className="ghost h-[var(--btn-height-sm)] w-24" />
            </div>
            <div className="overflow-hidden rounded-xl border border-outline-variant/50">
              <div className="bg-surface-container-low px-4 py-3">
                <div className="ghost h-4 w-full max-w-2xl" />
              </div>
              {DONATION_ROW_GHOSTS.map((key) => (
                <div
                  key={key}
                  className="flex items-center gap-6 border-t border-outline-variant/50 px-4 py-4"
                >
                  <div className="ghost h-5 w-24 shrink-0" />
                  <div className="ghost h-5 w-40 max-w-[35%]" />
                  <div className="ghost ml-auto h-5 w-20 shrink-0" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
