#!/usr/bin/env node
/**
 * Screenshot the static mockup at docs/design/admin/dashboard.html for
 * side-by-side comparison with the rendered /admin/finance page.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const OUT = "/tmp/givernance-shots";
await mkdir(OUT, { recursive: true });

const mockupPath = "/Users/suikipik/dev/givernance/docs/design/admin/dashboard.html";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`file://${mockupPath}`);
await page.waitForTimeout(1500);

const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
await page.screenshot({ path: `${OUT}/mockup-${ts}-full.png`, fullPage: true });
await page.screenshot({ path: `${OUT}/mockup-${ts}-fold.png` });
console.log(`✓ ${OUT}/mockup-${ts}-fold.png`);
console.log(`✓ ${OUT}/mockup-${ts}-full.png`);

await browser.close();
