/**
 * ADR-025 golden-fixture parity guard — `postal-pdf.ts` (API preview path)
 * vs `packages/worker/src/services/campaign-pdf.ts` (bulk export path).
 *
 * The two renderers are a deliberate **lockstep duplicate** (ADR-025:
 * PDFKit is Node-only so it can't live in `@givernance/shared` per
 * ADR-013, and worker must never import api). The invariant they must
 * uphold: for the same input, the preview the operator approves and the
 * letter the print shop receives are **byte-equivalent**. This test is
 * the CI guard the ADR deferred to a follow-up (issue #289): it renders
 * a frozen fixture through BOTH files and asserts hash-equality after
 * stripping the only legitimately-varying bytes (timestamps).
 *
 * ── How the worker renderer is imported ────────────────────────────────
 * A static `import "../../../../worker/src/…"` fails `tsc --noEmit` with
 * TS6059 (file outside this package's rootDir) — the package boundary is
 * intentional and we don't want to weaken it for one test. Instead the
 * worker module is loaded with a **dynamic import whose specifier is
 * computed at runtime**: tsc can't statically resolve it (so typecheck
 * stays clean and the api build never gains a worker dependency), while
 * vitest resolves and transforms it like any other TS module. The import
 * direction here is api(test) → worker, chosen on purpose: ADR-025's
 * hard rule is that **worker never imports api**, and this file keeps
 * that direction untouched even in dev.
 *
 * If this test fails: someone edited one renderer without its lockstep
 * counterpart. Apply the same change to the other file — do NOT weaken
 * the canonicalisation below to make it pass. Legitimate exceptions
 * (deliberate divergence) require updating ADR-025 first.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type PostalLetterRenderInput, renderPostalLetterToBuffer } from "./postal-pdf.js";

// ── Worker renderer, loaded across the package boundary (see header) ──
type WorkerModule = {
  createCampaignLetterPdfStream: (data: PostalLetterRenderInput) => Promise<NodeJS.ReadableStream>;
};

async function loadWorkerRenderer(): Promise<WorkerModule> {
  // Computed specifier — invisible to tsc, resolved by vitest at runtime.
  const specifier = new URL("../../../../worker/src/services/campaign-pdf.ts", import.meta.url)
    .pathname;
  return (await import(/* @vite-ignore */ specifier)) as WorkerModule;
}

/** Drain a PDFKit stream into a Buffer. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Canonicalise a PDF for comparison: replace the only bytes that
 * legitimately differ between two renders of the same input.
 *
 *   - `/CreationDate (D:…)` and `/ModDate (D:…)` — wall-clock stamps
 *     PDFKit writes into the Info dictionary. The D:YYYYMMDDHHmmssZ
 *     payload is fixed-width, so replacing it never shifts xref offsets.
 *   - `/ID [<…> <…>]` — file identifiers (salted hashes). PDFKit does
 *     not emit them today; the replacement is future-proofing so a
 *     PDFKit upgrade that adds them doesn't produce spurious failures.
 *
 * Deliberately NOT stripped: stream contents, object numbers, xref
 * offsets. Both renders happen in the same process with the same PDFKit
 * + zlib, so any difference there is a REAL layout drift — exactly what
 * this guard exists to catch.
 */
