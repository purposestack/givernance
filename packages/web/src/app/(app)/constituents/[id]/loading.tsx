/**
 * Constituent detail ghost loading state — rendered by Next.js while the
 * page's server data fetches run on navigation (ADR-035 rule A5:
 * data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx — breadcrumbs, the profile card (72px avatar +
 * name + badges + contact grid + action row), the AI suggestion card,
 * then the tabs region (TabsList pill strip + overview panel with its
 * 3-stat grid) — so real content replaces the ghosts with zero layout
 * shift (rule A6). The breadcrumb ghost is static structure (rule A1);
 * the three content blocks cascade subtly via `.cascade`, matching the
 * real page's profile → AI → tabs reveal order. Reduced motion collapses
 * the cascade globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const ACTION_GHOSTS = ["action-1", "action-2", "action-3"] as const;
const STAT_GHOSTS = ["stat-1", "stat-2", "stat-3"] as const;

export default function ConstituentDetailLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 sm:space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* Breadcrumbs ghost — static structure (rule A1). */}
      <div className="mb-2">
        <div className="ghost h-5 w-64 max-w-full" />
      </div>

      {/* Content blocks — same collapsed sibling spacing as the real
          page (mb-6 vs the shell's space-y both resolve to 24/32px). */}
      <div className="cascade space-y-6 sm:space-y-8">
        {/* Profile card ghost — avatar + name + badges + contacts + actions. */}
        <div className="flex flex-col gap-5 rounded-2xl bg-surface-container-lowest p-6 border border-border-brand md:flex-row md:items-start">
          {/* Avatar circle — plain bg (not .ghost) to keep rounded-full. */}
          <div className="h-[72px] w-[72px] shrink-0 rounded-full bg-surface-container" />
          <div className="min-w-0 flex-1">
            <div className="ghost h-9 w-64 max-w-full" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="ghost h-6 w-20" />
              <div className="ghost h-6 w-16" />
            </div>
            <div className="ghost mt-2 h-5 w-56 max-w-full" />
            <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <div className="ghost h-5 w-56 max-w-full" />
              <div className="ghost h-5 w-44 max-w-full" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0">
            {ACTION_GHOSTS.map((key) => (
              <div key={key} className="ghost h-[var(--btn-height-sm)] w-28" />
            ))}
          </div>
        </div>

        {/* AI suggestion card ghost. */}
        <div className="rounded-2xl border border-primary/20 bg-primary-50/40 p-5">
          <div className="ghost h-4 w-32" />
          <div className="ghost mt-2 h-5 w-full max-w-2xl" />
          <div className="mt-3 flex items-center gap-2">
            <div className="ghost h-[var(--btn-height-sm)] w-24" />
            <div className="ghost h-[var(--btn-height-sm)] w-20" />
          </div>
        </div>

        {/* Tabs region ghost — TabsList pill strip + overview panel. */}
        <div className="w-full">
          <div className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-surface-container-low p-1">
            <div className="ghost h-8 w-24" />
            <div className="ghost h-8 w-20" />
            <div className="ghost h-8 w-24" />
          </div>
          <div className="mt-4 rounded-2xl bg-surface-container-lowest p-6 border border-border-brand">
            <div className="ghost h-6 w-40 max-w-full" />
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {STAT_GHOSTS.map((key) => (
                <div key={key}>
                  <div className="ghost h-4 w-24" />
                  <div className="ghost mt-1 h-7 w-28 max-w-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
