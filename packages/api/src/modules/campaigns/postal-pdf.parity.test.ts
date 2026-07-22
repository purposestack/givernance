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
 * frozen fixtures through BOTH files and asserts hash-equality after
 * masking the only legitimately-varying bytes (timestamps + the
 * timestamp-derived `/ID` trailer).
 *
 * Scope: the **standard-rail letter** only. The compressed-appeal pair
 * for Swiss QR-bill letters (`renderCompressedAppealForQrBill` ↔
 * `swiss-qr-bill-preview.ts`, ADR-027) is a separate lockstep pair that
 * remains socially enforced — extending this harness there is deferred
 * until PR #361 (which is rebuilding that zone) merges.
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
 * Known limit of the boundary trick: the worker module is cast to a
 * hand-written `WorkerModule` type, so the compiler does NOT check the
 * worker's real signature against the fixtures. A required-field drift
 * fails loudly at render time; an **optional-field-only** drift (a field
 * added to one renderer's input and never set by these fixtures) is
 * invisible to this suite — keep new input fields in lockstep and add a
 * fixture exercising them in the same PR.
 *
 * If this test fails: someone edited one renderer without its lockstep
 * counterpart. Apply the same change to the other file — do NOT weaken
 * the canonicalisation below to make it pass. Legitimate exceptions
 * (deliberate divergence) require updating ADR-025 first. The failure
 * message includes the first differing byte offset + context on both
 * sides, so a mismatch that is NOT a layout edit (canonicaliser regex
 * gone stale after a PDFKit upgrade, diverged pdfkit resolutions between
 * the two packages) is attributable without bisecting the renderers.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type PostalLetterRenderInput, renderPostalLetterToBuffer } from "./postal-pdf.js";

// ── Worker renderer, loaded across the package boundary (see header) ──
type WorkerModule = {
  createCampaignLetterPdfStream: (data: PostalLetterRenderInput) => Promise<NodeJS.ReadableStream>;
};

