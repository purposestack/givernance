/**
 * Bulk-import file parser (Epic #373).
 *
 * Reads a CSV or XLSX buffer into a normalised row stream. Outcome is a
 * `{ headers, rows }` shape where each row is a `Record<string, string>`
 * keyed by the normalised header.
 *
 * Hardening posture:
 *   - **Formula-injection guard**: cell strings starting with `=`, `+`,
 *     `-`, `@`, `\t`, `\r` are prefixed with a single quote so a
 *     re-export to Excel can't auto-evaluate them (CWE-1236). Applied to
 *     both CSV and XLSX inputs.
 *   - **XLSX formula rejection**: cells that are formula objects
 *     (`{ formula: …, result: … }`) are rejected outright with
 *     `INVALID_CELL` rather than silently using `result` — the operator
 *     has zero use case for a formula on a CRM import; refusing keeps
 *     us safe even if a future ExcelJS version changes formula
 *     evaluation defaults.
 *   - **Row cap**: 50 000 rows. Anything above bails with `TOO_MANY_ROWS`
 *     so a runaway upload can't OOM the worker.
 *   - **Required headers**: `firstName` + `lastName`. Header normalisation
 *     accepts snake_case / kebab-case / Title Case variants the operator
 *     might produce in Excel.
 */

import { parse as parseCsvSync } from "csv-parse/sync";
import ExcelJS from "exceljs";

/** Hard cap. The bucket cap is 10 MB which itself bounds the row count, but a small XLSX with many short rows can still reach this limit. */
export const MAX_BULK_IMPORT_ROWS = 50_000;

export type BulkImportParseErrorCode =
  | "EMPTY_FILE"
  | "MISSING_REQUIRED_HEADERS"
  | "TOO_MANY_ROWS"
  | "UNREADABLE_FILE"
  | "INVALID_CELL";

export class BulkImportParseError extends Error {
  constructor(
    message: string,
    public readonly code: BulkImportParseErrorCode,
    public readonly rowNumber?: number,
  ) {
    super(message);
    this.name = "BulkImportParseError";
  }
}

export interface ParsedRow {
  /** 1-based row number in the source file, EXCLUDING the header row. */
  rowNumber: number;
  /** Cell values keyed by normalised header. Empty cells dropped (not present). */
  values: Record<string, string>;
}

export interface ParseResult {
  /** Normalised header keys, in source-file order. */
  headers: string[];
  rows: ParsedRow[];
}

/**
 * Canonical header keys the validation step expects. The parser
 * normalises arbitrary user input (Title Case, snake_case, kebab-case,
 * surrounding whitespace) to one of these — anything else is dropped.
 */
export const CANONICAL_HEADERS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
  "type",
  "tags",
] as const;
export type CanonicalHeader = (typeof CANONICAL_HEADERS)[number];

const HEADER_ALIASES: Record<string, CanonicalHeader> = {
  firstname: "firstName",
  first_name: "firstName",
  "first-name": "firstName",
  "first name": "firstName",
  prenom: "firstName",
  prénom: "firstName",
  lastname: "lastName",
  last_name: "lastName",
  "last-name": "lastName",
  "last name": "lastName",
  surname: "lastName",
  nom: "lastName",
  email: "email",
  "e-mail": "email",
  mail: "email",
  courriel: "email",
  phone: "phone",
  telephone: "phone",
  téléphone: "phone",
  tel: "phone",
  mobile: "phone",
  addressline1: "addressLine1",
  address_line_1: "addressLine1",
  "address-line-1": "addressLine1",
  "address line 1": "addressLine1",
  address1: "addressLine1",
  address: "addressLine1",
  adresse: "addressLine1",
  addressline2: "addressLine2",
  address_line_2: "addressLine2",
  "address-line-2": "addressLine2",
  "address line 2": "addressLine2",
  address2: "addressLine2",
  postalcode: "postalCode",
  postal_code: "postalCode",
  "postal-code": "postalCode",
  "postal code": "postalCode",
  zip: "postalCode",
  zipcode: "postalCode",
  cp: "postalCode",
  "code postal": "postalCode",
  city: "city",
  ville: "city",
  town: "city",
  countrycode: "countryCode",
  country_code: "countryCode",
  "country-code": "countryCode",
  "country code": "countryCode",
  country: "countryCode",
  pays: "countryCode",
  type: "type",
  "constituent type": "type",
  tags: "tags",
  labels: "tags",
};

