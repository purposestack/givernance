/**
 * Predicate helpers for inspecting database errors raised by drizzle-orm /
 * node-postgres. drizzle-orm 0.45+ wraps every native pg error in
 * `DrizzleQueryError`, exposing the original pg error (with `.code`,
 * `.constraint`, `.message`) on `.cause`. Reading those fields off the
 * top-level error therefore returns `undefined`. Helpers in this module
 * unwrap one layer so the same check works for both shapes.
 */

type PgErrorLike = { code?: string; constraint?: string; message?: string };

function unwrap(err: unknown): PgErrorLike {
  if (typeof err !== "object" || err === null) return {};
  const root = err as { cause?: unknown } & PgErrorLike;
  if (typeof root.cause === "object" && root.cause !== null) {
    return root.cause as PgErrorLike;
  }
  return root;
}

/** True iff `err` is a Postgres unique-violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown, constraintHint?: RegExp): boolean {
  const probe = unwrap(err);
  if (probe.code !== "23505") return false;
  if (!constraintHint) return true;
  return constraintHint.test(probe.constraint ?? "") || constraintHint.test(probe.message ?? "");
}
