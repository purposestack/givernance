/**
 * Profile ghost loading state — rendered by Next.js while the page's
 * server data fetch (`GET /v1/users/me`) runs on navigation (ADR-035
 * rule A5: data-shaped ghosts, no shimmer, no spinner). Mirrors the
 * final geometry of ./page.tsx + profile-language-form.tsx — PageHeader
 * (breadcrumbs / title / subtitle), then the single language-form card
 * (section title, description, label + select in the half-width column,
 * hint line, trailing submit button) — so real content replaces the
 * ghosts with zero layout shift (rule A6). The header ghost is static
 * structure (rule A1); the form card is the page's only content block
 * and enters as one unit via `.reveal-item` (rule E19: one wrapper per
 * form, no per-field choreography). Reduced motion collapses the
 * entrance globally (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

export default function ProfileLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* PageHeader ghost — breadcrumbs / title / subtitle. */}
      <div className="min-w-0">
        <div className="ghost mb-2 h-5 w-44 max-w-full" />
        <div className="ghost h-10 w-64 max-w-full sm:h-14 sm:w-80" />
        <div className="ghost mt-2 h-7 w-72 max-w-full" />
      </div>

      {/* Language-form card ghost — one reveal for the whole form. */}
      <div className="reveal-item rounded-2xl bg-surface-container-lowest p-5 border border-border-brand sm:p-6">
        <div className="max-w-3xl">
          <div className="ghost h-8 w-56 max-w-full" />
          <div className="ghost mt-2 h-5 w-full max-w-xl" />
        </div>
        <div className="mt-6 space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <div className="ghost h-5 w-24" />
              <div className="ghost h-[var(--input-height)] w-full" />
              <div className="ghost h-4 w-64 max-w-full" />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3">
            <div className="ghost h-[var(--btn-height-md)] w-32" />
          </div>
        </div>
      </div>
    </div>
  );
}
