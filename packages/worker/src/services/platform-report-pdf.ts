/**
 * PDF renderer for the super-admin monthly finance report (issue #443).
 *
 * Input: the frozen `kpi_snapshot` JSON the API built before enqueuing
 * the job (full `SummaryServiceResult` payload). Output: a PDFKit
 * Readable that `uploadPlatformReportPdf` streams directly into the
 * private `reports` bucket.
 *
 * Layout follows the issue's 5-section spec:
 *   1. Cover — month, tenant count, generation date, platform grade
 *   2. KPIs — volume, revenue, MRR, Stripe fees, refunds, deltas
 *   3. Top 10 tenants by volume with Mobilisation grade
 *   4. Survey snapshot (PMF / NPS / CSAT) gated on k-anonymity
 *   5. Footer — disclaimer + data source path
 *
 * Locale: French — the dashboard ships fr-FR, and the report is a
 * direct PDF mirror of the dashboard. An i18n table for this PDF is
 * deferred to a follow-up; one locale string lives at the top so a
 * future translator only needs to edit one file.
 */

import PDFDocument from "pdfkit";

// ─── Frozen snapshot shape ─────────────────────────────────────────────────
//
// Mirrors the `SummaryServiceResult` exported by
// `packages/api/src/modules/superadmin/finance/service.ts`. Duplicated
// here (not imported) because the worker cannot depend on @givernance/api.
// The structural shape is the contract — kept in lockstep with the API
// type by the `kpi_snapshot` integration test (issue #443).

export interface ReportSnapshot {
  period: {
    from: string;
    to: string;
    label: string;
    comparisonFrom: string;
    comparisonTo: string;
  };
  kpis: {
    volumeCents: number;
    platformFeeCents: number;
    stripeFeeCents: number | null;
    donorCount: number;
    refundedVolumeCents: number;
    recurringMrrCents: number;
    activeTenantsCount: number;
    paymentFailureRate: number | null;
    hhi: number;
    deltas: {
      volumePercent: number;
      platformFeePercent: number;
      stripeFeePercent: number | null;
      donorCountPercent: number;
      refundedVolumePercent: number;
      recurringMrrPercent: number;
    };
  };
  mobilisation: {
    platformGrade: "A+" | "A" | "B" | "C" | "D" | null;
    platformScore: number | null;
    perTenant: Array<{
      tenantId: string;
      tenantName: string;
      grade: "A+" | "A" | "B" | "C" | "D" | null;
      score: number | null;
      isAnonymised: boolean;
    }>;
  };
  surveys: Array<{
    kind: "pmf" | "nps" | "csat";
    slug: string;
    responseCount: number;
    invitedCount: number;
    pmfPercent: number | null;
    npsScore: number | null;
    csatScore: number | null;
    isStatisticallySignificant: boolean;
  }>;
  perTenant: Array<{
    tenantId: string;
    tenantName: string;
    volumeCents: number;
    platformFeeCents: number;
    donationCount: number;
  }>;
}

export interface PlatformReportPdfInput {
  reportId: string;
  month: string;
  snapshot: ReportSnapshot;
  generatedAt: Date;
}

// ─── Brand palette — mirror packages/web/src/app/globals.css ──────────────
const COLOR_PRIMARY = "#096447";
const COLOR_ON_SURFACE = "#1c1b1a";
const COLOR_ON_SURFACE_VARIANT = "#42403e";
const COLOR_OUTLINE = "#72706e";
const COLOR_OUTLINE_VARIANT = "#c3c1bc";
const COLOR_SURFACE_CONTAINER = "#f2f0ec";
const COLOR_ERROR = "#ba1a1a";

// ─── Page geometry — A4 portrait, 50pt margins ─────────────────────────────
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const CONTENT_LEFT = MARGIN_LEFT;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN_RIGHT;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

