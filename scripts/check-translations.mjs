#!/usr/bin/env node

/**
 * CI check: verify all locales have the same translation keys.
 * ADR-015 — wired into CI as `pnpm check:translations`.
 *
 * Validates two message trees:
 *   - packages/web/src/messages — UI strings (next-intl)
 *   - packages/api/messages     — RFC 9457 `detail` + email templates (i18next)
 *
 * Source locale is `fr`. Exits 1 if any locale in any tree has missing or
 * extra keys relative to the source.
 *
 * Usage: node scripts/check-translations.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE_LOCALE = "fr";
const REPO_ROOT = join(import.meta.dirname, "..");

const MESSAGE_TREES = [
  { name: "web", dir: join(REPO_ROOT, "packages/web/src/messages") },
  { name: "api", dir: join(REPO_ROOT, "packages/api/messages") },
];

/** Recursively extract all dot-separated keys from a nested object. */
function extractKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys.push(...extractKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function checkTree({ name, dir }) {
  console.log(`\n=== ${name} (${dir}) ===`);

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error(`  No locale files found in ${dir}`);
    return false;
  }

  const localeKeys = {};
  for (const file of files) {
    const locale = file.replace(".json", "");
    const content = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    localeKeys[locale] = new Set(extractKeys(content));
  }

  const sourceKeys = localeKeys[SOURCE_LOCALE];
  if (!sourceKeys) {
    console.error(`  Source locale "${SOURCE_LOCALE}" not found in ${dir}`);
    return false;
  }

  let treeOk = true;
  for (const [locale, keys] of Object.entries(localeKeys)) {
    if (locale === SOURCE_LOCALE) continue;

    const missing = [...sourceKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !sourceKeys.has(k));

    if (missing.length > 0) {
      treeOk = false;
      console.error(`  [${locale}] Missing ${missing.length} keys (present in ${SOURCE_LOCALE}):`);
      for (const key of missing) console.error(`    - ${key}`);
    }
    if (extra.length > 0) {
      treeOk = false;
      console.error(`  [${locale}] Extra ${extra.length} keys (not in ${SOURCE_LOCALE}):`);
      for (const key of extra) console.error(`    - ${key}`);
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(`  [${locale}] OK — ${keys.size} keys match source (${SOURCE_LOCALE}).`);
    }
  }

  if (treeOk) {
    console.log(`  ${name}: PASS (${files.length} locales, ${sourceKeys.size} keys each)`);
  } else {
    console.error(`  ${name}: FAIL`);
  }
  return treeOk;
}

let allOk = true;
for (const tree of MESSAGE_TREES) {
  if (!checkTree(tree)) allOk = false;
}

if (allOk) {
  console.log("\nAll message trees pass key parity.");
  process.exit(0);
} else {
  console.error("\nTranslation key check FAILED. Fix missing/extra keys above.");
  process.exit(1);
}
