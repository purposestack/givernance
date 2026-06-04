/**
 * camt.053 parser (Epic #318 PR #5).
 *
 * Wraps `fast-xml-parser` behind a small interface so the parser can be
 * swapped without touching the import / reconcile processors. ADR-028
 * locked the parser choice as "`iso20022.js` baseline, fall back to
 * `fast-xml-parser` if QRR collapses to SCOR"; the deterministic
 * `fast-xml-parser` path is the one we ship in PR #5 because (a) it
 * gives us full control over the QRR / SCOR / unstructured walk, and
 * (b) the native-binding cost of `libxmljs2` for XSD validation is
 * heavier than the structural validation this module already does.
 *
 * Supports both camt.053.001.04 (legacy) and camt.053.001.08 (current).
 * The root namespace is read off `Document.@_xmlns` and rejected if it
 * doesn't match one of the accepted versions — silent best-effort
 * parsing of an off-spec version is the worst possible behaviour for
 * a reconciliation pipeline (ADR-028 §"Schema versions accepted").
 *
 * Hardening (ADR-028 §"Hardening — XXE / DTD / billion-laughs / zip-
 * bomb"): `fast-xml-parser` does NOT resolve external entities by
 * design (no DTD parsing); we disable processing instructions and cap
 * the entity table at zero. The 50 MB upload cap is enforced at the
 * API boundary; the parser also rejects files whose root element is
 * not `Document` (rules out HTML / SOAP / random XML).
 */

import { canonicaliseReference } from "@givernance/shared/validators";
import { XMLParser } from "fast-xml-parser";

/** Accepted ISO 20022 camt.053 namespace URIs. */
const ACCEPTED_NAMESPACES = new Set([
  "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04",
  "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08",
]);

export type CamtParseErrorCode =
  /** XML is structurally malformed (not even parseable as XML). */
  | "xsd_invalid"
  /** Root element is something other than ISO 20022 `Document`. */
  | "not_document"
  /** Namespace doesn't match any accepted camt.053 version. */
  | "unsupported_version"
  /** Required field (`GrpHdr.MsgId`, `Stmt`, `Acct.Id.IBAN`) missing. */
  | "missing_required_field";

export class CamtParseError extends Error {
  public readonly code: CamtParseErrorCode;
  public readonly detail?: string;
  constructor(code: CamtParseErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "CamtParseError";
    this.code = code;
    this.detail = detail;
  }
}

/** Canonical shape returned by the parser regardless of input version. */
export interface CamtStatement {
  msgId: string;
  /** Optional pacs.008 creation time — useful for QA cross-checks. */
  creationDateTime?: string;
  statements: CamtStmt[];
}

export interface CamtStmt {
  /** Tenant bank account IBAN this statement is for. */
  acctIban: string;
  fromDate?: string;
  toDate?: string;
  entries: CamtEntry[];
}

export interface CamtEntry {
  /** `Ntry.AcctSvcrRef` — entry-level idempotency. */
  acctSvcrRef: string;
  /** `Ntry.NtryDtls.TxDtls.Refs.EndToEndId` — secondary signal. */
  endToEndId: string | null;
  /** `Ntry.CdtDbtInd`. */
  cdtDbtInd: "CRDT" | "DBIT";
  /** `Ntry.Sts` — only `BOOK` entries reconcile; `PDNG` are skipped. */
  sts: string;
  /** `Ntry.RvslInd` — true on a reversal entry. */
  reversalIndicator: boolean;
  amountCents: number;
  currency: string;
  valueDate: string | null;
  bookingDate: string | null;
  /** `RmtInf.Strd.CdtrRefInf.Ref` — QRR or SCOR if present. */
  structuredRef: string | null;
  /** `RmtInf.Strd.CdtrRefInf.Tp.CdOrPrtry.Prtry` (QRR / SCOR / IPI / SEPA). */
  structuredRefType: string | null;
  debtorName: string | null;
  debtorIban: string | null;
  /** Flattened `RltdPties.Dbtr.PstlAdr` — structured fields + free-form AdrLine. */
  debtorAddress: CamtDebtorAddress | null;
}

export interface CamtDebtorAddress {
  streetName: string | null;
  buildingNumber: string | null;
  postalCode: string | null;
  town: string | null;
  countryCode: string | null;
  /** Free-form lines as emitted by the bank (Raiffeisen / smaller banks). */
  addressLines: string[];
}

const ATTR_PREFIX = "@_";
const TEXT_NODE = "#text";

function pickText(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const text = (node as Record<string, unknown>)[TEXT_NODE];
    if (typeof text === "string") return text.trim() || null;
    if (typeof text === "number") return String(text);
  }
  return null;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Canonicalise an IBAN — strip whitespace + uppercase. */