function normaliseHeaderToken(raw: string): CanonicalHeader | null {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleaned) return null;
  // Direct canonical-key hit (already camelCase).
  for (const canonical of CANONICAL_HEADERS) {
    if (cleaned === canonical.toLowerCase()) return canonical;
  }
  return HEADER_ALIASES[cleaned] ?? null;
}

/**
 * Would this header be claimed by the core map? The template generator
 * (Epic #539) consults this so a custom-field label that shadows a core
 * alias (e.g. "Email") is emitted as its `cf_<key>` alias instead —
 * core resolution always wins on import, so the label header would
 * misroute the column.
 */
export function isCoreImportHeader(raw: string): boolean {
  return normaliseHeaderToken(raw) !== null;
}

/**
 * Spreadsheet formula-injection mitigation (CWE-1236). Excel and most
 * CSV consumers evaluate cells starting with one of these as a formula;
 * prefixing with `'` makes them plain text on re-export.
 */
function neutraliseFormulaPrefix(value: string): string {
  if (!value) return value;
  const first = value.charCodeAt(0);
  // = + - @ \t \r
  if (
    first === 0x3d ||
    first === 0x2b ||
    first === 0x2d ||
    first === 0x40 ||
    first === 0x09 ||
    first === 0x0d
  ) {
    return `'${value}`;
  }
  return value;
}

function fromString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : neutraliseFormulaPrefix(trimmed);
}

function fromObject(obj: Record<string, unknown>): string | null {
  if ("formula" in obj) {
    throw new BulkImportParseError(
      "Formula cells are not supported in bulk imports",
      "INVALID_CELL",
    );
  }
  if (typeof obj.text === "string") return fromString(obj.text);
  if (typeof obj.result === "string") return fromString(obj.result);
  return null;
}

function normaliseCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return fromString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return fromObject(value as Record<string, unknown>);
  return null;
}

function ensureRequiredHeaders(headers: (CanonicalHeader | null)[]): CanonicalHeader[] {
  const present = headers.filter((h): h is CanonicalHeader => h !== null);
  const set = new Set(present);
  if (!set.has("firstName") || !set.has("lastName")) {
    throw new BulkImportParseError(
      "Required columns missing: firstName and lastName are mandatory",
      "MISSING_REQUIRED_HEADERS",
    );
  }
  return present;
}

function isCsv(mimeType: string, fileName: string): boolean {
  const lower = mimeType.toLowerCase();
  if (lower === "text/csv" || lower === "application/csv" || lower === "text/plain") return true;
  return /\.csv$/i.test(fileName);
}

/**
 * Parse a CSV buffer (synchronous, RFC 4180-ish). `relax_quotes` so a
 * single stray quote inside a value doesn't abort the whole import,
 * and `bom: true` so an Excel-saved UTF-8 BOM is stripped before the
 * header row is read.
 */