async function loadWorkerRenderer(): Promise<WorkerModule> {
  // Computed specifier — invisible to tsc, resolved by vitest at runtime.
  // `fileURLToPath` (never `URL#pathname`, which percent-encodes spaces
  // and accented characters) so the import survives checkout paths like
  // `/Users/rené/Dev Projects/…`.
  const specifier = fileURLToPath(
    new URL("../../../../worker/src/services/campaign-pdf.ts", import.meta.url),
  );
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

// Sentinels the canonicaliser substitutes in. Asserted below ("the mask
// actually fired") so a PDFKit upgrade that changes the serialisation
// fails deterministically at the self-test — instead of degrading the
// suite into a second-boundary flake misattributed to a lockstep drift.
const DATE_SENTINEL = "(D:00000000000000Z)";
const ID_SENTINEL = "/ID [<0> <0>]";

/**
 * Canonicalise a PDF for comparison: replace the only bytes that
 * legitimately differ between two renders of the same input.
 *
 *   - `(D:YYYYMMDDHHmmssZ)` date literals — the CreationDate wall-clock
 *     stamp. pdfkit 0.19.1 writes Info-dict values as **indirect
 *     objects** (`16 0 obj\n(D:20260722105135Z)\nendobj`), NOT as inline
 *     `/CreationDate (…)` pairs — a key-anchored regex silently matches
 *     nothing and turns the suite into a second-boundary flake (renders
 *     in the same wall-second still hash-match). The mask therefore
 *     targets the fixed-width date literal itself; the self-test below
 *     asserts it actually fired.
 *   - `/ID [<…> <…>]` — trailer file identifiers. **Load-bearing, not
 *     future-proofing**: pdfkit 0.19.1 emits them unconditionally
 *     (`PDFSecurity.generateFileID(this.info)` — an md5 over the Info
 *     dict including `CreationDate.getTime()`, millisecond resolution),
 *     so the api and worker renders virtually always carry different
 *     IDs. Removing this mask makes every parity case fail as a phantom
 *     drift.
 *
 * Deliberately NOT stripped: stream contents, object numbers, xref
 * offsets. Both renders happen in the same process with the same PDFKit
 * + zlib, so any difference there is a REAL layout drift — exactly what
 * this guard exists to catch. (A date-literal byte pattern occurring
 * inside a compressed stream is theoretically maskable too, but it would
 * have to appear asymmetrically between two same-input renders to cause
 * a false pass — negligible, and the stream-only drift self-test below
 * bounds the damage.)
 */
function canonicalisePdf(buffer: Buffer): Buffer {
  const text = buffer.toString("latin1");
  const canonical = text
    .replace(/\(D:\d{14}Z\)/g, DATE_SENTINEL)
    .replace(/\/ID \[<[0-9a-fA-F]+> <[0-9a-fA-F]+>\]/g, ID_SENTINEL);
  return Buffer.from(canonical, "latin1");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Count page objects. The negative lookahead excludes the page-tree root
 * (`/Type /Pages`) while matching each `/Type /Page` leaf.
 */
function countPages(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;
}

/**
 * On mismatch, locate the first differing byte and return a printable
 * context window from both sides — so a failure that is NOT a layout
 * edit (stale canonicaliser regex, diverged pdfkit resolutions) is
 * diagnosable from the CI log alone.
 */
function firstDiffContext(a: Buffer, b: Buffer): string {
  const n = Math.min(a.length, b.length);
  let offset = n;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      offset = i;
      break;
    }
  }
  if (offset === n && a.length === b.length) return "buffers are identical";
  const printable = (buf: Buffer) =>
    buf
      .subarray(Math.max(0, offset - 20), offset + 40)
      .toString("latin1")
      .replace(/[^\x20-\x7e]/g, ".");
  return (
    `lengths api=${a.length} worker=${b.length}; first diff at byte ${offset}\n` +
    `  api:    …${printable(a)}…\n` +
    `  worker: …${printable(b)}…`
  );
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
 * Deterministic long description (~2600 chars) that pushes the QR panel
 * past the bottom margin — forces PDFKit's auto-pagination so the
 * page-tree emission and cross-page text splitting are under parity too.
 */
const LONG_DESCRIPTION = Array.from(
  { length: 20 },
  (_, i) =>
    `Paragraphe ${i + 1} : votre soutien permet de financer des maraudes, des repas ` +
    "chauds, un accompagnement social et un hébergement d'urgence pour les personnes " +
    "isolées de notre territoire, hiver comme été.",
).join(" ");

/**
 * Frozen fixture inputs (issue #289: organisationName, campaignName,
 * recipient, logoBuffer + the copy-path variants). Every branch of the
 * shared layout is represented:
 *   - named recipient with full address + logo + description (fr)
 *   - door-drop (recipient null), no logo, no description → fallback
 *     copy path (en)
 *   - cross-border recipient with a LOWERCASE country code → pins the
 *     `trim().toUpperCase()` normalisation + country-name line
 *   - partial address (addressLine1 without postalCode/city) → address
 *     block SKIPPED while the named greeting is still used; also pins
 *     the whitespace-only-mission skip guard and the `locale ?? "fr"`
 *     fallback (locale deliberately null)
 *   - 2-page overflow (long description) → auto-pagination under parity
 */
const FIXTURES: Array<{
  name: string;
  input: PostalLetterRenderInput;
  expectedPages?: number;
}> = [
  {
    name: "named recipient + logo + description (fr)",
    expectedPages: 1,
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
    name: "cross-border recipient, lowercase country code — country line rendered (fr)",
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
        // Lowercase on purpose — pins the duplicated
        // `countryCode.trim().toUpperCase() !== "FR"` gate in both files.
        countryCode: "ch",
      },
      qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000003?qr=tok-ch",
      qrReference: "parity-qr-token-3",
      locale: "fr",
    },
  },
  {
    name: "partial address — block skipped, named greeting kept, null locale, blank mission",
    input: {
      organisationName: "Aide Partielle Test",
      logoBuffer: null,
      // Whitespace-only — pins the trim-based skip guard (must render
      // like a null mission in BOTH files).
      organisationMission: "   ",
      campaignName: "Campagne adresses incomplètes",
      campaignDescription: null,
      recipient: {
        firstName: "Marie",
        lastName: "Curie",
        email: "marie@example.org",
        addressLine1: "1 rue des Sciences",
        addressLine2: null,
        // Missing postalCode + city → hasWindowEnvelopeAddress false:
        // the C5-window address block is skipped one-sidedly if either
        // copy of that guard is ever relaxed.
        postalCode: null,
        city: null,
        countryCode: null,
      },
      qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000004?qr=tok-partial",
      qrReference: "parity-qr-token-4",
      // Null on purpose — pins the shared `locale ?? "fr"` fallback.
      locale: null,
    },
  },
  {
    name: "2-page overflow — long description forces auto-pagination",
    expectedPages: 2,
    input: {
      organisationName: "Grande Cause Test",
      logoBuffer: LOGO_PNG_1PX,
      organisationMission: "Un long récit pour un long combat.",
      campaignName: "Campagne au long cours",
      campaignDescription: LONG_DESCRIPTION,
      recipient: {
        firstName: "Victor",
        lastName: "Hugo",
        email: null,
        addressLine1: "6 place des Vosges",
        addressLine2: null,
        postalCode: "75004",
        city: "Paris",
        countryCode: "FR",
      },
      qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000005?qr=tok-overflow",
      qrReference: "parity-qr-token-5",
      locale: "fr",
    },
  },
];

