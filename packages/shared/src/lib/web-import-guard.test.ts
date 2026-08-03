/**
 * Parity guard for the ADR-013 web import boundary (issue #576).
 *
 * `packages/shared` exports server-only modules — `lib/*` helpers built on
 * node:crypto / node:stream / jsdom / @aws-sdk, and domain modules like
 * `signup` and `finance/reporting` that runtime-import the Drizzle schema.
 * The root `biome.json` web-scoped `noRestrictedImports` override is what
 * keeps those out of the Next.js browser bundle — but Biome only denies
 * paths that are LISTED. Before this guard, adding a new server-only
 * export without a matching deny entry passed CI silently; the failure
 * would only surface later as a broken web build (best case) or a
 * server-only dependency shipped to donors' browsers (worst case).
 *
 * This test keeps the two files in lockstep, in the same spirit as the
 * migrations-journal and feature-flag parity tests: every subpath export
 * of `@givernance/shared` (except the four the override already denies
 * wholesale: root barrel, schema, events, jobs) is scanned — including
 * its transitive RELATIVE imports and dynamic `import(...)` calls — and
 * any export whose closure reaches a server-only specifier MUST have a
 * deny entry for `@givernance/shared/<subpath>`.
 *
 * Type-only imports (`import type` / `export type … from`) are ignored:
 * they are erased at compile time and never enter a bundle. Mixed inline
 * `import { type A, b }` statements count as runtime — the conservative
 * direction for this guard.
 *
 * The reverse direction is deliberately NOT asserted: a deny entry with
 * no matching export (e.g. one forward-declared for a module landing in
 * an in-flight PR) is harmless and stays legal.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const SHARED_PKG = resolve(REPO_ROOT, "packages/shared/package.json");
const BIOME_CONFIG = resolve(REPO_ROOT, "biome.json");

/**
 * Subpath exports the web override already denies wholesale (the original
 * ADR-013 deny-list). Their contents are server-only BY DESIGN, so the
 * scan skips them rather than demanding a redundant second entry.
 */
const ALREADY_DENIED = new Set([".", "./schema", "./events", "./jobs"]);

/**
 * Import specifiers that mark a module closure as server-only. The repo
 * consistently uses the `node:` prefix for builtins; `jsdom` and the AWS
 * SDK are the Node-only third-party deps `shared` carries today; a
 * RUNTIME import of the Drizzle schema (or of drizzle-orm itself) drags
 * DB topology + ORM code into the bundle — the exact leak ADR-013's
 * `schema` deny exists to prevent. Extend this list when `shared` gains
 * a new server-only dependency.
 */
function isServerOnlySpecifier(spec: string): boolean {
  return (
    spec.startsWith("node:") ||
    spec === "jsdom" ||
    spec.startsWith("@aws-sdk/") ||
    spec === "@givernance/shared/schema" ||
    spec === "drizzle-orm" ||
    spec.startsWith("drizzle-orm/")
  );
}

/**
 * Extracts every RUNTIME import specifier from a source file:
 * static `import … from` / `export … from` (incl. multiline clauses),
 * bare side-effect `import "x"`, and dynamic `import("x")`. Statement-
 * level type-only forms (`import type`, `export type … from`) are
 * excluded — they are erased at compile time. Prose in comments doesn't
 * match unless it quotes a specifier after `from` — which errs toward
 * demanding a deny entry, the safe direction for this guard.
 */
function runtimeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const staticRe = /(?:^|;)\s*(import|export)\s+(type\s+)?[^;'"]*?from\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(staticRe)) {
    if (match[2]) continue; // statement-level type-only — erased at build
    const spec = match[3];
    if (spec) specs.push(spec);
  }
  const bareRe = /(?:^|;)\s*import\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(bareRe)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamicRe)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Resolves a relative specifier from `fromFile` to a source file on disk. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }
  }
  throw new Error(`web-import-guard: cannot resolve "${spec}" imported from ${fromFile}`);
}

/**
 * Walks a module and its transitive RELATIVE imports (runtime only,
 * cycle-guarded) and returns every external specifier the closure
 * reaches. Recursion matters: `signup` and `finance/reporting` reach the
 * Drizzle schema only through relative hops from their index files.
 * Package-specifier imports are recorded but not recursed into — each
 * `@givernance/shared/*` export is scanned as its own root.
 */
function closureSpecifiers(sourcePath: string, seen = new Set<string>()): string[] {
  if (seen.has(sourcePath)) return [];
  seen.add(sourcePath);
  const external: string[] = [];
  for (const spec of runtimeSpecifiers(readFileSync(sourcePath, "utf8"))) {
    if (spec.startsWith(".")) {
      external.push(...closureSpecifiers(resolveRelative(sourcePath, spec), seen));
    } else {
      external.push(spec);
    }
  }
  return external;
}

