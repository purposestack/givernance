/**
 * Unit tests for the bulk-import parser. These exercise the pure
 * parser surface (no DB, no S3) so the heavy XLSX/CSV edge cases —
 * formula injection, missing headers, oversized files — fail loudly
 * here rather than down in the worker.
 */

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BulkImportParseError, MAX_BULK_IMPORT_ROWS, parseBulkImportFile } from "../parser.js";

function csv(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

async function buildXlsx(headerRow: string[], dataRows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Sheet1");
  sheet.addRow(headerRow);
  for (const r of dataRows) sheet.addRow(r);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

describe("parseBulkImportFile — CSV", () => {
  it("parses a minimal CSV with required headers", async () => {
    const file = csv(
      "firstName,lastName,email\nAlice,Martin,a@example.com\nBob,Dupont,b@example.com\n",
    );
    const result = await parseBulkImportFile(file, "text/csv", "test.csv");
    expect(result.headers).toContain("firstName");
    expect(result.headers).toContain("lastName");
    expect(result.rows).toHaveLength(2);
    const r0 = result.rows[0];
    const r1 = result.rows[1];
    if (!r0 || !r1) throw new Error("expected two rows");
    expect(r0.values.firstName).toBe("Alice");
    expect(r1.values.email).toBe("b@example.com");
  });

  it("accepts French and snake_case header aliases", async () => {
    const file = csv("Prénom,nom,courriel\nAlice,Martin,a@example.com\n");
    const result = await parseBulkImportFile(file, "text/csv", "test.csv");
    const r0 = result.rows[0];
    if (!r0) throw new Error("expected one row");
    expect(r0.values.firstName).toBe("Alice");
    expect(r0.values.lastName).toBe("Martin");
    expect(r0.values.email).toBe("a@example.com");
  });

  it("rejects a file missing firstName/lastName", async () => {
    const file = csv("email,phone\na@example.com,+33 1 23 45 67 89\n");
    await expect(parseBulkImportFile(file, "text/csv", "test.csv")).rejects.toMatchObject({
      name: "BulkImportParseError",
      code: "MISSING_REQUIRED_HEADERS",
    });
  });

  it("rejects an entirely empty file", async () => {
    const file = csv("");
    await expect(parseBulkImportFile(file, "text/csv", "test.csv")).rejects.toBeInstanceOf(
      BulkImportParseError,
    );
  });

  it("neutralises formula-prefix cells in CSV", async () => {
    // The leading `=` is the spreadsheet-injection vector; the parser
    // prefixes it with `'` so a re-export to Excel renders it as text.
    const file = csv("firstName,lastName,email\n=SUM(A1),Smith,a@example.com\n");
    const result = await parseBulkImportFile(file, "text/csv", "test.csv");
    const r0 = result.rows[0];
    if (!r0) throw new Error("expected one row");
    expect(r0.values.firstName).toBe("'=SUM(A1)");
  });

  it("strips a UTF-8 BOM before parsing the header", async () => {
    const file = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      csv("firstName,lastName\nAlice,Martin\n"),
    ]);
    const result = await parseBulkImportFile(file, "text/csv", "test.csv");
    expect(result.rows).toHaveLength(1);
    const r0 = result.rows[0];
    if (!r0) throw new Error("expected one row");
    expect(r0.values.firstName).toBe("Alice");
  });
});

describe("parseBulkImportFile — XLSX", () => {
  it("parses a one-sheet XLSX with required headers", async () => {
    const buf = await buildXlsx(
      ["firstName", "lastName", "email"],
      [
        ["Alice", "Martin", "alice@example.com"],
        ["Bob", "Dupont", "bob@example.com"],
      ],
    );
    const result = await parseBulkImportFile(
      buf,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "test.xlsx",
    );
    expect(result.rows).toHaveLength(2);
    const r0 = result.rows[0];
    const r1 = result.rows[1];
    if (!r0 || !r1) throw new Error("expected two rows");
    expect(r0.values.firstName).toBe("Alice");
    expect(r1.values.email).toBe("bob@example.com");
  });

  it("rejects formula cells with INVALID_CELL", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Sheet1");
    sheet.addRow(["firstName", "lastName", "email"]);
    const row = sheet.addRow(["Alice", "Martin", ""]);
    // ExcelJS represents a formula cell as `{ formula, result }` — the
    // parser detects this shape and surfaces INVALID_CELL.
    row.getCell(3).value = { formula: "SUM(1,2)", result: 3 } as unknown as ExcelJS.CellValue;
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    await expect(
      parseBulkImportFile(
        buf,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "test.xlsx",
      ),
    ).rejects.toMatchObject({ name: "BulkImportParseError", code: "INVALID_CELL" });
  });

  it("rejects XLSX missing required headers", async () => {
    const buf = await buildXlsx(["email", "phone"], [["a@example.com", "+33"]]);
    await expect(
      parseBulkImportFile(
        buf,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "test.xlsx",
      ),
    ).rejects.toMatchObject({ code: "MISSING_REQUIRED_HEADERS" });
  });
});

describe("parseBulkImportFile — row cap", () => {
  it("rejects a CSV exceeding the row cap", async () => {
    // Synthesize a CSV with header + (MAX + 1) rows. Using simple
    // strings keeps the buffer small enough that the cap check fires
    // before we burn memory.
    const lines = ["firstName,lastName"];
    for (let i = 0; i < MAX_BULK_IMPORT_ROWS + 1; i++) {
      lines.push(`A${i},B${i}`);
    }
    const file = csv(`${lines.join("\n")}\n`);
    await expect(parseBulkImportFile(file, "text/csv", "big.csv")).rejects.toMatchObject({
      code: "TOO_MANY_ROWS",
    });
  });
});