// KPI table columns (left edges).
const KPI_COL_LABEL_X = CONTENT_LEFT;
const KPI_COL_LABEL_W = 240;
const KPI_COL_VALUE_X = CONTENT_LEFT + 260;
const KPI_COL_VALUE_W = 130;
const KPI_COL_DELTA_X = CONTENT_LEFT + 400;
const KPI_COL_DELTA_W = CONTENT_RIGHT - (CONTENT_LEFT + 400);

// Top-tenants table columns.
//
// Geometry (CONTENT_LEFT=50, CONTENT_RIGHT=~545, CONTENT_WIDTH=~495):
//   NAME    [  50 → 280 ]  W=230  (left-aligned, ellipsised)
//   VOLUME  [ 290 → 400 ]  W=110  (right-aligned, bold)
//   DONS    [ 410 → 470 ]  W=60   (right-aligned, subdued)
//   GRADE   [ 480 → 545 ]  W=65   (right-aligned, primary green)
const T_COL_NAME_X = CONTENT_LEFT;
const T_COL_NAME_W = 230;
const T_COL_AMOUNT_X = CONTENT_LEFT + 240;
const T_COL_AMOUNT_W = 110;
const T_COL_COUNT_X = CONTENT_LEFT + 360;
const T_COL_COUNT_W = 60;
const T_COL_GRADE_X = CONTENT_LEFT + 430;
const T_COL_GRADE_W = CONTENT_RIGHT - (CONTENT_LEFT + 430);

// ─── Formatters — Helvetica-safe (no narrow NBSP that PDFKit renders as `/`) ─
// `Intl.NumberFormat("fr-FR")` uses U+202F (narrow no-break space) as
// the thousand separator since ICU 72. PDFKit's bundled Helvetica
// can't render that codepoint and substitutes `/`, producing values
// like `82 /280 €`. We format with regular ASCII spaces instead.

function fmtThousands(n: number): string {
  // Integer thousand separator with REGULAR space — matches FR
  // convention visually but stays inside Helvetica's glyph set.
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "-" : "";
  return (
    sign +
    Math.abs(rounded)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  );
}

function fmtEur(cents: number): string {
  return `${fmtThousands(cents / 100)} €`;
}

function fmtCount(n: number): string {
  return fmtThousands(n);
}

function fmtDeltaPct(value: number | null): string {
  if (value === null) return "n/a";
  // `value` is already a percentage (e.g. 12.4 means +12.4%).
  const sign = value > 0 ? "+" : "";
  // FR decimal separator is comma; safe in Helvetica.
  return `${sign}${value.toFixed(1).replace(".", ",")} %`;
}

