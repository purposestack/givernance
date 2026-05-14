import { ParsedRow } from './parser';

export interface ValidationError {
  rowNumber: number;
  errorCode: string;
  errorMessage: string;
}

export function validateRow(row: ParsedRow): ValidationError | null {
  const { data, rowNumber } = row;

  // Required fields
  if (!data.firstName || data.firstName.trim().length === 0) {
    return { rowNumber, errorCode: 'MISSING_REQUIRED', errorMessage: 'Missing required field: firstName' };
  }
  if (!data.lastName || data.lastName.trim().length === 0) {
    return { rowNumber, errorCode: 'MISSING_REQUIRED', errorMessage: 'Missing required field: lastName' };
  }

  // Email format
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return { rowNumber, errorCode: 'INVALID_EMAIL', errorMessage: `Invalid email format: ${data.email}` };
  }

  // Country Code
  if (data.countryCode && !/^[A-Z]{2}$/.test(data.countryCode)) {
    return { rowNumber, errorCode: 'INVALID_COUNTRY', errorMessage: `Invalid country code: ${data.countryCode}` };
  }

  // Type
  const validTypes = ['donor', 'volunteer', 'member', 'beneficiary', 'partner'];
  if (data.type && !validTypes.includes(data.type)) {
    return { rowNumber, errorCode: 'INVALID_TYPE', errorMessage: `Invalid constituent type: ${data.type}` };
  }

  return null;
}

export function validateRows(rows: ParsedRow[]): { valid: ParsedRow[], errors: ValidationError[] } {
  const valid: ParsedRow[] = [];
  const errors: ValidationError[] = [];

  for (const row of rows) {
    const error = validateRow(row);
    if (error) {
      errors.push(error);
    } else {
      valid.push(row);
    }
  }

  return { valid, errors };
}
