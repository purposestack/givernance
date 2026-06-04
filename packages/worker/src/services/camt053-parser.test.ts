/**
 * Unit tests for the camt.053 parser (Epic #318 PR #5).
 *
 * Focus on the pure-function surface: structural validation, namespace
 * rejection, debtor extraction, AdrLine heuristic, name splitting. The
 * round-trip through the worker (S3 fetch + DB write) is covered by the
 * integration tests under `tests/integration/`.
 */

import { describe, expect, it } from "vitest";
import {
  CamtParseError,
  parseAdrLinesHeuristic,
  parseCamt053,
  splitDebtorName,
} from "./camt053-parser.js";

describe("parseCamt053 — happy path", () => {
  it("parses a v8 statement with QRR + structured debtor address", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-001</MsgId></GrpHdr>
    <Stmt>
      <Acct><Id><IBAN>CH9300762011623852957</IBAN></Id></Acct>
      <Ntry>
        <AcctSvcrRef>REF-A</AcctSvcrRef>
        <Amt Ccy="CHF">123.45</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <ValDt><Dt>2026-05-11</Dt></ValDt>
        <NtryDtls>
          <TxDtls>
            <RmtInf>
              <Strd>
                <CdtrRefInf>
                  <Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp>
                  <Ref>210000000003139471430009017</Ref>
                </CdtrRefInf>
              </Strd>
            </RmtInf>
            <RltdPties>
              <Dbtr>
                <Nm>Jean Dupont</Nm>
                <PstlAdr>
                  <StrtNm>Rue de la Paix</StrtNm>
                  <BldgNb>12</BldgNb>
                  <PstCd>1003</PstCd>
                  <TwnNm>Lausanne</TwnNm>
                  <Ctry>CH</Ctry>
                </PstlAdr>
              </Dbtr>
              <DbtrAcct><Id><IBAN>CH5604835012345678009</IBAN></Id></DbtrAcct>
            </RltdPties>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
    const parsed = parseCamt053(xml);
    expect(parsed.msgId).toBe("MSG-001");
    expect(parsed.statements).toHaveLength(1);
    const stmt = parsed.statements[0]!;
    expect(stmt.acctIban).toBe("CH9300762011623852957");
    expect(stmt.entries).toHaveLength(1);
    const entry = stmt.entries[0]!;
    expect(entry.acctSvcrRef).toBe("REF-A");
    expect(entry.amountCents).toBe(12345);
    expect(entry.currency).toBe("CHF");
    expect(entry.cdtDbtInd).toBe("CRDT");
    expect(entry.sts).toBe("BOOK");
    expect(entry.reversalIndicator).toBe(false);
    expect(entry.structuredRef).toBe("210000000003139471430009017");
    expect(entry.structuredRefType).toBe("QRR");
    expect(entry.debtorName).toBe("Jean Dupont");
    expect(entry.debtorIban).toBe("CH5604835012345678009");
    expect(entry.debtorAddress).toEqual({
      streetName: "Rue de la Paix",
      buildingNumber: "12",
      postalCode: "1003",
      town: "Lausanne",
      countryCode: "CH",
      addressLines: [],
    });
  });

  it("canonicalises a SCOR reference — uppercases + strips whitespace", () => {
    // SCOR (ISO 11649 RF) is case-insensitive; a bank may emit it lower/
    // mixed-case and/or space-grouped. The parser must canonicalise to
    // the uppercase, no-whitespace form so it matches the row stored via
    // `computeScor` (which is always uppercase). Otherwise a valid,
    // known reference is wrongly routed to the unreconciled queue.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-SCOR</MsgId></GrpHdr>
    <Stmt>
      <Acct><Id><IBAN>CH9300762011623852957</IBAN></Id></Acct>
      <Ntry>
        <AcctSvcrRef>REF-SCOR</AcctSvcrRef>
        <Amt Ccy="CHF">50.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <ValDt><Dt>2026-05-11</Dt></ValDt>
        <NtryDtls>
          <TxDtls>
            <RmtInf>
              <Strd>
                <CdtrRefInf>
                  <Tp><CdOrPrtry><Prtry>SCOR</Prtry></CdOrPrtry></Tp>
                  <Ref>rf18 5390 0754 7034</Ref>
                </CdtrRefInf>
              </Strd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
    const entry = parseCamt053(xml).statements[0]!.entries[0]!;
    expect(entry.structuredRef).toBe("RF18539007547034");
    expect(entry.structuredRefType).toBe("SCOR");
  });

  it("amounts with no decimal place still parse as cents", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>M</MsgId></GrpHdr>
    <Stmt>
      <Acct><Id><IBAN>CH9300762011623852957</IBAN></Id></Acct>
      <Ntry>
        <AcctSvcrRef>X</AcctSvcrRef>
        <Amt Ccy="CHF">100</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
    const parsed = parseCamt053(xml);
    expect(parsed.statements[0]!.entries[0]!.amountCents).toBe(10000);
  });
});

describe("parseCamt053 — rejection paths", () => {
  it("rejects malformed XML", () => {
    expect(() => parseCamt053("<not<xml>")).toThrow(CamtParseError);
  });

  it("rejects an unsupported namespace", () => {
    const xml = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt><GrpHdr><MsgId>x</MsgId></GrpHdr></BkToCstmrStmt>
</Document>`;
    expect(() => parseCamt053(xml)).toThrow(/unsupported camt.053 namespace/i);
  });

  it("rejects a non-Document root", () => {
    expect(() => parseCamt053("<Other></Other>")).toThrow(/not ISO 20022/i);
  });

  it("rejects a statement missing IBAN", () => {
    const xml = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>x</MsgId></GrpHdr>
    <Stmt><Acct><Id><Othr>BAD</Othr></Id></Acct></Stmt>
  </BkToCstmrStmt>
</Document>`;
    expect(() => parseCamt053(xml)).toThrow(/no parseable Stmt/i);
  });
});

describe("parseAdrLinesHeuristic", () => {
  it("extracts {postalCode, city} from a 2-line CH address", () => {
    const out = parseAdrLinesHeuristic(["Rue de la Paix 12", "1003 Lausanne"]);
    expect(out).toEqual({
      addressLine1: "Rue de la Paix 12",
      addressLine2: null,
      postalCode: "1003",
      city: "Lausanne",
    });
  });

  it("handles 3-line addresses with extra leading line", () => {
    const out = parseAdrLinesHeuristic(["c/o Office Suite", "Bahnhofstrasse 5", "8001 Zurich"]);
    expect(out).toEqual({
      addressLine1: "Bahnhofstrasse 5",
      addressLine2: "c/o Office Suite",
      postalCode: "8001",
      city: "Zurich",
    });
  });

  it("returns null when no postal-code line is found", () => {
    expect(parseAdrLinesHeuristic(["Just a name"])).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseAdrLinesHeuristic([])).toBeNull();
  });
});

describe("splitDebtorName", () => {
  it("splits 'Jean Dupont' last-space first/last", () => {
    expect(splitDebtorName("Jean Dupont")).toEqual({ firstName: "Jean", lastName: "Dupont" });
  });

  it("preserves compound surnames", () => {
    expect(splitDebtorName("Pia-Maria Rutschmann-Schnyder")).toEqual({
      firstName: "Pia-Maria",
      lastName: "Rutschmann-Schnyder",
    });
  });

  it("falls back to lastName-only for single-token names", () => {
    expect(splitDebtorName("TWINT")).toEqual({ firstName: "", lastName: "TWINT" });
  });

  it("never returns empty lastName", () => {
    expect(splitDebtorName("")).toEqual({ firstName: "", lastName: "Unknown" });
  });
});