function generationDateLabel(d: Date): string {
  // `Intl.DateTimeFormat("fr-FR")` uses narrow NBSP too — build the
  // label manually.
  const months = [
    "janv.",
    "févr.",
    "mars",
    "avr.",
    "mai",
    "juin",
    "juil.",
    "août",
    "sept.",
    "oct.",
    "nov.",
    "déc.",
  ];
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year} à ${hh}:${mm} UTC`;
}

type PdfDoc = InstanceType<typeof PDFDocument>;

function deltaColor(value: number | null): string {
  if (value === null) return COLOR_OUTLINE;
  if (value > 0.05) return COLOR_PRIMARY;
  if (value < -0.05) return COLOR_ERROR;
  return COLOR_OUTLINE;
}

/** Horizontal divider line at the current y. */
function divider(doc: PdfDoc, color = COLOR_OUTLINE_VARIANT): void {
  const y = doc.y + 4;
  doc.save();
  doc.moveTo(CONTENT_LEFT, y).lineTo(CONTENT_RIGHT, y).lineWidth(0.5).strokeColor(color).stroke();
  doc.restore();
  doc.y = y + 8;
}

function sectionTitle(doc: PdfDoc, text: string): void {
  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(13);
  doc.text(text, CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH, align: "left" });
  doc.font("Helvetica").fontSize(10).fillColor(COLOR_ON_SURFACE);
  doc.moveDown(0.4);
  divider(doc, COLOR_OUTLINE_VARIANT);
}

// ─── 1. Cover ────────────────────────────────────────────────────────────
function renderCover(doc: PdfDoc, input: PlatformReportPdfInput): void {
  const { snapshot, month, generatedAt, reportId } = input;

  // Brand stripe at the top of the page (full-bleed, 6pt tall).
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, 6).fill(COLOR_PRIMARY);
  doc.restore();

  // Eyebrow.
  doc.font("Helvetica").fontSize(9).fillColor(COLOR_OUTLINE);
  doc.text("GIVERNANCE · FINANCE PLATEFORME", CONTENT_LEFT, MARGIN_LEFT, {
    width: CONTENT_WIDTH,
    align: "left",
    characterSpacing: 1.2,
  });

  // Main title.
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(26).fillColor(COLOR_ON_SURFACE);
  doc.text("Rapport mensuel", CONTENT_LEFT, doc.y, {
    width: CONTENT_WIDTH,
    align: "left",
  });

  // Period.
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(14).fillColor(COLOR_ON_SURFACE_VARIANT);
  doc.text(`Période · ${month}`, CONTENT_LEFT, doc.y, {
    width: CONTENT_WIDTH,
    align: "left",
  });

  // Metadata strip.
  doc.moveDown(0.6);
  doc.fontSize(9).fillColor(COLOR_OUTLINE);
  doc.text(`Généré le ${generationDateLabel(generatedAt)} · ID ${reportId}`, CONTENT_LEFT, doc.y, {
    width: CONTENT_WIDTH,
    align: "left",
  });

  doc.moveDown(1.4);

  // Hero card — tenant count + platform grade in a tinted box.
  const cardY = doc.y;
  const cardH = 60;
  doc.save();
  doc.roundedRect(CONTENT_LEFT, cardY, CONTENT_WIDTH, cardH, 6).fill(COLOR_SURFACE_CONTAINER);
  doc.restore();

  const tenantCount = snapshot.kpis.activeTenantsCount;
  const grade = snapshot.mobilisation.platformGrade ?? "—";
  const score = snapshot.mobilisation.platformScore?.toFixed(0) ?? "—";

  // Left half of the card — tenants.
  doc.font("Helvetica").fontSize(9).fillColor(COLOR_OUTLINE);
  doc.text("TENANTS ACTIFS", CONTENT_LEFT + 16, cardY + 12, { characterSpacing: 1.2 });
  doc.font("Helvetica-Bold").fontSize(22).fillColor(COLOR_ON_SURFACE);
  doc.text(fmtCount(tenantCount), CONTENT_LEFT + 16, cardY + 24);

  // Right half of the card — Mobilisation score.
  doc.font("Helvetica").fontSize(9).fillColor(COLOR_OUTLINE);
  doc.text("SCORE MOBILISATION AGRÉGÉ", CONTENT_LEFT + CONTENT_WIDTH / 2 + 16, cardY + 12, {
    characterSpacing: 1.2,
  });
  doc.font("Helvetica-Bold").fontSize(22).fillColor(COLOR_PRIMARY);
  doc.text(`${grade}`, CONTENT_LEFT + CONTENT_WIDTH / 2 + 16, cardY + 24);
  doc.font("Helvetica").fontSize(11).fillColor(COLOR_OUTLINE);
  doc.text(`${score}/100`, CONTENT_LEFT + CONTENT_WIDTH / 2 + 50, cardY + 32);

  doc.y = cardY + cardH + 18;
}

// ─── 2. KPIs ─────────────────────────────────────────────────────────────
interface KpiRow {
  label: string;
  value: string;
  delta: string;
  deltaValue: number | null;
  isCost?: boolean;
}

function buildKpiRows(snapshot: ReportSnapshot): KpiRow[] {
  const k = snapshot.kpis;
  return [
    {
      label: "Volume des dons",
      value: fmtEur(k.volumeCents),
      delta: fmtDeltaPct(k.deltas.volumePercent),
      deltaValue: k.deltas.volumePercent,
    },
    {
      label: "Revenu Givernance",
      value: fmtEur(k.platformFeeCents),
      delta: fmtDeltaPct(k.deltas.platformFeePercent),
      deltaValue: k.deltas.platformFeePercent,
    },
    {
      label: "Frais Stripe",
      value: k.stripeFeeCents === null ? "n/a" : fmtEur(k.stripeFeeCents),
      delta: fmtDeltaPct(k.deltas.stripeFeePercent),
      deltaValue: k.deltas.stripeFeePercent,
      isCost: true,
    },
    {
      label: "MRR récurrent (instantané)",
      value: fmtEur(k.recurringMrrCents),
      delta: fmtDeltaPct(k.deltas.recurringMrrPercent),
      deltaValue: k.deltas.recurringMrrPercent,
    },
    {
      label: "Remboursements",
      value: fmtEur(k.refundedVolumeCents),
      delta: fmtDeltaPct(k.deltas.refundedVolumePercent),
      deltaValue: k.deltas.refundedVolumePercent,
      isCost: true,
    },
    {
      label: "Donateurs uniques",
      value: fmtCount(k.donorCount),
      delta: fmtDeltaPct(k.deltas.donorCountPercent),
      deltaValue: k.deltas.donorCountPercent,
    },
    {
      label: "Taux d'échec paiement (Stripe)",
      value:
        k.paymentFailureRate === null
          ? "n/a"
          : `${k.paymentFailureRate.toFixed(1).replace(".", ",")} %`,
      delta: "—",
      deltaValue: null,
    },
    {
      label: "Concentration HHI",
      value: fmtThousands(k.hhi),
      delta: "—",
      deltaValue: null,
    },
  ];
}

function renderKpis(doc: PdfDoc, snapshot: ReportSnapshot): void {
  sectionTitle(doc, "Indicateurs financiers");

  const rows = buildKpiRows(snapshot);
  const rowH = 22;
  doc.font("Helvetica").fontSize(10);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const y = doc.y;

    // Alternating zebra-stripe background for readability.
    if (i % 2 === 0) {
      doc.save();
      doc.rect(CONTENT_LEFT, y - 4, CONTENT_WIDTH, rowH).fill(COLOR_SURFACE_CONTAINER);
      doc.restore();
    }

    doc.fillColor(COLOR_ON_SURFACE_VARIANT).font("Helvetica");
    doc.text(row.label, KPI_COL_LABEL_X + 6, y, { width: KPI_COL_LABEL_W, align: "left" });

    doc.fillColor(COLOR_ON_SURFACE).font("Helvetica-Bold");
    doc.text(row.value, KPI_COL_VALUE_X, y, { width: KPI_COL_VALUE_W, align: "right" });

    // For cost-type KPIs, an INCREASE is bad — invert the delta color.
    const baseColor = deltaColor(row.deltaValue);
    const color =
      row.isCost && row.deltaValue !== null && Math.abs(row.deltaValue) > 0.05
        ? row.deltaValue > 0
          ? COLOR_ERROR
          : COLOR_PRIMARY
        : baseColor;
    doc.fillColor(color).font("Helvetica");
    doc.text(row.delta, KPI_COL_DELTA_X, y, {
      width: KPI_COL_DELTA_W - 6,
      align: "right",
    });

    doc.y = y + rowH - 4;
  }

  doc.fillColor(COLOR_ON_SURFACE);
  doc.moveDown(0.8);
}

// ─── 3. Top tenants ──────────────────────────────────────────────────────
function renderTopTenants(doc: PdfDoc, snapshot: ReportSnapshot): void {
  sectionTitle(doc, "Top 10 tenants par volume");

  const tenantsByVolume = [...snapshot.perTenant]
    .sort((a, b) => b.volumeCents - a.volumeCents)
    .slice(0, 10);
  const gradeByTenantId = new Map(
    snapshot.mobilisation.perTenant.map((m) => [
      m.tenantId,
      m.isAnonymised ? "—" : (m.grade ?? "—"),
    ]),
  );

  if (tenantsByVolume.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_OUTLINE);
    doc.text("Aucune donation cleared sur la période.", CONTENT_LEFT, doc.y, {
      width: CONTENT_WIDTH,
    });
    doc.fillColor(COLOR_ON_SURFACE);
    doc.moveDown(0.8);
    return;
  }

  // Column headers.
  doc.font("Helvetica").fontSize(8).fillColor(COLOR_OUTLINE);
  const headerY = doc.y;
  doc.text("TENANT", T_COL_NAME_X, headerY, {
    width: T_COL_NAME_W,
    align: "left",
    characterSpacing: 1.2,
  });
  doc.text("VOLUME", T_COL_AMOUNT_X, headerY, {
    width: T_COL_AMOUNT_W,
    align: "right",
    characterSpacing: 1.2,
  });
  doc.text("DONS", T_COL_COUNT_X, headerY, {
    width: T_COL_COUNT_W,
    align: "right",
    characterSpacing: 1.2,
  });
  doc.text("GRADE", T_COL_GRADE_X, headerY, {
    width: T_COL_GRADE_W,
    align: "right",
    characterSpacing: 1.2,
  });
  doc.y = headerY + 14;
  divider(doc);

  const rowH = 20;
  doc.font("Helvetica").fontSize(10);
  for (let i = 0; i < tenantsByVolume.length; i += 1) {
    const t = tenantsByVolume[i];
    if (!t) continue;
    const y = doc.y;

    if (i % 2 === 0) {
      doc.save();
      doc.rect(CONTENT_LEFT, y - 4, CONTENT_WIDTH, rowH).fill(COLOR_SURFACE_CONTAINER);
      doc.restore();
    }

    doc.fillColor(COLOR_ON_SURFACE).font("Helvetica");
    doc.text(t.tenantName, T_COL_NAME_X + 6, y, {
      width: T_COL_NAME_W - 6,
      align: "left",
      ellipsis: true,
    });
    doc.font("Helvetica-Bold");
    doc.text(fmtEur(t.volumeCents), T_COL_AMOUNT_X, y, {
      width: T_COL_AMOUNT_W,
      align: "right",
    });
    doc.font("Helvetica").fillColor(COLOR_ON_SURFACE_VARIANT);
    doc.text(fmtCount(t.donationCount), T_COL_COUNT_X, y, {
      width: T_COL_COUNT_W,
      align: "right",
    });
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold");
    doc.text(gradeByTenantId.get(t.tenantId) ?? "—", T_COL_GRADE_X, y, {
      width: T_COL_GRADE_W - 6,
      align: "right",
    });

    doc.y = y + rowH - 4;
  }

  doc.fillColor(COLOR_ON_SURFACE);
  doc.moveDown(0.8);
}

// ─── 4. Surveys ──────────────────────────────────────────────────────────
function surveyMetricLabel(s: ReportSnapshot["surveys"][number]): string {
  if (s.kind === "pmf") {
    const v = s.pmfPercent === null ? "n/a" : `${s.pmfPercent.toFixed(0)} %`;
    return v;
  }
  if (s.kind === "nps") {
    return s.npsScore === null ? "n/a" : s.npsScore.toFixed(0);
  }
  return s.csatScore === null ? "n/a" : `${s.csatScore.toFixed(1).replace(".", ",")} / 5`;
}

function renderSurveys(doc: PdfDoc, snapshot: ReportSnapshot): void {
  sectionTitle(doc, "Satisfaction tenants");

  if (snapshot.surveys.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_OUTLINE);
    doc.text("Aucun sondage activé.", CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH });
    doc.fillColor(COLOR_ON_SURFACE);
    doc.moveDown(0.8);
    return;
  }

  // One-line layout — all cells share a single y baseline so the slug
  // can't bleed into the next row's chip.
  //   KIND     [   0 →  60 ]  W=60   primary bold
  //   SLUG     [  70 → 270 ]  W=200  subdued
  //   VALUE    [ 280 → 410 ]  W=130  right-aligned bold
  //   N=X/Y    [ 420 → end ]         right-aligned subdued
  const S_KIND_X = CONTENT_LEFT + 6;
  const S_KIND_W = 60;
  const S_SLUG_X = CONTENT_LEFT + 70;
  const S_SLUG_W = 200;
  const S_VALUE_X = CONTENT_LEFT + 280;
  const S_VALUE_W = 130;
  const S_N_X = CONTENT_LEFT + 420;
  const S_N_W = CONTENT_RIGHT - (CONTENT_LEFT + 420) - 6;
  const rowH = 22;

  for (let i = 0; i < snapshot.surveys.length; i += 1) {
    const s = snapshot.surveys[i];
    if (!s) continue;
    const y = doc.y;

    if (i % 2 === 0) {
      doc.save();
      doc.rect(CONTENT_LEFT, y - 4, CONTENT_WIDTH, rowH).fill(COLOR_SURFACE_CONTAINER);
      doc.restore();
    }

    const cellY = y + 4;

    doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_PRIMARY);
    doc.text(s.kind.toUpperCase(), S_KIND_X, cellY, { width: S_KIND_W, align: "left" });

    doc.font("Helvetica").fontSize(8).fillColor(COLOR_OUTLINE);
    doc.text(s.slug, S_SLUG_X, cellY + 3, {
      width: S_SLUG_W,
      align: "left",
      ellipsis: true,
    });

    if (!s.isStatisticallySignificant) {
      doc.font("Helvetica").fontSize(9).fillColor(COLOR_OUTLINE);
      doc.text(
        `anonymisé (n=${fmtCount(s.responseCount)} < seuil k-anonymity)`,
        S_VALUE_X,
        cellY + 3,
        { width: CONTENT_RIGHT - S_VALUE_X - 6, align: "right" },
      );
    } else {
      doc.font("Helvetica-Bold").fontSize(12).fillColor(COLOR_ON_SURFACE);
      doc.text(surveyMetricLabel(s), S_VALUE_X, cellY, {
        width: S_VALUE_W,
        align: "right",
      });
      doc.font("Helvetica").fontSize(8).fillColor(COLOR_OUTLINE);
      doc.text(`n=${fmtCount(s.responseCount)}/${fmtCount(s.invitedCount)}`, S_N_X, cellY + 3, {
        width: S_N_W,
        align: "right",
      });
    }

    doc.y = y + rowH;
  }

  doc.fillColor(COLOR_ON_SURFACE);
  doc.moveDown(1);
}

// ─── 5. Footer ───────────────────────────────────────────────────────────
function renderFooter(doc: PdfDoc): void {
  // Footer accent stripe at the very bottom + disclaimer above it.
  const footerY = PAGE_HEIGHT - MARGIN_LEFT - 26;
  doc.font("Helvetica").fontSize(7).fillColor(COLOR_OUTLINE);
  doc.text(
    "Source : /v1/superadmin/finance/summary · cache 5 min · audit_logs (resource_type=platform_finance_report). " +
      "Ce rapport agrège des données cross-tenant via le pool BYPASSRLS systemDb et est destiné aux super-administrateurs Givernance uniquement.",
    CONTENT_LEFT,
    footerY,
    { width: CONTENT_WIDTH, align: "left" },
  );
  doc.save();
  doc.rect(0, PAGE_HEIGHT - 6, PAGE_WIDTH, 6).fill(COLOR_PRIMARY);
  doc.restore();
}

/**
 * Render the report as a PDFKit document. The caller pipes the
 * returned stream straight into the S3 multipart upload — no
 * intermediate buffering required.
 */
export function createPlatformReportPdfStream(input: PlatformReportPdfInput): PdfDoc {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const { snapshot } = input;

  renderCover(doc, input);
  renderKpis(doc, snapshot);
  renderTopTenants(doc, snapshot);
  renderSurveys(doc, snapshot);
  renderFooter(doc);

  doc.end();
  return doc;
}