function canonicalisePdf(buffer: Buffer): Buffer {
  const text = buffer.toString("latin1");
  const canonical = text
    .replace(/\/CreationDate \(D:\d{14}Z\)/g, "/CreationDate (D:00000000000000Z)")
    .replace(/\/ModDate \(D:\d{14}Z\)/g, "/ModDate (D:00000000000000Z)")
    .replace(/\/ID \[<[0-9a-fA-F]+> <[0-9a-fA-F]+>\]/g, "/ID [<0> <0>]");
  return Buffer.from(canonical, "latin1");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 1×1 opaque PNG (89 bytes) — a valid `pdf-letterhead`-shaped input for
 * `doc.image()` without binding the fixture to the sharp pipeline.
 */
const LOGO_PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Frozen fixture inputs (issue #289: organisationName, campaignName,
 * recipient, logoBuffer + the copy-path variants). Every branch of the
 * shared layout is represented:
 *   - named recipient with full address + logo + description (fr)
 *   - door-drop (recipient null), no logo, no description → fallback
 *     copy path (en)
 *   - cross-border recipient → country-name line in the address block
 */
const FIXTURES: Array<{ name: string; input: PostalLetterRenderInput }> = [
  {
    name: "named recipient + logo + description (fr)",
    input: {
      organisationName: "Les Restos du Cœur de Test",
      logoBuffer: LOGO_PNG_1PX,
      organisationMission: "Nourrir et accompagner les personnes démunies.",
      campaignName: "Campagne d'hiver 2026",
      campaignDescription:
        "Cet hiver, chaque don compte : un repas chaud, un accueil, un accompagnement " +
        "vers l'insertion. Votre générosité fait la différence pour des milliers de familles.",
      recipient: {
        firstName: "Jean",
        lastName: "Dupont",
        email: "jean.dupont@example.org",
        addressLine1: "12 rue de la République",
        addressLine2: "Bâtiment B",
        postalCode: "69001",
        city: "Lyon",
        countryCode: "FR",
      },
      qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000001?qr=tok-parity",
      qrReference: "parity-qr-token-1",
      locale: "fr",
    },
  },
  {
    name: "door-drop, no logo, no description — fallback copy (en)",
    input: {
      organisationName: "Test Relief Fund",
      logoBuffer: null,
      organisationMission: null,
      campaignName: "Emergency appeal 2026",
      campaignDescription: null,
      recipient: null,
      qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000002?qr=tok-doordrop",
      qrReference: "parity-qr-token-2",
      locale: "en",
    },
  },
  {
    name: "cross-border recipient — country line rendered (fr)",
    input: {
      organisationName: "Fondation Test Suisse",
      logoBuffer: null,
      organisationMission: "Agir au-delà des frontières.",
      campaignName: "Appel transfrontalier",
      campaignDescription: "Un projet des deux côtés de la frontière.",
      recipient: {
        firstName: "Anna",
        lastName: "Muster",
        email: null,
        addressLine1: "Bahnhofstrasse 1",
        addressLine2: null,
        postalCode: "8001",
        city: "Zürich",
        countryCode: "CH",
      },
      qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000003?qr=tok-ch",
      qrReference: "parity-qr-token-3",
      locale: "fr",
    },
  },
];

describe("ADR-025 parity — postal-pdf.ts (api) ↔ campaign-pdf.ts (worker)", () => {
  for (const { name, input } of FIXTURES) {
    it(`renders byte-equivalent output: ${name}`, async () => {
      const { createCampaignLetterPdfStream } = await loadWorkerRenderer();

      const apiBuffer = await renderPostalLetterToBuffer(input);
      const workerBuffer = await streamToBuffer(await createCampaignLetterPdfStream(input));

      // Sanity: both paths produced a real PDF (guards against a refactor
      // turning one path into an empty stream, which would trivially
      // "hash-match" a similarly broken counterpart in a weaker assertion).
      expect(apiBuffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
      expect(workerBuffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
      expect(apiBuffer.length).toBeGreaterThan(1_000);

      const apiHash = sha256(canonicalisePdf(apiBuffer));
      const workerHash = sha256(canonicalisePdf(workerBuffer));

      // Hash-equality (not Buffer-equality) so a failure prints two short
      // hex strings instead of a multi-hundred-KB binary diff.
      expect(
        apiHash,
        "Lockstep drift between packages/api/src/modules/campaigns/postal-pdf.ts and " +
          "packages/worker/src/services/campaign-pdf.ts — the preview the operator " +
          "approves no longer matches the bulk export the print shop receives. " +
          "Apply your layout change to BOTH files (ADR-025).",
      ).toBe(workerHash);
    });
  }

  it("canonicalisation only masks timestamps — a real layout drift still fails", async () => {
    // Self-test of the guard itself: render the SAME input twice through the
    // API path with one character of copy changed. If canonicalisePdf were
    // over-broad (e.g. stripping whole content streams), these two would
    // wrongly hash-match and the parity suite would be asserting nothing.
    const base = FIXTURES[0]?.input;
    expect(base).toBeDefined();
    if (!base) return;

    const original = await renderPostalLetterToBuffer(base);
    const drifted = await renderPostalLetterToBuffer({
      ...base,
      campaignName: `${base.campaignName}!`,
    });

    expect(sha256(canonicalisePdf(original))).not.toBe(sha256(canonicalisePdf(drifted)));
  });

  it("two same-input renders through the same path are byte-identical after canonicalisation", async () => {
    // Determinism check: proves the ONLY varying bytes across renders are
    // the timestamps the canonicaliser masks. If PDFKit ever introduces a
    // salt (e.g. /ID generation), this fails first and points at the
    // canonicaliser rather than at a phantom lockstep drift.
    const input = FIXTURES[0]?.input;
    expect(input).toBeDefined();
    if (!input) return;

    const first = await renderPostalLetterToBuffer(input);
    const second = await renderPostalLetterToBuffer(input);

    expect(sha256(canonicalisePdf(first))).toBe(sha256(canonicalisePdf(second)));
  });
});
