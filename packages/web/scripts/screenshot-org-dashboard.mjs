#!/usr/bin/env node
/**
 * Screenshot the org-admin dashboard at /dashboard (tenant-scoped),
 * authenticated as the seeded org_admin user. Used to validate that
 * the Epic #447 demo data also makes the tenant dashboard look healthy.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE_URL = "http://localhost:3000";
const ADMIN_EMAIL = process.env.ORG_ADMIN_EMAIL ?? "alice@npo.local";
const ADMIN_PASSWORD = process.env.ORG_ADMIN_PASSWORD ?? "alice-localdev-12";
const TARGET_PATH = "/dashboard";
const OUT = "/tmp/givernance-shots";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on("pageerror", (err) => console.error("[pageerror]", err.message));
page.on("requestfailed", (req) => console.error("[requestfailed]", req.url(), req.failure()?.errorText));

await page.goto(`${BASE_URL}${TARGET_PATH}`);
if (page.url().includes("/login")) {
  await Promise.all([
    page.waitForURL((u) => /realms|keycloak|auth/.test(u.toString())),
    page.click('button:has-text("Se connecter"), a:has-text("Se connecter")'),
  ]);
}
if (/realms|keycloak|auth/.test(page.url())) {
  await page.fill('input[name="username"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !/realms|keycloak/.test(u.toString())),
    page.click('input[type="submit"], button[type="submit"]'),
  ]);
}
if (!page.url().endsWith(TARGET_PATH)) await page.goto(`${BASE_URL}${TARGET_PATH}`);
await page.waitForSelector("h1");
await page.waitForTimeout(1500);

const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
await page.screenshot({ path: `${OUT}/org-dashboard-${ts}-full.png`, fullPage: true });
await page.screenshot({ path: `${OUT}/org-dashboard-${ts}-fold.png` });
console.log(`✓ ${OUT}/org-dashboard-${ts}-fold.png`);
console.log(`✓ ${OUT}/org-dashboard-${ts}-full.png`);

await browser.close();
