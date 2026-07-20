/**
 * Back Office › Tenants list ghost loading state — rendered by Next.js
 * while the page's server data fetch runs on navigation (ADR-035 rule
 * A5: data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx + tenants-table.tsx — the compact admin header
 * (h1 `text-2xl` + subtitle, create CTA on the right), then the
 * DataTable frame with its toolbar, header row, and six
 * comfortable-density rows (name, status badge, plan, domain, date,
 * trailing action) — so real content replaces the ghosts with zero
 * layout shift (rule A6). The header ghost is static structure (rule
 * A1); only the row ghosts cascade subtly via `.cascade`. Reduced
 * motion collapses the cascade globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const ROW_GHOSTS = ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"] as const;

export default function TenantListLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* Admin header ghost — h1 + subtitle, create CTA on the right. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="ghost h-8 w-56 max-w-full" />
          <div className="ghost mt-1 h-5 w-72 max-w-full" />
        </div>
        <div className="ghost h-[var(--btn-height-md)] w-44" />
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
              <div className="ghost h-5 w-40 max-w-[25%]" />
              <div className="ghost h-6 w-20 shrink-0" />
              <div className="ghost h-5 w-16 shrink-0" />
              <div className="ghost h-5 w-40 max-w-[20%]" />
              <div className="ghost ml-auto h-5 w-24 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
