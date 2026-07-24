/**
 * Sticky form footer — issue #229 (demo 30/04): on long create/edit forms
 * the Save/Cancel actions must stay visible while the operator scrolls.
 *
 * The (app) `<main>` doesn't own an overflow context (the window scrolls),
 * so `sticky bottom-0` pins the footer to the viewport bottom until the
 * form's natural end scrolls into view. The translucent card background +
 * blur keeps the content sliding underneath legible (same recipe as the
 * Topbar's `sticky top-0`); the tint matches the card-form wrapper
 * (`bg-surface-container-lowest`) every consumer renders inside.
 *
 * ADR-035: static shell — the footer itself never animates; only the
 * buttons inside keep their standard color transitions.
 */
export function FormStickyFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  /** Inner layout override — defaults to a right-aligned action row. */
  className?: string;
}) {
  return (
    <div className="sticky bottom-0 z-[var(--z-sticky)] border-t border-outline-variant bg-surface-container-lowest/95 py-4 backdrop-blur-sm">
      <div className={className ?? "flex items-center justify-end gap-3"}>{children}</div>
    </div>
  );
}