describe("ADR-025 parity — postal-pdf.ts (api) ↔ campaign-pdf.ts (worker)", () => {
  for (const { name, input, expectedPages } of FIXTURES) {
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

      // Prove the fixture reached the layout branch it exists for — the
      // overflow fixture must actually paginate (and the single-page ones
      // must not silently grow a page after a future layout tweak).
      if (expectedPages !== undefined) {
        expect(countPages(apiBuffer), `api page count for: ${name}`).toBe(expectedPages);
      }

      const apiCanonical = canonicalisePdf(apiBuffer);
      const workerCanonical = canonicalisePdf(workerBuffer);
      const apiHash = sha256(apiCanonical);
      const workerHash = sha256(workerCanonical);

      // Hash-equality with a located diff on failure — two bare hex
      // strings alone are undebuggable when the cause is NOT a layout
      // edit (stale canonicaliser regex, diverged pdfkit resolutions).
      expect(
        apiHash,
        "Lockstep drift between packages/api/src/modules/campaigns/postal-pdf.ts and " +
          "packages/worker/src/services/campaign-pdf.ts — the preview the operator " +
          "approves no longer matches the bulk export the print shop receives. " +
          "Apply your layout change to BOTH files (ADR-025).\n" +
          firstDiffContext(apiCanonical, workerCanonical),
      ).toBe(workerHash);
    });
  }

  it("canonicalisation masks fire on real output (timestamps + /ID)", async () => {
    // If a PDFKit upgrade changes the CreationDate or /ID serialisation,
    // the masking regexes silently stop matching and the parity suite
    // degrades into a flake (dates: same-second renders still match) or a
    // permanent phantom drift (/ID: millisecond-salted, always differs).
    // This self-test turns that into a deterministic, correctly-attributed
    // failure: the canonicalised output MUST contain both sentinels.
    const input = FIXTURES[0]?.input;
    expect(input).toBeDefined();
    if (!input) return;

    const raw = await renderPostalLetterToBuffer(input);
    const canonical = canonicalisePdf(raw).toString("latin1");

    expect(canonical).toContain(DATE_SENTINEL);
    expect(canonical).toContain(ID_SENTINEL);
    // And the mask changed something — raw output carries real values.
    expect(raw.toString("latin1")).not.toContain(DATE_SENTINEL);
    expect(raw.toString("latin1")).not.toContain(ID_SENTINEL);
  });

  it("canonicalisation only masks timestamps — metadata-visible drift still fails", async () => {
    // Self-test of the guard: campaignName reaches the UNCOMPRESSED Info
    // dictionary (/Title, /Subject) as well as the page content, so this
    // probe catches a canonicaliser that masks whole objects.
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

  it("canonicalisation preserves compressed content streams — stream-only drift still fails", async () => {
    // Complement to the probe above: campaignDescription appears ONLY in
    // the deflate-compressed page content stream (never in the Info
    // dict), so this fails if canonicalisePdf is ever "fixed" to mask
    // stream bodies — the over-broad class that would blind the guard to
    // every layout-only drift (coordinates, fonts, colors, QR raster)
    // while the metadata probe above stayed green.
    const base = FIXTURES[0]?.input;
    expect(base).toBeDefined();
    if (!base) return;

    const original = await renderPostalLetterToBuffer(base);
    const drifted = await renderPostalLetterToBuffer({
      ...base,
      campaignDescription: `${base.campaignDescription} Un mot de plus.`,
    });

    expect(sha256(canonicalisePdf(original))).not.toBe(sha256(canonicalisePdf(drifted)));
  });

  it("two same-input renders through the api path are byte-identical after canonicalisation", async () => {
    // Determinism check: proves the ONLY varying bytes across renders are
    // the timestamp-derived ones the canonicaliser masks. If PDFKit ever
    // introduces a new salt, this fails first and points at the
    // canonicaliser rather than at a phantom lockstep drift.
    const input = FIXTURES[0]?.input;
    expect(input).toBeDefined();
    if (!input) return;

    const first = await renderPostalLetterToBuffer(input);
    const second = await renderPostalLetterToBuffer(input);

    expect(sha256(canonicalisePdf(first))).toBe(sha256(canonicalisePdf(second)));
  });

  it("two same-input renders through the worker path are byte-identical after canonicalisation", async () => {
    // Symmetric determinism check — a worker-side-only nondeterminism
    // source (e.g. a diverged pdfkit resolution gaining extra salting)
    // must be attributed here, not misread as an api↔worker layout drift.
    const { createCampaignLetterPdfStream } = await loadWorkerRenderer();
    const input = FIXTURES[0]?.input;
    expect(input).toBeDefined();
    if (!input) return;

    const first = await streamToBuffer(await createCampaignLetterPdfStream(input));
    const second = await streamToBuffer(await createCampaignLetterPdfStream(input));

    expect(sha256(canonicalisePdf(first))).toBe(sha256(canonicalisePdf(second)));
  });

  it("preview watermark is fixed-position — it never changes pagination", async () => {
    // The watermark is API-only BY DESIGN (the worker has no preview
    // mode; `LetterCopy.previewWatermark` is documented API-side-only in
    // @givernance/shared/postal-print-layout), so parity is defined over
    // `preview: false` output. That definition is only honest while the
    // watermark stays a fixed-position overlay that cannot shift flow
    // content: this probe pins the structural half of that contract on
    // both the 1-page and the overflow fixture. If it ever fails, the
    // watermark became flow content and "the preview the operator
    // approves" no longer matches the print — restore save()/restore() +
    // fixed coordinates in postal-pdf.ts rather than deleting this test.
    for (const fixture of [FIXTURES[0], FIXTURES[4]]) {
      expect(fixture).toBeDefined();
      if (!fixture) return;
      const plain = await renderPostalLetterToBuffer({ ...fixture.input, preview: false });
      const watermarked = await renderPostalLetterToBuffer({ ...fixture.input, preview: true });
      expect(countPages(watermarked), `pagination with preview watermark: ${fixture.name}`).toBe(
        countPages(plain),
      );
    }
  });
});
