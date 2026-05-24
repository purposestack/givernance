#!/usr/bin/env node
/**
 * Side-by-side typography audit. Opens both the static mockup and the
 * live /admin/finance page, queries computed font-size + font-weight +
 * line-height + color on key elements, prints a comparison table so
 * we can align the React port to the mockup exactly.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

// Selectors to audit: [name, selector]
const AUDIT = [
  ["page-eyebrow", ".page-eyebrow"],
  ["page-title (H1)", "h1.page-title"],
  ["page-subtitle", ".page-subtitle"],
  ["section-head h2", ".section-head h2"],
  ["hero-label", ".hero-label"],
  ["hero-grade", ".hero-grade"],
  ["hero-score-num", ".hero-score-num"],
  ["formula-row .lab", ".formula-row .lab"],
  ["formula-row .pct b", ".formula-row .pct b"],
  ["kpi-label", ".kpi-label"],
  ["kpi-value", ".kpi-value"],
  ["delta-pill", ".delta-pill"],
  ["fin-btn--primary", ".fin-btn--primary"],
  ["topbar-live", ".topbar-live"],
];

async function audit(label, url, isMockup) {
  const page = await ctx.newPage();
  if (isMockup) {
    await page.goto(url);
  } else {
    await page.goto(url);
    if (page.url().includes("/login")) {
      await Promise.all([
        page.waitForURL((u) => /realms|keycloak|auth/.test(u.toString())),
        page.click('button:has-text("Se connecter"), a:has-text("Se connecter")'),
      ]);
    }
    if (/realms|keycloak|auth/.test(page.url())) {
      await page.fill('input[name="username"]', "admin@givernance.org");
      await page.fill('input[name="password"]', "admin-localdev-12");
      await Promise.all([
        page.waitForURL((u) => !/realms|keycloak/.test(u.toString())),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);
    }
    if (!page.url().endsWith("/admin/finance")) await page.goto(url);
  }
  await page.waitForSelector("h1");
  await page.waitForTimeout(1000);

  const measurements = {};
  for (const [name, sel] of AUDIT) {
    const computed = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        color: cs.color,
        fontFamily: cs.fontFamily.split(",")[0].replace(/"/g, "").trim(),
        letterSpacing: cs.letterSpacing,
      };
    }, sel);
    measurements[name] = computed;
  }
  await page.close();
  return measurements;
}

const mockup = await audit(
  "mockup",
  "file:///Users/suikipik/dev/givernance/docs/design/admin/dashboard.html",
  true,
);
const live = await audit("live", "http://localhost:3000/admin/finance", false);

console.log(
  ["element", "mockup font-size", "live font-size", "mockup weight", "live weight", "diff"]
    .map((s) => s.padEnd(20))
    .join(""),
);
console.log("-".repeat(120));
for (const [name] of AUDIT) {
  const m = mockup[name];
  const l = live[name];
  if (!m || !l) {
    console.log(`${name.padEnd(20)}MISSING — mockup=${!!m} live=${!!l}`);
    continue;
  }
  const diff = m.fontSize !== l.fontSize ? "≠" : "=";
  console.log(
    [name, m.fontSize, l.fontSize, m.fontWeight, l.fontWeight, diff]
      .map((s) => String(s).padEnd(20))
      .join(""),
  );
}

await browser.close();
