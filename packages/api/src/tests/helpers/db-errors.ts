import { expect } from "vitest";

/**
 * drizzle-orm 0.45+ wraps native pg errors in `DrizzleQueryError`, exposing
 * the original pg error (which carries the constraint name in `.message`) on
 * `.cause`. Tests that assert on PostgreSQL constraint names must therefore
 * match against `error.cause.message`, not `error.message`. This helper
 * unwraps either layer and asserts the regex matches.
 */
export async function expectQueryToReject(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected promise to reject matching ${pattern}`).toBeDefined();

  const err = caught as { message?: string; cause?: { message?: string } } | undefined;
  const causeMessage = err?.cause?.message;
  const topMessage = err?.message;
  const probe = causeMessage ?? topMessage ?? String(caught);
  expect(probe).toMatch(pattern);
}
