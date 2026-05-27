// #442 — CSV serialiser for the super-admin platform finance summary.
//
// Emits four sections (KPIs / Per-tenant / Per-currency / Timeseries) as
// per the issue spec, separated by blank lines. RFC-4180 quoting; UTF-8
// BOM so Excel for Windows auto-detects the encoding.
//
// All monetary values are converted from integer cents to the major
// unit (2 decimal places). The `_eur` suffix is the issue-spec column
// name; for the per-currency section the value is in the row's own
// currency major unit.

import type { SummaryServiceResult } from "./service.js";

const BOM = "\uFEFF";

// Excel / LibreOffice / Google Sheets evaluate a cell as a formula when
// the first character is one of `= + - @` (or TAB/CR which some apps
// strip and then re-interpret). A tenant whose name is set to
// `=HYPERLINK("http://attacker/", "click me")` would execute the moment
// a super-admin opens the export — the OWASP "CSV injection" class.
// Prefix a single quote (OWASP-recommended neutraliser) and quote the
// cell so the leading `'` is preserved verbatim.
const FORMULA_LEADERS = /^[=+\-@\t\r]/;

function escapeCell(value: string): string {
  const needsFormulaGuard = FORMULA_LEADERS.test(value);
  const safe = needsFormulaGuard ? `'${value}` : value;
  if (needsFormulaGuard || /[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function toCsvLine(cells: Array<string | number | null>): string {
  return cells
    .map((c) => {
      if (c === null || c === undefined) return "";
      return escapeCell(String(c));
    })
    .join(",");
}

/** cents → major unit string with exactly 2 decimal places. */
function centsToMajor(cents: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

function pct(value: number | null, digits = 2): string {
  if (value === null || value === undefined) return "";
  return value.toFixed(digits);
}

export function buildFinanceSummaryCsv(result: SummaryServiceResult): string {
  const lines: string[] = [];

  // ─── KPIs ────────────────────────────────────────────────────────────
  lines.push("# KPIs");
  lines.push(toCsvLine(["metric", "value", "unit", "delta_percent"]));
  const { kpis } = result;
  lines.push(
    toCsvLine(["volume", centsToMajor(kpis.volumeCents), "EUR", pct(kpis.deltas.volumePercent)]),
  );
  lines.push(
    toCsvLine([
      "platform_fee",
      centsToMajor(kpis.platformFeeCents),
      "EUR",
      pct(kpis.deltas.platformFeePercent),
    ]),
  );
  lines.push(
    toCsvLine([
      "stripe_fee",
      centsToMajor(kpis.stripeFeeCents),
      "EUR",
      pct(kpis.deltas.stripeFeePercent),
    ]),
  );
  lines.push(
    toCsvLine([
      "donor_count",
      kpis.donorCount.toString(),
      "donors",
      pct(kpis.deltas.donorCountPercent),
    ]),
  );
  lines.push(
    toCsvLine([
      "refunded_volume",
      centsToMajor(kpis.refundedVolumeCents),
      "EUR",
      pct(kpis.deltas.refundedVolumePercent),
    ]),
  );
  lines.push(
    toCsvLine([
      "recurring_mrr",
      centsToMajor(kpis.recurringMrrCents),
      "EUR",
      pct(kpis.deltas.recurringMrrPercent),
    ]),
  );
  lines.push(toCsvLine(["active_tenants", kpis.activeTenantsCount.toString(), "tenants", ""]));
  lines.push(toCsvLine(["payment_failure_rate", pct(kpis.paymentFailureRate), "percent", ""]));
  lines.push(toCsvLine(["hhi", pct(kpis.hhi, 4), "index", ""]));

  // ─── Per-tenant ──────────────────────────────────────────────────────
  lines.push("");
  lines.push("# Per-tenant");
  lines.push(
    toCsvLine([
      "tenant_id",
      "tenant_name",
      "grade",
      "score",
      "volume_eur",
      "donation_count",
      "share_pct",
    ]),
  );
  const totalVolume = result.perTenant.reduce((acc, t) => acc + t.volumeCents, 0);
  const mobilisationByTenant = new Map(result.mobilisation.perTenant.map((m) => [m.tenantId, m]));
  for (const row of result.perTenant) {
    const m = mobilisationByTenant.get(row.tenantId) ?? null;
    const share = totalVolume > 0 ? (row.volumeCents / totalVolume) * 100 : 0;
    lines.push(
      toCsvLine([
        row.tenantId,
        row.tenantName,
        m?.grade ?? "",
        m?.score !== null && m?.score !== undefined ? pct(m.score, 1) : "",
        centsToMajor(row.volumeCents),
        row.donationCount.toString(),
        pct(share),
      ]),
    );
  }

  // ─── Per-currency ────────────────────────────────────────────────────
  lines.push("");
  lines.push("# Per-currency");
  lines.push(toCsvLine(["currency", "volume_eur", "donation_count"]));
  for (const row of result.perCurrency) {
    lines.push(
      toCsvLine([row.currency, centsToMajor(row.volumeCents), row.donationCount.toString()]),
    );
  }

  // ─── Timeseries ──────────────────────────────────────────────────────
  lines.push("");
  lines.push("# Timeseries");
  lines.push(toCsvLine(["date", "volume_eur", "revenue_eur"]));
  for (const row of result.timeseries) {
    lines.push(
      toCsvLine([row.date, centsToMajor(row.volumeCents), centsToMajor(row.platformFeeCents)]),
    );
  }

  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** Filename surfaced in the `Content-Disposition` header. */
export function buildFinanceSummaryCsvFilename(period: string, today: Date = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  return `givernance-finance-${period}-${iso}.csv`;
}
