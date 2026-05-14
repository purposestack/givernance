/**
 * CSV template generator for bulk-import (Epic #373).
 *
 * Returned by `GET /v1/constituents/bulk-import/template`. The 10
 * example rows give the operator enough variety to figure out the
 * shape without having to read documentation: a few full addresses,
 * a few minimal donor records, one of every constituent type.
 *
 * The body uses CRLF line endings so Excel (Windows) opens it without
 * a "wrong line endings" prompt; macOS / Linux Excel handle CRLF fine.
 * UTF-8 BOM is emitted so Excel for Windows correctly detects UTF-8
 * — without it, French accents render as Latin-1 mojibake.
 */

import { CANONICAL_HEADERS } from "./parser.js";

const HEADER_ROW = [...CANONICAL_HEADERS];

/**
 * 10 example rows the issue mandates. Coverage:
 *   - All five `type` values (donor, volunteer, member, beneficiary, partner).
 *   - At least one row per major locale (FR, DE, CH, BE, GB, US, NL, IT, ES).
 *   - Mix of "complete address" and "email only" so the operator sees the optional-field pattern.
 *   - One tagged row showing comma-separated tags.
 */
const EXAMPLE_ROWS: string[][] = [
  [
    "Alice",
    "Martin",
    "alice.martin@example.fr",
    "+33 1 23 45 67 89",
    "12 rue de la Paix",
    "",
    "75002",
    "Paris",
    "FR",
    "donor",
    "vip,monthly",
  ],
  [
    "Hans",
    "Müller",
    "hans.mueller@example.de",
    "+49 30 12345678",
    "Hauptstraße 5",
    "",
    "10115",
    "Berlin",
    "DE",
    "donor",
    "newsletter",
  ],
  [
    "Jean",
    "Dupont",
    "",
    "+41 22 555 12 34",
    "Rue du Lac 7",
    "Apt 3",
    "1207",
    "Genève",
    "CH",
    "volunteer",
    "",
  ],
  [
    "Sophie",
    "Janssen",
    "sophie.janssen@example.be",
    "",
    "Grand Place 14",
    "",
    "1000",
    "Bruxelles",
    "BE",
    "member",
    "board",
  ],
  [
    "Mary",
    "Smith",
    "mary.smith@example.co.uk",
    "+44 20 7946 0958",
    "10 Downing St",
    "",
    "SW1A 2AA",
    "London",
    "GB",
    "donor",
    "",
  ],
  ["John", "Doe", "john.doe@example.com", "", "", "", "", "", "", "donor", ""],
  [
    "Anna",
    "de Vries",
    "anna.devries@example.nl",
    "",
    "Damrak 1",
    "",
    "1012 LG",
    "Amsterdam",
    "NL",
    "beneficiary",
    "",
  ],
  [
    "Marco",
    "Rossi",
    "marco.rossi@example.it",
    "+39 06 1234 5678",
    "Via Roma 42",
    "",
    "00184",
    "Roma",
    "IT",
    "partner",
    "corporate",
  ],
  [
    "Carmen",
    "García",
    "carmen.garcia@example.es",
    "",
    "Calle Mayor 3",
    "",
    "28013",
    "Madrid",
    "ES",
    "donor",
    "",
  ],
  [
    "Eva",
    "Schneider",
    "eva.schneider@example.ch",
    "+41 44 123 45 67",
    "Bahnhofstrasse 1",
    "",
    "8001",
    "Zürich",
    "CH",
    "volunteer",
    "translator,events",
  ],
];

/** RFC 4180 CSV escaping — quote any field with `,`, `"`, `\r`, or `\n`. */
function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvLine(cells: string[]): string {
  return cells.map(escapeCell).join(",");
}

/** UTF-8 BOM so Excel for Windows auto-detects the encoding. */
const BOM = "﻿";

/** Filename surfaced in the `Content-Disposition` header. */
export const TEMPLATE_FILENAME = "givernance-import-template.csv";

/** Generate the CSV body for the import template. */
export function buildImportTemplateCsv(): string {
  const lines = [toCsvLine(HEADER_ROW), ...EXAMPLE_ROWS.map((row) => toCsvLine(row))];
  return `${BOM}${lines.join("\r\n")}\r\n`;
}
