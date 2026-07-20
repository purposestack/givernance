/**
 * Dashboard ghost loading state — rendered by Next.js while the page's
 * server data fetches run on navigation (ADR-035 rule A5: data-shaped
 * ghosts, no shimmer, no spinner). Mirrors the final geometry of
 * ./page.tsx exactly — greeting header, 4-card KPI grid, then the two
 * section rows — so the real content replaces the ghosts with zero
 * layout shift (rule A6). Card frames render for real (container before
 * content, rule A3); ghost blocks are content and cascade subtly via
 * `.cascade`. Reduced motion collapses the cascade globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const KPI_GHOSTS = ["kpi-1", "kpi-2", "kpi-3", "kpi-4"] as const;
const FEED_GHOSTS = ["feed-1", "feed-2", "feed-3", "feed-4", "feed-5"] as const;
const ACTION_GHOSTS = ["action-1", "action-2", "action-3"] as const;
const CAMPAIGN_GHOSTS = ["campaign-1", "campaign-2"] as const;
const CHECKLIST_GHOSTS = ["check-1", "check-2", "check-3"] as const;

export default function DashboardLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 sm:space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* Greeting header ghost — h1 (text-4xl → sm:text-5xl) + subtitle. */}
      <div>
        <div className="ghost h-10 w-72 max-w-full sm:h-14 sm:w-96" />
        <div className="ghost mt-2 h-6 w-full max-w-3xl sm:h-7" />
      </div>

      {/* KPI stat grid — real card frames (StatCard geometry), ghost content. */}
      <div className="cascade grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPI_GHOSTS.map((key) => (
          <div
            key={key}
            className="min-h-36 rounded-2xl border border-border-brand bg-surface-container-lowest p-5"
          >
            <div className="flex items-center justify-between">
              <div className="ghost h-4 w-24" />
              <div className="ghost h-10 w-10" />
            </div>
            <div className="ghost mt-3 h-10 w-32 max-w-full" />
            <div className="ghost mt-2 h-5 w-40 max-w-full" />
          </div>
        ))}
      </div>

      {/* Row 1 — recent donations feed + quick actions. */}
      <div className="cascade grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
          <div className="ghost h-6 w-48 max-w-full" />
          <div className="mt-4 divide-y divide-outline-variant/50">
            {FEED_GHOSTS.map((key) => (
              <div key={key} className="flex items-center justify-between gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className="ghost h-5 w-40 max-w-full" />
                  <div className="ghost mt-1 h-4 w-24" />
                </div>
                <div className="ghost h-5 w-16 shrink-0" />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
          <div className="ghost h-6 w-40 max-w-full" />
          <div className="ghost mt-1 h-4 w-56 max-w-full" />
          <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
            {ACTION_GHOSTS.map((key) => (
              <div key={key} className="ghost h-[var(--btn-height-md)]" />
            ))}
          </div>
        </div>
      </div>

      {/* Row 2 — active campaigns + AI suggestion / onboarding stack. */}
      <div className="cascade grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
          <div className="ghost h-6 w-48 max-w-full" />
          <div className="mt-5 space-y-4">
            {CAMPAIGN_GHOSTS.map((key) => (
              <div key={key} className="rounded-2xl border border-outline-variant/60 p-4 sm:p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="ghost h-5 w-44 max-w-full" />
                    <div className="ghost mt-1 h-4 w-32" />
                  </div>
                  <div className="ghost h-5 w-16 shrink-0" />
                </div>
                {/* Muted meter track — ghost stand-in for the progress fill (rule A5). */}
                <div className="ghost mt-4 h-2" />
                <div className="ghost mt-2 h-4 w-40 max-w-full" />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-primary/20 bg-ai-bg p-5 sm:p-6">
            <div className="ghost h-6 w-40 max-w-full" />
            <div className="ghost mt-3 h-5 w-full" />
            <div className="ghost mt-1 h-5 w-2/3" />
          </div>
          <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5 sm:p-6">
            <div className="ghost h-6 w-40 max-w-full" />
            <div className="ghost mt-1 h-4 w-56 max-w-full" />
            <div className="mt-4 space-y-3">
              {CHECKLIST_GHOSTS.map((key) => (
                <div key={key} className="ghost h-5 w-48 max-w-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
