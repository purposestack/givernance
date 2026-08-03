/**
 * Parity guard for the ADR-013 web import boundary (issue #576).
 *
 * `packages/shared` exports Node-only modules under the `./lib/*` subpaths
 * (node:crypto, node:stream, jsdom, @aws-sdk/client-s3). The root
 * `biome.json` web-scoped `noRestrictedImports` override is what keeps
 * those out of the Next.js browser bundle — but Biome only denies paths
 * that are LISTED. Before this guard, adding a new Node-only `lib/*`
 * export without a matching deny entry passed CI silently; the failure
 * would only surface later as a broken web build (best case) or a
 * server-only dependency shipped to donors' browsers (worst case).
 *
 * This test keeps the two files in lockstep, in the same spirit as the
 * migrations-journal and feature-flag parity tests: for every `./lib/*`
 * export whose source imports a Node-only dependency, the web override
 * MUST contain a deny entry for `@givernance/shared/lib/<name>`.
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
 * Import specifiers that mark a module as server-only. The repo
 * consistently uses the `node:` prefix for builtins; `jsdom` and the AWS
 * SDK are the two Node-only third-party deps `shared` carries today.
 * Extend this list when `shared` gains a new server-only dependency.
 */
function isNodeOnlySpecifier(spec: string): boolean {
  return spec.startsWith("node:") || spec === "jsdom" || spec.startsWith("@aws-sdk/");
}

/**
 * Extracts every static import/re-export specifier from a source file.
 * Matches `from "x"` (incl. multiline import clauses and `export … from`)
 * and bare side-effect `import "x"`. Prose in comments doesn't match
 * unless it quotes a specifier after `from` — which errs toward
 * demanding a deny entry, the safe direction for this guard.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:\bfrom\s*|^\s*import\s*)["']([^"']+)["']/gm;
  for (const match of source.matchAll(re)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
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

/** The deny-listed import paths of the packages/web-scoped Biome override. */
function webRestrictedPaths(): Record<string, string> {
  const biome = JSON.parse(readFileSync(BIOME_CONFIG, "utf8")) as { overrides?: BiomeOverride[] };
  const webOverride = biome.overrides?.find((o) =>
    o.includes?.some((glob) => glob.startsWith("packages/web/")),
  );
  const paths = webOverride?.linter?.rules?.style?.noRestrictedImports?.options?.paths;
  expect(
    paths,
    "biome.json must keep a packages/web noRestrictedImports override (ADR-013)",
  ).toBeDefined();
  return paths ?? {};
}

/** `./lib/*` exports of @givernance/shared, as [subpath, sourcePath] pairs. */
function libExports(): Array<[subpath: string, sourcePath: string]> {
  const pkg = JSON.parse(readFileSync(SHARED_PKG, "utf8")) as { exports: Record<string, string> };
  return Object.entries(pkg.exports)
    .filter(([subpath]) => subpath.startsWith("./lib/"))
    .map(([subpath, target]) => [subpath, resolve(dirname(SHARED_PKG), target)]);
}

describe("ADR-013 web import guard parity (biome.json ↔ shared lib exports)", () => {
  it("denies every Node-only ./lib/* export in the web-scoped Biome override", () => {
    const restricted = webRestrictedPaths();
    const missing: string[] = [];

    for (const [subpath, sourcePath] of libExports()) {
      const nodeOnly = importSpecifiers(readFileSync(sourcePath, "utf8")).filter(
        isNodeOnlySpecifier,
      );
      if (nodeOnly.length === 0) continue;

      const importPath = `@givernance/shared${subpath.slice(1)}`;
      if (!restricted[importPath]) {
        missing.push(
          `${importPath} imports ${[...new Set(nodeOnly)].join(", ")} but has no deny entry`,
        );
      }
    }

    expect(
      missing,
      "Node-only shared/lib subpaths must be denied for packages/web in biome.json (ADR-013). " +
        "Add the missing entries to the web-scoped noRestrictedImports paths.",
    ).toEqual([]);
  });

  it("does not flag the deliberately isomorphic lru-fetch-cache", () => {
    // Its doc comment name-drops @aws-sdk/client-s3 in backticks; a naive
    // substring detector would false-positive. Guard the detector itself.
    const source = readFileSync(
      resolve(REPO_ROOT, "packages/shared/src/lib/lru-fetch-cache.ts"),
      "utf8",
    );
    expect(importSpecifiers(source).filter(isNodeOnlySpecifier)).toEqual([]);
  });

  it("keeps the known Node-only trio denied (regression pin)", () => {
    const restricted = webRestrictedPaths();
    for (const name of ["receipt-crypto", "s3-branding", "svg-sanitiser"]) {
      expect(restricted[`@givernance/shared/lib/${name}`], `lib/${name} deny entry`).toMatch(
        /ADR-013/,
      );
    }
  });
});
