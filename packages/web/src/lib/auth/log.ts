/**
 * Structured-log helper for the web-side auth routes (/api/auth/login,
 * /api/auth/callback, /api/auth/logout). Wraps `console.warn` / `console.error`
 * so the entries land on stdout as JSON the way Pino does on the API
 * side — Cockpit / Loki parse the JSON automatically and SOC
 * dashboards can filter on `event` and `level` without regex-grepping
 * arbitrary strings.
 *
 * Why not Pino directly: Next.js middleware/routes run in a constrained
 * runtime where bundling Pino is heavier than the value it adds for the
 * handful of lines these routes emit. A plain JSON object on stdout is
 * the same format Cockpit ingests.
 *
 * Multi-agent review Logs-3 (PR #251): the previous `console.error(...)`
 * calls in these routes lost structured context (no event id, no
 * fields), and rejected `return_to` cookies were silently dropped — an
 * attacker probing the open-redirect filter was invisible.
 */

type Level = "warn" | "error";

export function logAuthEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = {
    level,
    event,
    ts: new Date().toISOString(),
    component: "web-auth",
    ...fields,
  };
  const serialised = JSON.stringify(line);
  if (level === "error") {
    console.error(serialised);
  } else {
    console.warn(serialised);
  }
}
