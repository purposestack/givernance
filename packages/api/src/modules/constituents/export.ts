/**
 * Constituents CSV export (Epic #539 §5, docs/35 §4).
 *
 * `GET /v1/constituents/export.csv` — canonical columns plus one column
 * per `exportable` non-archived custom-field definition (admin
 * `sort_order`), honoring the advanced-filter `?filters=` DSL. Doubles
 * as the DSAR / Art. 15 vehicle: option ids resolve to their labels so
 * a data subject reads "Grand donateur", never `opt_a1b2c3d4`.
 *
 * Streaming-friendly: rows are produced by an async generator over
 * keyset-paginated batches (each batch its own tenant-context
 * transaction), so a 50k-constituent export never materialises in
 * memory. Export is never plan-gated.
 */

import { Readable } from "node:stream";
import type { CustomFieldDefinition, CustomFieldValue } from "@givernance/shared/custom-fields";
import { constituents } from "@givernance/shared/schema";
import { and, asc, eq, getTableColumns, gt, isNull } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import type { FieldRegistryBundle } from "./filters/field-registry.js";
import { donationStatsJoin, FilterService } from "./filters/filter.service.js";
import type { FilterQuery } from "./filters/types.js";

const BOM = "\uFEFF";
const EXPORT_BATCH_SIZE = 500;

/**
 * Canonical (core-column) export headers. Deliberately close to the
 * bulk-import template's `CANONICAL_HEADERS` so an export round-trips
 * through import with minimal massaging; `types` is the canonical
 * multi-valued column (issue #465), joined `'; '` like tags.
 */
export const CONSTITUENT_EXPORT_HEADERS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
  "types",
  "tags",
  "createdAt",
] as const;

// CSV-injection neutraliser — same posture as the finance CSV
// (`superadmin/finance/csv.ts`): names, tags, and custom values are
// tenant-authored and therefore attacker-controllable; a leading
// `= + - @` (or TAB/CR) would execute as a formula on open.
const FORMULA_LEADERS = /^[=+\-@\t\r]/;

function escapeCell(value: string): string {
  const needsFormulaGuard = FORMULA_LEADERS.test(value);
  const safe = needsFormulaGuard ? `'${value}` : value;
  if (needsFormulaGuard || /[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function toCsvLine(cells: readonly string[]): string {
  return cells.map(escapeCell).join(",");
}

function optionLabel(def: CustomFieldDefinition, id: string): string {
  return def.options.find((option) => option.id === id)?.label ?? id;
}

/**
 * Renders one stored custom value for CSV: option ids → labels
 * (multi joined `'; '`), currency cents → major unit, absent → empty.
 */
export function formatCustomValueForExport(def: CustomFieldDefinition, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (def.type) {
    case "picklist":
      return typeof value === "string" ? optionLabel(def, value) : "";
    case "multi_picklist":
      return Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => optionLabel(def, entry))
            .join("; ")
        : "";
    case "currency":
      return typeof value === "number" ? (value / 100).toFixed(2) : "";
    case "boolean":
      return value === true ? "true" : "false";
    default:
      return String(value as CustomFieldValue);
  }
}

/**
 * Header cell for a custom column. Sensitive (Art. 9) definitions stay
 * exportable — export is the DSAR vehicle — but their headers carry the
 * flag so a recipient file is self-describing (docs/35 §6). Archived
 * definitions export read-only with an explicit suffix; the suffixed
 * header also keeps them from resolving as an import column on
 * round-trip (their label no longer matches).
 */
export function customExportHeader(def: CustomFieldDefinition & { archived?: boolean }): string {
  const base = def.sensitive ? `${def.label} (Art. 9)` : def.label;
  return def.archived ? `${base} (archived)` : base;
}

type ExportRow = typeof constituents.$inferSelect;

async function fetchExportBatch(
  orgId: string,
  cursor: string | null,
  advancedFilter: FilterQuery | undefined,
  registryBundle: FieldRegistryBundle | undefined,
): Promise<ExportRow[]> {
  return withTenantContext(orgId, async (tx) => {
    // Aggregate DSL conditions (LYBUNT, totalAmount, …) reference the
    // `donation_stats` alias — join it only when a filter is present,
    // mirroring `listConstituents`. The registry bundle lets `custom.<key>`
    // conditions compile against the per-org catalog.
    const advancedWhere = advancedFilter
      ? new FilterService(orgId, undefined, registryBundle).buildCompleteWhereClause(advancedFilter)
      : undefined;

    // Explicit column projection keeps the row shape flat even when the
    // donation_stats join is present (same trick as `listConstituents`).
    let query = tx.select(getTableColumns(constituents)).from(constituents).$dynamic();
    if (advancedFilter) {
      const join = donationStatsJoin(orgId);
      query = query.leftJoin(join.source, join.on);
    }

    return query
      .where(
        and(
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
          cursor ? gt(constituents.id, cursor) : undefined,
          advancedWhere,
        ),
      )
      .orderBy(asc(constituents.id))
      .limit(EXPORT_BATCH_SIZE);
  });
}

function rowToCells(row: ExportRow, exportableDefs: readonly CustomFieldDefinition[]): string[] {
  const custom = (row.custom ?? {}) as Record<string, unknown>;
  return [
    row.firstName,
    row.lastName,
    row.email ?? "",
    row.phone ?? "",
    row.addressLine1 ?? "",
    row.addressLine2 ?? "",
    row.postalCode ?? "",
    row.city ?? "",
    row.countryCode ?? "",
    (row.types ?? []).join("; "),
    (row.tags ?? []).join("; "),
    row.createdAt.toISOString(),
    ...exportableDefs.map((def) => formatCustomValueForExport(def, custom[def.key])),
  ];
}

async function* generateConstituentsCsv(
  orgId: string,
  exportableDefs: readonly CustomFieldDefinition[],
  advancedFilter: FilterQuery | undefined,
  registryBundle: FieldRegistryBundle | undefined,
): AsyncGenerator<string> {
  const headers = [...CONSTITUENT_EXPORT_HEADERS, ...exportableDefs.map(customExportHeader)];
  yield `${BOM}${toCsvLine(headers)}\r\n`;

  let cursor: string | null = null;
  for (;;) {
    const batch: ExportRow[] = await fetchExportBatch(
      orgId,
      cursor,
      advancedFilter,
      registryBundle,
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      yield `${toCsvLine(rowToCells(row, exportableDefs))}\r\n`;
    }
    const last = batch.at(-1);
    if (!last || batch.length < EXPORT_BATCH_SIZE) break;
    cursor = last.id;
  }
}

/**
 * Builds the response stream. `exportableDefs` is the caller-filtered
 * `exportable` subset of the active catalog — the definition-driven
 * firewall for this surface: only those keys ever leave the blob.
 */
export function streamConstituentsCsv(
  orgId: string,
  exportableDefs: readonly CustomFieldDefinition[],
  advancedFilter: FilterQuery | undefined,
  registryBundle?: FieldRegistryBundle,
): Readable {
  return Readable.from(
    generateConstituentsCsv(orgId, exportableDefs, advancedFilter, registryBundle),
  );
}

/** Filename surfaced in the `Content-Disposition` header. */
export function constituentsExportFilename(today: Date = new Date()): string {
  return `constituents-export-${today.toISOString().slice(0, 10)}.csv`;
}
