/**
 * Settings › Feature flags ghost loading state — rendered by Next.js
 * while the page's server data fetch runs on navigation (ADR-035 rule
 * A5: data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx + org-feature-flags-list.tsx — PageHeader
 * (no breadcrumbs on this page), the settings nav strip, then the
 * stacked flag-row cards (label + effective-state badge, description,
 * platform-default line, trailing action buttons) — so real content
 * replaces the ghosts with zero layout shift (rule A6). The header and
 * nav ghosts are static structure (rule A1); only the flag-card ghosts
 * cascade subtly via `.cascade`. Reduced motion collapses the cascade
 * globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const FLAG_GHOSTS = ["flag-1", "flag-2", "flag-3"] as const;

export default function OrgFeatureFlagsLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* PageHeader ghost — title + subtitle (no breadcrumbs, no action). */}
      <div className="min-w-0">
        <div className="ghost h-10 w-64 max-w-full sm:h-14 sm:w-80" />
        <div className="ghost mt-2 h-7 w-72 max-w-full" />
      </div>

      {/* Settings nav strip ghost — static structure (rule A1). Active
          pill on the lowest surface; inactive pills are transparent in
          the real strip, so plain sized spacers keep the geometry. */}
      <div className="overflow-x-auto">
        <div className="inline-flex min-w-full gap-2 rounded-2xl bg-surface-container p-2 border border-border-brand">
          <div className="min-h-11 flex-1 rounded-xl bg-surface-container-lowest sm:w-32 sm:flex-none" />
          <div className="min-h-11 flex-1 sm:w-28 sm:flex-none" />
          <div className="min-h-11 flex-1 sm:w-24 sm:flex-none" />
          <div className="min-h-11 flex-1 sm:w-40 sm:flex-none" />
          <div className="min-h-11 flex-1 sm:w-32 sm:flex-none" />
        </div>
      </div>

      {/* Flag-row card ghosts. */}
      <div className="cascade space-y-3">
        {FLAG_GHOSTS.map((key) => (
          <div
            key={key}
            className="rounded-2xl border border-outline-variant bg-surface p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="ghost h-5 w-40 max-w-full" />
                  <div className="ghost h-6 w-24" />
                </div>
                <div className="ghost h-5 w-full max-w-xl" />
                <div className="ghost h-4 w-48 max-w-full" />
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="ghost h-[var(--btn-height-sm)] w-24" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
