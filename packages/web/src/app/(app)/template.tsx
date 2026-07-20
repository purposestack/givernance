/**
 * (app) route template — the once-per-navigation replay boundary for the
 * ADR-035 choreography (rule B12). A template remounts only when its
 * immediate child segment changes: /donations → /constituents remounts,
 * but /donations → /donations/new does NOT — that navigation swaps the
 * page subtree deeper down, and the page's fresh server-rendered DOM is
 * what animates. Background refetches and client re-renders never
 * remount a template either, so entrances cannot replay outside a real
 * navigation.
 *
 * The wrapper itself deliberately does NOT animate (no `.reveal-item`):
 * pages own their choreography per rule A1 — page title, PageHeader
 * CTAs, and filter/action bars are static structure; only content
 * (cards, KPI tiles, tables, rows) cascades, starting at slot 0/1.
 * Animating this wrapper on top of that would double-fade every page.
 *
 * `space-y-6 sm:space-y-8` mirrors AppShell's content wrapper: pages that
 * return fragments relied on being direct children of that wrapper for
 * their vertical rhythm — this div now sits between them, so it carries
 * the same spacing scale (zero layout shift, rule A6).
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6 sm:space-y-8">{children}</div>;
}