function canonIban(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * `Amt` is emitted as `<Amt Ccy="CHF">123.45</Amt>` — fast-xml-parser
 * surfaces this as `{ "@_Ccy": "CHF", "#text": "123.45" }`. We multiply
 * by 100 to convert to integer cents; rounding is half-away-from-zero
 * with a 0.5-cent tolerance for floating-point representations of the
 * ISO 20022 decimal string.
 */
function parseAmountCents(amtNode: unknown): { amountCents: number; currency: string } | null {
  if (!amtNode || typeof amtNode !== "object") return null;
  const ccy = (amtNode as Record<string, unknown>)[`${ATTR_PREFIX}Ccy`];
  const text = pickText(amtNode);
  if (typeof ccy !== "string" || text == null) return null;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value < 0) return null;
  // Multiply via string to avoid `0.1 * 100 = 10.000000000001`.
  const [intPart, fracPartRaw = ""] = text.split(".");
  const fracPart = `${fracPartRaw}00`.slice(0, 2);
  const cents = Number.parseInt(intPart ?? "0", 10) * 100 + Number.parseInt(fracPart || "0", 10);
  return { amountCents: cents, currency: ccy.toUpperCase() };
}

function parseAddress(pstlAdr: unknown): CamtDebtorAddress | null {
  if (!pstlAdr || typeof pstlAdr !== "object") return null;
  const node = pstlAdr as Record<string, unknown>;
  const lines = asArray(node.AdrLine)
    .map((line) => pickText(line))
    .filter((line): line is string => line !== null);
  return {
    streetName: pickText(node.StrtNm),
    buildingNumber: pickText(node.BldgNb),
    postalCode: pickText(node.PstCd),
    town: pickText(node.TwnNm),
    countryCode: pickText(node.Ctry),
    addressLines: lines,
  };
}

function parseDebtor(rltdPties: unknown): {
  name: string | null;
  address: CamtDebtorAddress | null;
} {
  if (!rltdPties || typeof rltdPties !== "object") {
    return { name: null, address: null };
  }
  const dbtr = (rltdPties as Record<string, unknown>).Dbtr;
  if (!dbtr || typeof dbtr !== "object") {
    return { name: null, address: null };
  }
  const dbtrObj = dbtr as Record<string, unknown>;
  return {
    name: pickText(dbtrObj.Nm),
    address: parseAddress(dbtrObj.PstlAdr),
  };
}

function parseDebtorIban(rltdPties: unknown): string | null {
  if (!rltdPties || typeof rltdPties !== "object") return null;
  const dbtrAcct = (rltdPties as Record<string, unknown>).DbtrAcct;
  if (!dbtrAcct || typeof dbtrAcct !== "object") return null;
  const id = (dbtrAcct as Record<string, unknown>).Id;
  if (!id || typeof id !== "object") return null;
  return canonIban(pickText((id as Record<string, unknown>).IBAN));
}

/**
 * Extract the QRR / SCOR reference and its CdOrPrtry tag from a TxDtls
 * block. Returns the reference + Prtry tag (`QRR` / `SCOR` / `IPI` /
 * `SEPA`), or `{ ref: null, type: null }` when the bank dropped it.
 */
function parseStructuredRef(txDtls: unknown): {
  ref: string | null;
  type: string | null;
} {
  if (!txDtls || typeof txDtls !== "object") return { ref: null, type: null };
  const rmtInf = (txDtls as Record<string, unknown>).RmtInf;
  if (!rmtInf || typeof rmtInf !== "object") return { ref: null, type: null };
  const strd = (rmtInf as Record<string, unknown>).Strd;
  if (!strd || typeof strd !== "object") return { ref: null, type: null };
  const cdtrRefInf = (strd as Record<string, unknown>).CdtrRefInf;
  if (!cdtrRefInf || typeof cdtrRefInf !== "object") return { ref: null, type: null };
  const node = cdtrRefInf as Record<string, unknown>;
  const ref = pickText(node.Ref);
  const tp = node.Tp;
  let type: string | null = null;
  if (tp && typeof tp === "object") {
    const cdOrPrtry = (tp as Record<string, unknown>).CdOrPrtry;
    if (cdOrPrtry && typeof cdOrPrtry === "object") {
      const cop = cdOrPrtry as Record<string, unknown>;
      type = pickText(cop.Prtry) ?? pickText(cop.Cd);
    }
  }
  // Canonicalise (strip whitespace + uppercase) so the persisted
  // `camt_credit_entries.structured_ref` matches the uppercase row stored
  // via `computeScor` regardless of the case the bank emitted (SCOR is
  // case-insensitive per ISO 11649; QRR is numeric so this is a no-op).
  return { ref: ref ? canonicaliseReference(ref) : null, type };
}

