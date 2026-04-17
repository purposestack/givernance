#!/usr/bin/env node

/**
 * CI check: verify all locales have the same translation keys.
 * ADR-015 — run as part of `pnpm test` or CI pipeline.
 *
 * Usage: node scripts/check-translations.mjs
 * Exit code 0 = all keys match, 1 = missing keys found.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MESSAGES_DIR = join(import.meta.dirname, "../packages/web/messages");
const SOURCE_LOCALE = "fr"; // French is the source language

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

const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"));
const localeKeys = {};

for (const file of files) {
  const locale = file.replace(".json", "");
  const content = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf-8"));
  localeKeys[locale] = new Set(extractKeys(content));
}

const sourceKeys = localeKeys[SOURCE_LOCALE];
if (!sourceKeys) {
  console.error(`Source locale "${SOURCE_LOCALE}" not found in ${MESSAGES_DIR}`);
  process.exit(1);
}

let hasErrors = false;

for (const [locale, keys] of Object.entries(localeKeys)) {
  if (locale === SOURCE_LOCALE) continue;

  // Keys in source but missing in this locale
  const missing = [...sourceKeys].filter((k) => !keys.has(k));
  // Keys in this locale but not in source (extra)
  const extra = [...keys].filter((k) => !sourceKeys.has(k));

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`\n[${locale}] Missing ${missing.length} keys (present in ${SOURCE_LOCALE}):`);
    for (const key of missing) {
      console.error(`  - ${key}`);
    }
  }

  if (extra.length > 0) {
    hasErrors = true;
    console.error(`\n[${locale}] Extra ${extra.length} keys (not in ${SOURCE_LOCALE}):`);
    for (const key of extra) {
      console.error(`  - ${key}`);
    }
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log(`[${locale}] All ${keys.size} keys match source (${SOURCE_LOCALE}).`);
  }
}

if (hasErrors) {
  console.error("\nTranslation key check FAILED. Fix missing/extra keys above.");
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} locales have matching keys (${sourceKeys.size} keys each).`);
}
