/**
 * Settings › Members ghost loading state — rendered by Next.js while the
 * page's server data fetches run on navigation (ADR-035 rule A5:
 * data-shaped ghosts, no shimmer, no spinner). Mirrors the final
 * geometry of ./page.tsx + ./members-table.tsx + ./invitations-table.tsx
 * — PageHeader, the settings nav strip, then the two stacked sections
 * (Members / Invitations), each a section header + DataTable frame with
 * toolbar, header row, and comfortable-density rows — so real content
 * replaces the ghosts with zero layout shift (rule A6). The header and
 * nav ghosts are static structure (rule A1); only the row ghosts cascade
 * subtly via `.cascade`. Reduced motion collapses the cascade globally
 * (rule E17).
 *
 * Deliberately a synchronous, data-free server component: no
 * translations, no fetches — the sr-only label is hardcoded in the
 * default locale (fr, ADR-015) because a route-level loading boundary
 * must never itself wait on anything.
 */

const MEMBER_ROW_GHOSTS = ["member-1", "member-2", "member-3", "member-4"] as const;
const INVITATION_ROW_GHOSTS = ["invite-1", "invite-2", "invite-3"] as const;

function SettingsNavGhost() {
  return (
    <div className="overflow-x-auto">
      <div className="inline-flex min-w-full gap-2 rounded-2xl bg-surface-container p-2 border border-border-brand">
        {/* Active pill — same lowest surface as the real nav's active item;
            the inactive pills are transparent in the real strip, so plain
            sized spacers keep the geometry without painting anything. */}
        <div className="min-h-11 flex-1 rounded-xl bg-surface-container-lowest sm:w-32 sm:flex-none" />
        <div className="min-h-11 flex-1 sm:w-28 sm:flex-none" />
        <div className="min-h-11 flex-1 sm:w-24 sm:flex-none" />
        <div className="min-h-11 flex-1 sm:w-40 sm:flex-none" />
        <div className="min-h-11 flex-1 sm:w-32 sm:flex-none" />
      </div>
    </div>
  );
}

function TableFrameGhost({ rows }: { rows: readonly string[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border-brand bg-surface-container-lowest">
      <div className="flex items-center justify-between gap-3 border-b border-border-brand px-5 py-4">
        <div className="ghost h-5 w-44 max-w-full" />
        <div className="ghost h-5 w-16 shrink-0" />
      </div>
      <div className="bg-surface-container-low px-5 py-3">
        <div className="ghost h-4 w-full max-w-3xl" />
      </div>
      <div className="cascade">
        {rows.map((key) => (
          <div key={key} className="flex items-center gap-6 border-t border-border-brand px-5 py-4">
            <div className="ghost h-5 w-40 max-w-[30%]" />
            <div className="ghost h-5 w-48 max-w-[25%]" />
            <div className="ghost h-6 w-24 shrink-0" />
            <div className="ghost ml-auto h-5 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MembersLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 sm:space-y-8">
      <span className="sr-only">Chargement…</span>

      {/* PageHeader ghost — breadcrumbs / title / subtitle + invite action. */}
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

      <SettingsNavGhost />

      {/* Members section ghost — header + table frame. */}
      <div className="space-y-3">
        <div>
          <div className="ghost h-6 w-32 max-w-full" />
          <div className="ghost mt-1 h-5 w-72 max-w-full" />
        </div>
        <TableFrameGhost rows={MEMBER_ROW_GHOSTS} />
      </div>

      {/* Invitations section ghost — header + table frame. */}
      <div className="space-y-3">
        <div>
          <div className="ghost h-6 w-36 max-w-full" />
          <div className="ghost mt-1 h-5 w-80 max-w-full" />
        </div>
        <TableFrameGhost rows={INVITATION_ROW_GHOSTS} />
      </div>
    </div>
  );
}