function parseCsv(buffer: Buffer): ParseResult {
  let records: string[][];
  try {
    records = parseCsvSync(buffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: false, // we trim at the cell level so we can detect the formula prefix on raw input
    }) as string[][];
  } catch (err) {
    throw new BulkImportParseError(
      `CSV could not be parsed: ${err instanceof Error ? err.message : "unknown error"}`,
      "UNREADABLE_FILE",
    );
  }
  if (records.length === 0) {
    throw new BulkImportParseError("CSV is empty", "EMPTY_FILE");
  }
  const headerRow = records[0] ?? [];
  const headerKeys = headerRow.map((h) => normaliseHeaderToken(h ?? ""));
  ensureRequiredHeaders(headerKeys);

  const headers = headerKeys.filter((h): h is CanonicalHeader => h !== null);

  const dataRows = records.slice(1);
  if (dataRows.length > MAX_BULK_IMPORT_ROWS) {
    throw new BulkImportParseError(
      `File exceeds the ${MAX_BULK_IMPORT_ROWS}-row limit`,
      "TOO_MANY_ROWS",
    );
  }

  const rows: ParsedRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i] ?? [];
    const values: Record<string, string> = {};
    for (let j = 0; j < headerKeys.length; j++) {
      const key = headerKeys[j];
      if (!key) continue;
      const raw = cols[j];
      const normalised = normaliseCell(raw);
      if (normalised !== null) values[key] = normalised;
    }
    rows.push({ rowNumber: i + 1, values });
  }

  return { headers, rows };
}

function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS narrows to a plain Buffer; cast through ArrayBuffer to keep
  // tsc strict happy under Node 20+'s `Buffer<ArrayBufferLike>`.
  return wb.xlsx
    .load(buffer as unknown as ArrayBuffer)
    .then(() => wb)
    .catch((err: unknown) => {
      throw new BulkImportParseError(
        `XLSX could not be parsed: ${err instanceof Error ? err.message : "unknown error"}`,
        "UNREADABLE_FILE",
      );
    });
}

function extractXlsxHeaderKeys(headerValues: unknown[]): (CanonicalHeader | null)[] {
  const keys: (CanonicalHeader | null)[] = [];
  // ExcelJS rows are 1-indexed; values[0] is undefined.
  for (let col = 1; col < headerValues.length; col++) {
    const raw = headerValues[col];
    const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    keys.push(normaliseHeaderToken(text));
  }
  return keys;
}

function extractXlsxRowValues(
  cells: unknown[],
  headerKeys: (CanonicalHeader | null)[],
  rowIndex: number,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (let col = 1; col < cells.length; col++) {
    const headerKey = headerKeys[col - 1];
    if (!headerKey) continue;
    try {
      const normalised = normaliseCell(cells[col]);
      if (normalised !== null) values[headerKey] = normalised;
    } catch (err) {
      if (err instanceof BulkImportParseError && err.code === "INVALID_CELL") {
        throw new BulkImportParseError(err.message, "INVALID_CELL", rowIndex);
      }
      throw err;
    }
  }
  return values;
}

async function parseXlsx(buffer: Buffer): Promise<ParseResult> {
  const workbook = await loadWorkbook(buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount === 0) {
    throw new BulkImportParseError("Workbook has no data", "EMPTY_FILE");
  }

  const headerRow = sheet.getRow(1);
  const headerValues = Array.isArray(headerRow.values) ? (headerRow.values as unknown[]) : [];
  const headerKeys = extractXlsxHeaderKeys(headerValues);
  ensureRequiredHeaders(headerKeys);

  const headers = headerKeys.filter((h): h is CanonicalHeader => h !== null);

  if (sheet.rowCount - 1 > MAX_BULK_IMPORT_ROWS) {
    throw new BulkImportParseError(
      `File exceeds the ${MAX_BULK_IMPORT_ROWS}-row limit`,
      "TOO_MANY_ROWS",
    );
  }

  const rows: ParsedRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const cells = Array.isArray(row.values) ? (row.values as unknown[]) : [];
    const values = extractXlsxRowValues(cells, headerKeys, r - 1);
    rows.push({ rowNumber: r - 1, values });
  }

  return { headers, rows };
}

/** Decide CSV vs XLSX from the sniffed MIME type / filename. */
export async function parseBulkImportFile(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ParseResult> {
  if (isCsv(mimeType, fileName)) {
    return parseCsv(buffer);
  }
  return parseXlsx(buffer);
}