interface BiomeOverride {
  includes?: string[];
  linter?: {
    rules?: {
      style?: {
        noRestrictedImports?: { options?: { paths?: Record<string, string> } };
      };
    };
  };
}

function webOverride(): BiomeOverride {
  const biome = JSON.parse(readFileSync(BIOME_CONFIG, "utf8")) as { overrides?: BiomeOverride[] };
  const override = biome.overrides?.find((o) =>
    o.includes?.some((glob) => glob.startsWith("packages/web/")),
  );
  expect(override, "biome.json must keep a packages/web-scoped override (ADR-013)").toBeDefined();
  return override ?? {};
}

/** The deny-listed import paths of the packages/web-scoped Biome override. */
function webRestrictedPaths(): Record<string, string> {
  const paths = webOverride().linter?.rules?.style?.noRestrictedImports?.options?.paths;
  expect(
    paths,
    "biome.json must keep a packages/web noRestrictedImports override (ADR-013)",
  ).toBeDefined();
  return paths ?? {};
}

/** Scannable subpath exports of @givernance/shared, as [subpath, sourcePath]. */
function scannableExports(): Array<[subpath: string, sourcePath: string]> {
  const pkg = JSON.parse(readFileSync(SHARED_PKG, "utf8")) as {
    exports: Record<string, unknown>;
  };
  return Object.entries(pkg.exports)
    .filter(([subpath]) => !ALREADY_DENIED.has(subpath))
    .map(([subpath, target]) => {
      if (typeof target !== "string") {
        throw new Error(
          `web-import-guard: export "${subpath}" uses a non-string target (conditional exports?). ` +
            "Teach scannableExports() how to pick the source entry for it.",
        );
      }
      return [subpath, resolve(dirname(SHARED_PKG), target)];
    });
}

/** Subpaths whose closure is server-only TODAY — the positive control set. */
const KNOWN_SERVER_ONLY = [
  "./lib/receipt-crypto",
  "./lib/s3-branding",
  "./lib/svg-sanitiser",
  "./signup",
  "./finance/reporting",
];

describe("ADR-013 web import guard parity (biome.json ↔ shared exports)", () => {
  it("denies every server-only shared export in the web-scoped Biome override", () => {
    const restricted = webRestrictedPaths();
    const missing: string[] = [];
    const flagged: string[] = [];

    for (const [subpath, sourcePath] of scannableExports()) {
      const serverOnly = closureSpecifiers(sourcePath).filter(isServerOnlySpecifier);
      if (serverOnly.length === 0) continue;
      flagged.push(subpath);

      const importPath = `@givernance/shared${subpath.slice(1)}`;
      if (!restricted[importPath]) {
        missing.push(
          `${importPath} reaches ${[...new Set(serverOnly)].join(", ")} but has no deny entry`,
        );
      }
    }

    expect(
      missing,
      "Server-only shared subpaths must be denied for packages/web in biome.json (ADR-013). " +
        "Add the missing entries to the web-scoped noRestrictedImports paths.",
    ).toEqual([]);

    // Positive control: a silent regression of the detector (regex edit,
    // import-style drift) would otherwise make this test pass vacuously.
    expect(flagged, "detector no longer classifies the known server-only exports").toEqual(
      expect.arrayContaining(KNOWN_SERVER_ONLY),
    );
  });

  it("does not flag the deliberately isomorphic web-consumed exports", () => {
    // lru-fetch-cache's doc comment name-drops @aws-sdk/client-s3 in
    // backticks — a naive substring detector would false-positive. And the
    // subpaths packages/web imports today must stay clean, or the deny
    // entry this test would demand for them will break the web build.
    for (const name of ["./lib/lru-fetch-cache", "./constants", "./custom-fields", "./i18n"]) {
      const entry = scannableExports().find(([subpath]) => subpath === name);
      expect(entry, `${name} export`).toBeDefined();
      if (!entry) continue;
      expect(
        closureSpecifiers(entry[1]).filter(isServerOnlySpecifier),
        `${name} must stay isomorphic`,
      ).toEqual([]);
    }
  });

  it("keeps the known server-only exports denied (regression pin)", () => {
    const restricted = webRestrictedPaths();
    for (const subpath of KNOWN_SERVER_ONLY) {
      const importPath = `@givernance/shared${subpath.slice(1)}`;
      expect(restricted[importPath], `${importPath} deny entry`).toMatch(/ADR-013/);
    }
  });

  it("pins the override scope so the deny entries actually fire on web sources", () => {
    // The deny entries are inert if the override's includes stop matching
    // web source files — the entries would still EXIST (tests above green)
    // while Biome never evaluates them.
    expect(webOverride().includes).toEqual(
      expect.arrayContaining(["packages/web/src/**/*.ts", "packages/web/src/**/*.tsx"]),
    );
  });
});