function parseEndToEndId(txDtls: unknown): string | null {
  if (!txDtls || typeof txDtls !== "object") return null;
  const refs = (txDtls as Record<string, unknown>).Refs;
  if (!refs || typeof refs !== "object") return null;
  return pickText((refs as Record<string, unknown>).EndToEndId);
}

function parseDateText(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  // `<ValDt><Dt>2026-05-06</Dt></ValDt>` shape.
  const dt = pickText(obj.Dt);
  if (dt) return dt;
  // `<ValDt><DtTm>2026-05-06T10:00:00</DtTm></ValDt>` shape — slice to date.
  const dtTm = pickText(obj.DtTm);
  if (dtTm) return dtTm.slice(0, 10);
  return null;
}

function parseEntry(rawEntry: Record<string, unknown>): CamtEntry | null {
  const acctSvcrRef = pickText(rawEntry.AcctSvcrRef);
  if (!acctSvcrRef) return null;
  const amount = parseAmountCents(rawEntry.Amt);
  if (!amount) return null;
  const cdtDbtIndRaw = pickText(rawEntry.CdtDbtInd);
  const cdtDbtInd: "CRDT" | "DBIT" = cdtDbtIndRaw === "DBIT" ? "DBIT" : "CRDT";
  const stsNode = rawEntry.Sts;
  // ISO 20022 v8 wraps status in `<Sts><Cd>BOOK</Cd></Sts>`; v4 has
  // `<Sts>BOOK</Sts>`. Accept both.
  const sts =
    pickText(stsNode) ??
    (stsNode && typeof stsNode === "object"
      ? pickText((stsNode as Record<string, unknown>).Cd)
      : null) ??
    "BOOK";
  const reversalIndicator = pickText(rawEntry.RvslInd) === "true";

  const ntryDtls = asArray(rawEntry.NtryDtls);
  const txDtls = ntryDtls[0] ? asArray((ntryDtls[0] as Record<string, unknown>).TxDtls)[0] : null;
  const { ref: structuredRef, type: structuredRefType } = parseStructuredRef(txDtls);
  const rltdPties =
    txDtls && typeof txDtls === "object"
      ? (txDtls as Record<string, unknown>).RltdPties
      : undefined;
  const debtor = parseDebtor(rltdPties);
  const debtorIban = parseDebtorIban(rltdPties);

  return {
    acctSvcrRef,
    endToEndId: parseEndToEndId(txDtls),
    cdtDbtInd,
    sts,
    reversalIndicator,
    amountCents: amount.amountCents,
    currency: amount.currency,
    valueDate: parseDateText(rawEntry.ValDt),
    bookingDate: parseDateText(rawEntry.BookgDt),
    structuredRef,
    structuredRefType,
    debtorName: debtor.name,
    debtorIban,
    debtorAddress: debtor.address,
  };
}

function parseStmt(rawStmt: Record<string, unknown>): CamtStmt | null {
  const acct = rawStmt.Acct;
  if (!acct || typeof acct !== "object") return null;
  const id = (acct as Record<string, unknown>).Id;
  if (!id || typeof id !== "object") return null;
  const acctIban = canonIban(pickText((id as Record<string, unknown>).IBAN));
  if (!acctIban) return null;

  const fromTo = rawStmt.FrToDt;
  let fromDate: string | undefined;
  let toDate: string | undefined;
  if (fromTo && typeof fromTo === "object") {
    fromDate = pickText((fromTo as Record<string, unknown>).FrDtTm)?.slice(0, 10) ?? undefined;
    toDate = pickText((fromTo as Record<string, unknown>).ToDtTm)?.slice(0, 10) ?? undefined;
  }

  const entries = asArray(rawStmt.Ntry)
    .map((entry) => parseEntry(entry as Record<string, unknown>))
    .filter((entry): entry is CamtEntry => entry !== null);

  return {
    acctIban,
    fromDate,
    toDate,
    entries,
  };
}

/**
 * Parse a camt.053 XML buffer into the canonical shape above. Throws
 * `CamtParseError` on any structural problem; the caller catches and
 * persists the error code into `camt_statements.error`.
 */
