/**
 * Per-row validation for bulk imports (Epic #373).
 *
 * Pure functions only — no DB, no S3. Takes a parsed row's raw cell
 * map and returns either a normalised payload ready for
 * `createConstituent(orgId, input)` or an array of `ValidationError`
 * with stable `errorCode` values the operator's CSV download can
 * surface.
 *
 * GDPR posture: the validator never logs cell values. Errors carry the
 * field name + code, not the rejected content.
 */

const CONSTITUENT_TYPES = ["donor", "volunteer", "member", "beneficiary", "partner"] as const;
type ConstituentTypeLiteral = (typeof CONSTITUENT_TYPES)[number];

// RFC-5322-lite — mirrors the constituent form's regex (see
// packages/shared validators). Local part + `@` + a host containing at
// least one dot. Trailing whitespace already stripped by the parser.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ISO 3166-1 alpha-2. The parser does NOT uppercase for us so we
// normalise here.
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

export type BulkImportValidationCode =
  | "REQUIRED_FIRST_NAME"
  | "REQUIRED_LAST_NAME"
  | "INVALID_EMAIL"
  | "INVALID_COUNTRY_CODE"
  | "INVALID_TYPE"
  | "FIELD_TOO_LONG";

export interface ValidationError {
  field: string;
  code: BulkImportValidationCode;
  message: string;
}

export interface ConstituentImportPayload {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  type?: ConstituentTypeLiteral;
  tags?: string[];
}

export type ValidationOutcome =
  | { ok: true; payload: ConstituentImportPayload }
  | { ok: false; errors: ValidationError[] };

function pushIfLong(
  errors: ValidationError[],
  field: string,
  value: string | undefined,
  max: number,
): void {
  if (value && value.length > max) {
    errors.push({
      field,
      code: "FIELD_TOO_LONG",
      message: `${field} exceeds the ${max}-character limit`,
    });
  }
}

function validateCountry(raw: string | undefined, errors: ValidationError[]): string | undefined {
  if (!raw) return undefined;
  if (!COUNTRY_CODE_RE.test(raw)) {
    errors.push({
      field: "countryCode",
      code: "INVALID_COUNTRY_CODE",
      message: "countryCode must be a 2-letter ISO 3166-1 code",
    });
    return undefined;
  }
  return raw;
}

function validateType(
  raw: string | undefined,
  errors: ValidationError[],
): ConstituentTypeLiteral | undefined {
  if (!raw) return undefined;
  if (!CONSTITUENT_TYPES.includes(raw as ConstituentTypeLiteral)) {
    errors.push({
      field: "type",
      code: "INVALID_TYPE",
      message: `type must be one of ${CONSTITUENT_TYPES.join(", ")}`,
    });
    return undefined;
  }
  return raw as ConstituentTypeLiteral;
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const split = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 64);
  return split.length > 0 ? Array.from(new Set(split)) : undefined;
}

function checkLengths(values: Record<string, string | undefined>, errors: ValidationError[]): void {
  const limits: Array<[string, number]> = [
    ["firstName", 255],
    ["lastName", 255],
    ["email", 255],
    ["phone", 50],
    ["addressLine1", 255],
    ["addressLine2", 255],
    ["postalCode", 20],
    ["city", 255],
  ];
  for (const [field, max] of limits) pushIfLong(errors, field, values[field], max);
}

/**
 * Validate a single parsed row. The shape mirrors the route-level
 * `ConstituentCreateBody` so the worker can pass the result straight
 * into `createConstituent(orgId, payload)` without further coercion.
 */
export function validateRow(values: Record<string, string>): ValidationOutcome {
  const errors: ValidationError[] = [];

  const firstName = values.firstName?.trim();
  const lastName = values.lastName?.trim();
  if (!firstName) {
    errors.push({
      field: "firstName",
      code: "REQUIRED_FIRST_NAME",
      message: "firstName is required",
    });
  }
  if (!lastName) {
    errors.push({ field: "lastName", code: "REQUIRED_LAST_NAME", message: "lastName is required" });
  }

  const email = values.email?.trim();
  if (email && !EMAIL_RE.test(email)) {
    errors.push({ field: "email", code: "INVALID_EMAIL", message: "Email format is invalid" });
  }
  const phone = values.phone?.trim();
  const addressLine1 = values.addressLine1?.trim();
  const addressLine2 = values.addressLine2?.trim();
  const postalCode = values.postalCode?.trim();
  const city = values.city?.trim();
  checkLengths(
    { firstName, lastName, email, phone, addressLine1, addressLine2, postalCode, city },
    errors,
  );

  const countryCode = validateCountry(values.countryCode?.trim().toUpperCase(), errors);
  const type = validateType(values.type?.trim().toLowerCase(), errors);
  const tags = parseTags(values.tags?.trim());

  if (errors.length > 0) return { ok: false, errors };

  // biome-ignore lint/style/noNonNullAssertion: firstName/lastName presence already enforced above
  const payload: ConstituentImportPayload = { firstName: firstName!, lastName: lastName! };
  if (email) payload.email = email;
  if (phone) payload.phone = phone;
  if (addressLine1) payload.addressLine1 = addressLine1;
  if (addressLine2) payload.addressLine2 = addressLine2;
  if (postalCode) payload.postalCode = postalCode;
  if (city) payload.city = city;
  if (countryCode) payload.countryCode = countryCode;
  if (type) payload.type = type;
  if (tags) payload.tags = tags;
  return { ok: true, payload };
}

/**
 * Address completeness predicate — mirrors the worker's
 * `complete_address_count` counter on `bulk_import_jobs`. Operator
 * KPI: "of the imported rows, how many can we mail to?".
 */
export function hasCompleteAddress(p: ConstituentImportPayload): boolean {
  return Boolean(p.addressLine1 && p.postalCode && p.city && p.countryCode);
}
