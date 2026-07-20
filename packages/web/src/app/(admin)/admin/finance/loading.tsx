/**
 * Back Office › Platform finance ghost loading state — rendered by
 * Next.js while the page's SSR summary fetch runs on navigation
 * (ADR-035 rule A5: data-shaped ghosts, no shimmer, no spinner).
 * Approximates the final geometry of ./finance-dashboard.tsx — the
 * live-status chip, the page header (eyebrow / large title / subtitle +
 * action buttons), the period toolbar (segmented control + two
 * filters), then the content: 3-block mobilisation hero, 4-card KPI
 * grid, a section head, and the volume/revenue chart card — so real
 * content replaces the ghosts with minimal layout shift (rule A6). The
 * dashboard's exact metrics live in its colocated mockup CSS (loaded
 * with the client chunk, so not available here); this ghost mirrors the
 * layout with plain utility geometry. Header, toolbar, and chip ghosts
 * are static structure (rule A1); hero, KPI, and chart ghosts cascade
 * subtly via `.cascade`. Reduced motion collapses the cascade globally
 * (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const HERO_GHOSTS = ["hero-1", "hero-2", "hero-3"] as const;
const KPI_GHOSTS = ["kpi-1", "kpi-2", "kpi-3", "kpi-4"] as const;
const ACTION_GHOSTS = ["action-1", "action-2", "action-3", "action-4"] as const;

export default function FinanceLoading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Chargement…</span>

      {/* Live-status chip ghost — pill shape, plain bg to keep rounded-full. */}
      <div className="h-7 w-56 max-w-full rounded-full bg-surface-container" />

      {/* Page header ghost — eyebrow / title / subtitle + action buttons. */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="ghost h-4 w-44 max-w-full" />
          <div className="ghost mt-2 h-9 w-80 max-w-full" />
          <div className="ghost mt-2 h-5 w-96 max-w-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          {ACTION_GHOSTS.map((key) => (
            <div key={key} className="ghost h-[var(--btn-height-md)] w-36" />
          ))}
        </div>
      </div>

      {/* Toolbar ghost — segmented period control + currency/tenant filters. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="ghost h-10 w-80 max-w-full" />
        <div className="flex gap-2">
          <div className="ghost h-10 w-36" />
          <div className="ghost h-10 w-36" />
        </div>
      </div>

      {/* Mobilisation hero ghost — score / formula / histogram blocks. */}
      <div className="cascade mt-6 grid gap-4 lg:grid-cols-3">
        {HERO_GHOSTS.map((key) => (
          <div
            key={key}
            className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5"
          >
            <div className="ghost h-4 w-36" />
            <div className="ghost mt-3 h-12 w-32 max-w-full" />
            <div className="ghost mt-3 h-4 w-40 max-w-full" />
            <div className="ghost mt-3 h-4 w-full" />
          </div>
        ))}
      </div>

      {/* KPI grid ghost — volume / revenue / recurring / Stripe cards. */}
      <div className="cascade mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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

      {/* Section head ghost — title + connecting rule + hint. */}
      <div className="mt-8 flex items-center gap-3">
        <div className="ghost h-6 w-44 shrink-0" />
        <div className="h-px flex-1 bg-outline-variant" />
        <div className="ghost h-4 w-40 shrink-0" />
      </div>

      {/* Chart card ghost — volume/revenue timeline region. */}
      <div className="cascade mt-4">
        <div className="rounded-2xl border border-border-brand bg-surface-container-lowest p-5">
          <div className="ghost h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
