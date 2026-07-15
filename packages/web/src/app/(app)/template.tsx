/**
 * (app) route template — Next.js remounts a template on every navigation,
 * so the routed content area replays its entrance exactly once per route
 * change (ADR-035 rule A2): opacity 0→1 + translateY(4px)→0 over
 * --duration-slow --ease-out via the shared `.reveal-item` utility.
 * The delay stays at 0 (default `--cascade-i: 0`) so this frame leads any
 * nested `.cascade` / `.reveal-item` content a page adds internally
 * (frame first, then content — rule A3).
 *
 * The shell (sidebar, topbar — composed by `layout.tsx` via `AppShell`)
 * lives in the layout, which does NOT remount on navigation, so structure
 * never animates (rule A1). Background refetches and client re-renders
 * never remount a template either, so the entrance cannot replay outside
 * a real navigation (rule B12). Reduced motion collapses `.reveal-item`
 * to instant final state in globals.css (rule E17).
 *
 * `space-y-6 sm:space-y-8` mirrors AppShell's content wrapper: pages that
 * return fragments relied on being direct children of that wrapper for
 * their vertical rhythm — this div now sits between them, so it carries
 * the same spacing scale (zero layout shift, rule A6).
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="reveal-item space-y-6 sm:space-y-8">{children}</div>;
}