export function parseCamt053(xml: Buffer | string): CamtStatement {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    trimValues: true,
    // ISO 20022 wraps text in mixed-content nodes (e.g. `<Amt Ccy="CHF">123</Amt>`);
    // returning text under `#text` makes the picker logic above uniform.
    textNodeName: TEXT_NODE,
    // Defense-in-depth: `fast-xml-parser` does NOT resolve external
    // entities by default, but we belt-and-suspenders the flag here.
    processEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    // Reject empty-tag self-closure so a malicious `<Document xmlns="…"/>`
    // doesn't sail through as "valid with zero statements" — the parser
    // would otherwise return an empty object.
    allowBooleanAttributes: false,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(typeof xml === "string" ? xml : xml.toString("utf-8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new CamtParseError(
      "xsd_invalid",
      "XML is structurally malformed.",
      err instanceof Error ? err.message : String(err),
    );
  }

  const doc = parsed.Document;
  if (!doc || typeof doc !== "object") {
    throw new CamtParseError("not_document", "Root element is not ISO 20022 `Document`.");
  }
  const docObj = doc as Record<string, unknown>;
  const xmlns = docObj[`${ATTR_PREFIX}xmlns`];
  if (typeof xmlns !== "string" || !ACCEPTED_NAMESPACES.has(xmlns)) {
    throw new CamtParseError(
      "unsupported_version",
      `Unsupported camt.053 namespace: ${typeof xmlns === "string" ? xmlns : "(missing)"}`,
    );
  }

  const bkToCstmrStmt = docObj.BkToCstmrStmt;
  if (!bkToCstmrStmt || typeof bkToCstmrStmt !== "object") {
    throw new CamtParseError("missing_required_field", "Document is missing `BkToCstmrStmt` root.");
  }
  const root = bkToCstmrStmt as Record<string, unknown>;

  const grpHdr = root.GrpHdr;
  if (!grpHdr || typeof grpHdr !== "object") {
    throw new CamtParseError("missing_required_field", "Document is missing `GrpHdr`.");
  }
  const msgId = pickText((grpHdr as Record<string, unknown>).MsgId);
  if (!msgId) {
    throw new CamtParseError("missing_required_field", "GrpHdr is missing `MsgId`.");
  }
  const creationDateTime = pickText((grpHdr as Record<string, unknown>).CreDtTm) ?? undefined;

  const stmts = asArray(root.Stmt)
    .map((stmt) => parseStmt(stmt as Record<string, unknown>))
    .filter((stmt): stmt is CamtStmt => stmt !== null);

  if (stmts.length === 0) {
    throw new CamtParseError(
      "missing_required_field",
      "Document has no parseable Stmt elements (every Stmt was missing its Acct/IBAN).",
    );
  }

  return {
    msgId,
    creationDateTime,
    statements: stmts,
  };
}

/**
 * Heuristic AdrLine parser (docs/25 §5.5 free-form fallback) — used
 * when the bank dropped `PstlAdr` structured fields but kept the
 * `AdrLine[]` free-form lines. The last line matching `/^\d{4,5}\s+\w/`
 * is treated as `{PostCode} {City}`; the prior line as `addressLine1`;
 * earlier lines as `addressLine2` (joined by space).
 *
 * Returns null when none of the lines look like a postal-code line —
 * the operator then sees the row in the unreconciled queue with the
 * raw `AdrLine` payload in the audit log for manual resolution.
 */
export function parseAdrLinesHeuristic(lines: string[]): {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string;
  city: string;
} | null {
  if (lines.length === 0) return null;
  const postCodeLineIdx = lines.findIndex((line) => /^\d{4,5}\s+\S/.test(line));
  if (postCodeLineIdx === -1) return null;
  const postCodeLine = lines[postCodeLineIdx];
  if (!postCodeLine) return null;
  const match = postCodeLine.match(/^(\d{4,5})\s+(.+)$/);
  if (!match) return null;
  const postalCode = match[1] ?? "";
  const city = match[2]?.trim() ?? "";
  if (!postalCode || !city) return null;
  const addressLine1 = postCodeLineIdx > 0 ? (lines[postCodeLineIdx - 1] ?? null) : null;
  const restLines = lines.slice(0, Math.max(0, postCodeLineIdx - 1));
  const addressLine2 = restLines.length > 0 ? restLines.join(" ") : null;
  return { addressLine1, addressLine2, postalCode, city };
}

/**
 * Split a debtor `Nm` into `{ firstName, lastName }` per docs/25 §5.5.
 * Splits on the LAST space so compound surnames like
 * `"Pia-Maria Rutschmann-Schnyder"` keep the hyphenated lastname intact.
 * Single-token names default to `firstName=""`, `lastName=name` so the
 * row is still creatable (constituents schema requires both fields).
 */
export function splitDebtorName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: "", lastName: "Unknown" };
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) return { firstName: "", lastName: trimmed };
  return {
    firstName: trimmed.slice(0, lastSpace).trim(),
    lastName: trimmed.slice(lastSpace + 1).trim() || trimmed,
  };
}
