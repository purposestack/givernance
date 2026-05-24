#!/usr/bin/env node
/**
 * Screenshot loop for the super-admin /admin/finance page.
 *
 * Logs in as the local super-admin via Keycloak (creds from realm seed),
 * navigates to /admin/finance, waits for the page to render, and saves
 * a full-page screenshot under /tmp/finance-<timestamp>.png so the
 * orchestrating Claude Code agent can Read it back and compare against
 * the Claude Design mockup.
 *
 * Usage:  pnpm --filter @givernance/web exec node scripts/screenshot-finance.mjs
 *
 * Requires:
 *   - dev server running on http://localhost:3000 (pnpm dev)
 *   - API running on http://localhost:4000
 *   - Keycloak running with the seed realm + admin@givernance.org user
 */

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SCREENSHOT_ADMIN_EMAIL ?? "admin@givernance.org";
const ADMIN_PASSWORD = process.env.SCREENSHOT_ADMIN_PASSWORD ?? "admin-localdev-12";
const TARGET_PATH = process.env.SCREENSHOT_TARGET_PATH ?? "/admin/finance";
const OUTPUT_DIR = process.env.SCREENSHOT_OUTPUT_DIR ?? "/tmp/givernance-shots";
const VIEWPORT_WIDTH = Number.parseInt(process.env.SCREENSHOT_WIDTH ?? "1440", 10);
const VIEWPORT_HEIGHT = Number.parseInt(process.env.SCREENSHOT_HEIGHT ?? "900", 10);

await mkdir(OUTPUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  ignoreHTTPSErrors: true,
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

// Surface console errors so a 500 doesn't hide behind a blank screenshot
page.on("console", (msg) => {
  if (msg.type() === "error") {
    console.error("[browser console error]", msg.text());
  }
});
page.on("pageerror", (err) => {
  console.error("[browser pageerror]", err.message);
});
page.on("requestfailed", (req) => {
  console.error("[request failed]", req.url(), req.failure()?.errorText);
});

try {
  console.log(`Navigating to ${BASE_URL}${TARGET_PATH} …`);
  await page.goto(`${BASE_URL}${TARGET_PATH}`, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Two-step auth: app's /login page → click "Se connecter" → Keycloak.
  if (page.url().includes("/login")) {
    console.log("App /login page reached, clicking 'Se connecter' to delegate to Keycloak …");
    await Promise.all([
      page.waitForURL((url) => /realms|keycloak|auth/.test(url.toString()), { timeout: 30000 }),
      page.click('button:has-text("Se connecter"), a:has-text("Se connecter")'),
    ]);
  }

  // Keycloak login form
  if (/realms|keycloak|auth/.test(page.url())) {
    console.log("Keycloak login page detected, signing in …");
    await page.fill('input[name="username"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !/realms|keycloak/.test(url.toString()), { timeout: 30000 }),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);
  }

  // After auth we may bounce through callback → home → target.
  if (!page.url().endsWith(TARGET_PATH)) {
    console.log(`Currently at ${page.url()}, navigating to ${TARGET_PATH} explicitly …`);
    await page.goto(`${BASE_URL}${TARGET_PATH}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  // Wait for the page to be "settled" — both the SSR + the client-side
  // refetch. Look for the H1 the page renders.
  await page.waitForSelector("h1", { timeout: 15000 });
  // Give animations + recharts a beat to settle.
  await page.waitForTimeout(1500);

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const fullPath = `${OUTPUT_DIR}/finance-${ts}-full.png`;
  const aboveFoldPath = `${OUTPUT_DIR}/finance-${ts}-fold.png`;
  await page.screenshot({ path: fullPath, fullPage: true });
  await page.screenshot({ path: aboveFoldPath, fullPage: false });
  console.log(`✓ Full-page: ${fullPath}`);
  console.log(`✓ Above-fold: ${aboveFoldPath}`);
} catch (err) {
  console.error("Screenshot failed:", err);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const errPath = `${OUTPUT_DIR}/finance-ERROR-${ts}.png`;
  try {
    await page.screenshot({ path: errPath, fullPage: true });
    console.error(`Error-state screenshot saved to ${errPath}`);
  } catch {
    // ignore
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
