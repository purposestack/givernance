import csv from 'csv-parser';
import xlsx from 'xlsx';
import { Readable } from 'stream';
import { BadRequestError } from '../../../errors';

export interface ParsedRow {
  rowNumber: number;
  data: Record<string, string>;
}

const REQUIRED_HEADERS = ['firstName', 'lastName'];
const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

export async function parseFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ParsedRow[]> {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new BadRequestError(`Invalid file type: ${mimeType}. Allowed: CSV, XLS, XLSX.`);
  }

  if (mimeType === 'text/csv') {
    return parseCSV(buffer);
  } else {
    return parseExcel(buffer);
  }
}

function parseCSV(buffer: Buffer): Promise<ParsedRow[]> {
  return new Promise((resolve, reject) => {
    const results: ParsedRow[] = [];
    const stream = Readable.from(buffer.toString());
    
    stream
      .pipe(csv())
      .on('data', (data: Record<string, string>, index: number) => {
        // Validate headers on first row
        if (results.length === 0) {
          const headers = Object.keys(data);
          const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
          if (missing.length > 0) {
            return reject(new BadRequestError(`Missing required columns: ${missing.join(', ')}`));
          }
        }
        results.push({ rowNumber: results.length + 1, data });
      })
      .on('end', () => resolve(results))
      .on('error', (err: Error) => reject(new BadRequestError(`CSV Parse Error: ${err.message}`)));
  });
}

function parseExcel(buffer: Buffer): ParsedRow[] {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonData = xlsx.utils.sheet_to_json<Record<string, string>>(sheet);

  if (jsonData.length === 0) return [];

  const headers = Object.keys(jsonData[0]);
  const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
  if (missing.length > 0) {
    throw new BadRequestError(`Missing required columns: ${missing.join(', ')}`);
  }

  return jsonData.map((row, index) => ({
    rowNumber: index + 1,
    data: row
  }));
}
