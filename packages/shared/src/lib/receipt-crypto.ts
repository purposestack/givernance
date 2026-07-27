/**
 * Receipt envelope-encryption primitives — issue #228 (shared).
 *
 * One implementation of the DEK/KEK crypto used by both the worker
 * (encrypt at generation) and the API (decrypt at download), **pure and
 * config-injected**: nothing here reads `process.env` or holds a
 * module-level singleton. Each package wires its own env in a thin
 * binding (`packages/{api,worker}/src/lib/receipt-kek.ts`) and delegates
 * here — ONE crypto implementation, no drift (same pattern as
 * `s3-branding.ts`, issue #480).
 *
 * Reachable ONLY via the `@givernance/shared/lib/receipt-crypto` subpath
 * — deliberately NOT re-exported from the root barrel (`src/index.ts`),
 * which reaches the web package. `node:crypto` is server-only; keeping
 * it out of the root barrel avoids an ADR-013 frontend-boundary leak.
 * The web package must NEVER import this module.
 *
 * Design (docs/24-style envelope, ADR follow-up in the docs pass):
 *   - Each receipt PDF gets a fresh 32-byte DEK; the S3 object is PURE
 *     AES-256-GCM ciphertext (IV + auth tag live in the `receipts` row,
 *     not in the object — a leaked bucket yields nothing decryptable).
 *   - The DEK is wrapped by a KEK held outside the object store: a
 *     local keyring (dev / staging / self-hosted) or Scaleway Key
 *     Manager (SaaS prod). KEK rotation re-wraps DEKs in the DB only —
 *     no S3 rewrite (see `rewrap-receipt-deks` worker processor).
 *   - The content cipher binds the tenant `orgId` as GCM associated
 *     data (AAD): a crypto tuple transplanted onto another tenant's row
 *     fails tag verification. The DEK wrap layer stays AAD-less — the
 *     content binding covers that vector (Scaleway `associated_data`
 *     is follow-up work).
 *   - Everything fails CLOSED: unknown KEK version, malformed blob, or
 *     GCM tag mismatch throws; callers must never fall back to
 *     streaming raw ciphertext (or uploading plaintext).
 */

import type { CipherGCM, DecipherGCM } from "node:crypto";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Transform } from "node:stream";

/** Discriminator stored in `receipts.encryption_scheme`. NULL = legacy SSE-S3-only object. */
export const RECEIPT_ENCRYPTION_SCHEME_V1 = "dek-aes256gcm.v1";

const DEK_LENGTH_BYTES = 32;
/** 96-bit IV — the NIST-recommended GCM nonce size. */
const GCM_IV_LENGTH_BYTES = 12;
const GCM_AUTH_TAG_LENGTH_BYTES = 16;

/** Generate a fresh 256-bit data-encryption key (one per receipt). */
export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH_BYTES);
}

/**
 * Create the encrypt side of the streaming pipeline.
 *
 * `cipher` is a Transform: pipe the plaintext PDF stream through it and
 * upload the output. The S3 object is ciphertext ONLY — grab `iv` now
 * and `getAuthTag()` strictly AFTER the upload has fully consumed the
 * stream (the tag only exists once the cipher has finalised).
 *
 * `aad` (mandatory) is bound into the GCM auth tag as associated data —
 * the platform uses the receipt's tenant `orgId`. Because the download
 * path always derives its AAD from the AUTHENTICATED tenant context, a
 * crypto tuple (object + DB columns) transplanted onto another tenant's
 * row no longer verifies: the tag check fails before a single byte is
 * served. The DEK *wrap* layer deliberately stays AAD-less — the
 * content binding already covers the cross-org transplant vector, and
 * Scaleway KMS `associated_data` is tracked as follow-up work.
 */
export function createEncryptStream(
  dek: Buffer,
  aad: Buffer,
): {
  cipher: CipherGCM;
  iv: Buffer;
  getAuthTag: () => Buffer;
} {
  assertDekShape(dek);
  assertAadShape(aad);
  const iv = randomBytes(GCM_IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(aad);
  return { cipher, iv, getAuthTag: () => cipher.getAuthTag() };
}

/**
 * Create the decrypt side of the streaming pipeline. The auth tag and
 * the AAD are set BEFORE any data flows (allowed with GCM); the stream
 * throws at finalisation if the tag doesn't verify — fail-closed. The
 * `aad` must be the same tenant `orgId` the encrypt side bound (see
 * `createEncryptStream`).
 *
 * GCM caveat the API route must respect: plaintext chunks are emitted
 * BEFORE the tag is verified (verification only happens at `final()`).
 * Never pipe this straight to an HTTP response without a prior
 * verification pass — see `verifyEncryptedStream`.
 */
export function createDecryptStream(
  dek: Buffer,
  iv: Buffer,
  authTag: Buffer,
  aad: Buffer,
): DecipherGCM {
  assertDekShape(dek);
  assertAadShape(aad);
  if (iv.length !== GCM_IV_LENGTH_BYTES) {
    throw new Error(`receipt-crypto: IV must be ${GCM_IV_LENGTH_BYTES} bytes, got ${iv.length}`);
  }
  if (authTag.length !== GCM_AUTH_TAG_LENGTH_BYTES) {
    throw new Error(
      `receipt-crypto: auth tag must be ${GCM_AUTH_TAG_LENGTH_BYTES} bytes, got ${authTag.length}`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(authTag);
  decipher.setAAD(aad);
  return decipher;
}

/**
 * Byte-counting passthrough — sits between the PDF stream and the
 * cipher so the worker can persist `plaintext_length` (the download
 * route's `Content-Length`) without buffering anything.
 */
export function createByteCounter(): { counter: Transform; getCount: () => number } {
  let count = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      count += chunk.length;
      cb(null, chunk);
    },
  });
  return { counter, getCount: () => count };
}

/**
 * Integrity pre-check for the download path: stream the ciphertext
 * through a throwaway decipher, DISCARD the plaintext, and resolve with
 * the plaintext byte count. Rejects on GCM tag mismatch (tampered
 * object / tampered DB row). Memory-bounded — nothing is buffered.
 */
export function verifyEncryptedStream(
  dek: Buffer,
  iv: Buffer,
  authTag: Buffer,
  aad: Buffer,
  ciphertext: NodeJS.ReadableStream,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const decipher = createDecryptStream(dek, iv, authTag, aad);
    let plaintextBytes = 0;
    decipher.on("data", (chunk: Buffer) => {
      plaintextBytes += chunk.length;
    });
    decipher.on("end", () => resolve(plaintextBytes));
    decipher.on("error", reject);
    ciphertext.on("error", reject);
    ciphertext.pipe(decipher);
  });
}

// ─── DEK wrapping (KEK layer) ───────────────────────────────────────────────

/**
 * Wrap a DEK under a raw 32-byte KEK. Blob layout (base64-encoded):
 * `iv(12) || ciphertext(32) || authTag(16)` — self-contained apart from
 * the KEK itself, so unwrap only needs the blob + the right key.
 */
export function wrapDek(dek: Buffer, kek: Buffer): string {
  assertDekShape(dek);
  assertKekShape(kek);
  const iv = randomBytes(GCM_IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
}

/** Unwrap a DEK blob produced by `wrapDek`. Throws on tampering / wrong KEK. */
export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  assertKekShape(kek);
  const blob = Buffer.from(wrapped, "base64");
  const minimum = GCM_IV_LENGTH_BYTES + DEK_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES;
  if (blob.length !== minimum) {
    throw new Error(
      `receipt-crypto: wrapped DEK blob must be ${minimum} bytes, got ${blob.length}`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_LENGTH_BYTES);
  const ciphertext = blob.subarray(GCM_IV_LENGTH_BYTES, GCM_IV_LENGTH_BYTES + DEK_LENGTH_BYTES);
  const authTag = blob.subarray(GCM_IV_LENGTH_BYTES + DEK_LENGTH_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── KEK providers ──────────────────────────────────────────────────────────

/**
 * A source of key-encryption keys. `wrap` always uses the ACTIVE KEK
 * version; `unwrap` selects the version recorded on the receipt row —
 * that split is what makes zero-S3-touch rotation possible.
 */
export interface KekProvider {
  /** Version id new wraps will record (`receipts.kek_version_id`). */
  activeVersionId(): string;
  wrap(dek: Buffer): Promise<{ wrapped: string; kekVersionId: string }>;
  unwrap(wrapped: string, kekVersionId: string): Promise<Buffer>;
}

/**
 * Keyring-backed provider for dev / staging / self-hosted. Keys are
 * plain base64 32-byte values keyed by an arbitrary version id; the
 * active version wraps, every retained version can still unwrap.
 * Rotation = add `v2`, flip active to `v2`, run the re-wrap sweep,
 * then (optionally) drop `v1` from the keyring.
 */
export class LocalKekProvider implements KekProvider {
  private readonly keyring: Map<string, Buffer>;
  private readonly activeVersion: string;

  constructor(keyring: Record<string, string>, activeVersion: string) {
    this.keyring = new Map();
    for (const [versionId, base64Key] of Object.entries(keyring)) {
      const key = Buffer.from(base64Key, "base64");
      if (key.length !== DEK_LENGTH_BYTES) {
        throw new Error(
          `receipt-crypto: local keyring entry "${versionId}" must decode to 32 bytes, got ${key.length}`,
        );
      }
      this.keyring.set(versionId, key);
    }
    if (!this.keyring.has(activeVersion)) {
      throw new Error(
        `receipt-crypto: active KEK version "${activeVersion}" is not present in the local keyring`,
      );
    }
    this.activeVersion = activeVersion;
  }

  activeVersionId(): string {
    return this.activeVersion;
  }

  async wrap(dek: Buffer): Promise<{ wrapped: string; kekVersionId: string }> {
    // Constructor guarantees the active version exists.
    const kek = this.keyring.get(this.activeVersion) as Buffer;
    return { wrapped: wrapDek(dek, kek), kekVersionId: this.activeVersion };
  }

  async unwrap(wrapped: string, kekVersionId: string): Promise<Buffer> {
    const kek = this.keyring.get(kekVersionId);
    if (!kek) {
      // Fail-closed: a version id we don't hold a key for is an
      // operational error (keyring rotated too aggressively, or a
      // misconfigured env) — never guess with another key.
      throw new Error(
        `receipt-crypto: KEK version "${kekVersionId}" is not present in the local keyring — cannot unwrap`,
      );
    }
    return unwrapDek(wrapped, kek);
  }
}

/** Options for the Scaleway Key Manager provider. */
export interface ScalewayKmsOptions {
  /** Scaleway Key Manager key UUID. */
  keyId: string;
  /** IAM secret key, sent as `X-Auth-Token`. */
  secretKey: string;
  /** Scaleway region, e.g. `fr-par` (default). */
  region?: string;
  /** API endpoint override (tests / private gateways). */
  endpoint?: string;
  /** Injectable fetch for unit tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10 000). */
  timeoutMs?: number;
}

const SCW_VERSION_PREFIX = "scw:";

/**
 * Scaleway Key Manager key ids are UUIDs — enforced BEFORE any URL is
 * built from one. `kekVersionId` comes from a DATABASE column: without
 * this check, a tampered row like `scw:../../../../account/v3/...`
 * would path-traverse the request URL (fetch normalises dot-segments)
 * into an arbitrary api.scaleway.com POST signed with the IAM secret.
 */
const SCW_KEY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertScwKeyId(keyId: string): void {
  if (!SCW_KEY_ID_RE.test(keyId)) {
    throw new Error(
      "receipt-crypto: Scaleway KMS key id must be a UUID — refusing to build a request URL from it",
    );
  }
}

/**
 * Scaleway Key Manager provider (SaaS prod — EU data-residency, single
 * Scaleway DPA, same rationale as the rest of the stack).
 *
 * `kekVersionId` is `scw:{keyId}`: Scaleway rotates key material
 * internally and its ciphertext is self-describing (it embeds the key
 * version used), so the platform only needs to know WHICH key resource
 * wrapped the DEK. Rotation on Scaleway is therefore transparent for
 * unwrap; the re-wrap sweep still refreshes rows onto the newest
 * material.
 *
 * Network posture: one retry on 5xx / network failure, hard timeout per
 * attempt, 4xx is terminal (bad credentials / bad key id — retrying
 * cannot help and would mask the misconfiguration).
 */
export class ScalewayKmsKekProvider implements KekProvider {
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ScalewayKmsOptions) {
    if (!options.keyId) throw new Error("receipt-crypto: Scaleway KMS keyId is required");
    // Same UUID gate as unwrap — the configured id also ends up in URLs.
    assertScwKeyId(options.keyId);
    if (!options.secretKey) throw new Error("receipt-crypto: Scaleway KMS secretKey is required");
    this.keyId = options.keyId;
    this.secretKey = options.secretKey;
    this.region = options.region ?? "fr-par";
    this.endpoint = (options.endpoint ?? "https://api.scaleway.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  activeVersionId(): string {
    return `${SCW_VERSION_PREFIX}${this.keyId}`;
  }

  async wrap(dek: Buffer): Promise<{ wrapped: string; kekVersionId: string }> {
    assertDekShape(dek);
    const body = await this.call(this.keyId, "encrypt", { plaintext: dek.toString("base64") });
    const ciphertext = (body as { ciphertext?: string }).ciphertext;
    if (!ciphertext) {
      throw new Error("receipt-crypto: Scaleway KMS encrypt response is missing `ciphertext`");
    }
    return { wrapped: ciphertext, kekVersionId: this.activeVersionId() };
  }

  async unwrap(wrapped: string, kekVersionId: string): Promise<Buffer> {
    if (!kekVersionId.startsWith(SCW_VERSION_PREFIX)) {
      // A row wrapped under the LOCAL provider cannot be unwrapped by
      // KMS (and vice versa) — surface the mismatch instead of sending
      // a local blob to Scaleway and returning garbage.
      throw new Error(
        `receipt-crypto: KEK version "${kekVersionId}" was not produced by the Scaleway provider — cannot unwrap`,
      );
    }
    // Unwrap against the key resource recorded on the row (supports
    // reading rows wrapped under a previous key resource mid-rotation).
    // The extracted id is validated as a strict UUID before it can reach
    // a URL — `kek_version_id` is DB data, and an unvalidated slice here
    // was an SSRF-shaped path traversal (see SCW_KEY_ID_RE).
    const keyId = kekVersionId.slice(SCW_VERSION_PREFIX.length);
    assertScwKeyId(keyId);
    const body = await this.call(keyId, "decrypt", { ciphertext: wrapped });
    const plaintext = (body as { plaintext?: string }).plaintext;
    if (!plaintext) {
      throw new Error("receipt-crypto: Scaleway KMS decrypt response is missing `plaintext`");
    }
    const dek = Buffer.from(plaintext, "base64");
    assertDekShape(dek);
    return dek;
  }

  private async call(
    keyId: string,
    operation: "encrypt" | "decrypt",
    payload: Record<string, string>,
  ): Promise<unknown> {
    const url = `${this.endpoint}/key-manager/v1beta1/regions/${this.region}/keys/${keyId}/${operation}`;
    let lastError: unknown;
    // One retry, 5xx / network only — a transient KMS blip must not
    // fail a receipt job outright, but 4xx is terminal misconfiguration.
    for (let attempt = 0; attempt < 2; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "X-Auth-Token": this.secretKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: abort.signal,
        });
        if (response.ok) {
          return (await response.json()) as unknown;
        }
        // NOTE: never include the response body in the error — KMS
        // errors can echo request context and this message rides log
        // lines.
        const error = new Error(
          `receipt-crypto: Scaleway KMS ${operation} failed with HTTP ${response.status}`,
        );
        if (response.status < 500) throw error; // terminal — do not retry
        lastError = error;
      } catch (err) {
        if (err instanceof Error && err.message.includes("failed with HTTP 4")) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`receipt-crypto: Scaleway KMS ${operation} failed`);
  }
}

// ─── Env-shaped factory ─────────────────────────────────────────────────────

/**
 * Env-var names both packages use. The factory takes a plain record
 * (each package passes its own validated env / `process.env`) so this
 * module stays pure.
 */
export interface ReceiptKekEnvShape {
  RECEIPT_ENCRYPTION_KEK_PROVIDER?: string;
  RECEIPT_ENCRYPTION_LOCAL_KEYRING?: string;
  RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION?: string;
  RECEIPT_ENCRYPTION_SCW_KEY_ID?: string;
  RECEIPT_ENCRYPTION_SCW_SECRET_KEY?: string;
  RECEIPT_ENCRYPTION_SCW_REGION?: string;
  RECEIPT_ENCRYPTION_SCW_ENDPOINT?: string;
}

/**
 * Build a `KekProvider` from env-shaped config. THROWS on absent or
 * invalid config — callers only reach this when the
 * `donation.receipt_envelope_encryption` flag is ON (or a row is
 * already marked encrypted), and a misconfigured KEK must fail the job
 * / request, NEVER silently fall back to plaintext handling.
 */
export function createKekProviderFromEnv(
  envShape: ReceiptKekEnvShape,
  fetchImpl?: typeof fetch,
): KekProvider {
  const provider = envShape.RECEIPT_ENCRYPTION_KEK_PROVIDER;
  if (provider === "local") {
    const keyringJson = envShape.RECEIPT_ENCRYPTION_LOCAL_KEYRING;
    const activeVersion = envShape.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION;
    if (!keyringJson || !activeVersion) {
      throw new Error(
        "receipt-crypto: RECEIPT_ENCRYPTION_KEK_PROVIDER=local requires RECEIPT_ENCRYPTION_LOCAL_KEYRING and RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION",
      );
    }
    let keyring: Record<string, string>;
    try {
      keyring = JSON.parse(keyringJson) as Record<string, string>;
    } catch {
      throw new Error("receipt-crypto: RECEIPT_ENCRYPTION_LOCAL_KEYRING is not valid JSON");
    }
    return new LocalKekProvider(keyring, activeVersion);
  }
  if (provider === "scaleway") {
    const keyId = envShape.RECEIPT_ENCRYPTION_SCW_KEY_ID;
    const secretKey = envShape.RECEIPT_ENCRYPTION_SCW_SECRET_KEY;
    if (!keyId || !secretKey) {
      throw new Error(
        "receipt-crypto: RECEIPT_ENCRYPTION_KEK_PROVIDER=scaleway requires RECEIPT_ENCRYPTION_SCW_KEY_ID and RECEIPT_ENCRYPTION_SCW_SECRET_KEY",
      );
    }
    return new ScalewayKmsKekProvider({
      keyId,
      secretKey,
      region: envShape.RECEIPT_ENCRYPTION_SCW_REGION,
      endpoint: envShape.RECEIPT_ENCRYPTION_SCW_ENDPOINT,
      fetchImpl,
    });
  }
  throw new Error(
    "receipt-crypto: RECEIPT_ENCRYPTION_KEK_PROVIDER must be 'local' or 'scaleway' when receipt envelope encryption is enabled",
  );
}

// ─── Internal guards ────────────────────────────────────────────────────────

function assertDekShape(dek: Buffer): void {
  if (dek.length !== DEK_LENGTH_BYTES) {
    throw new Error(`receipt-crypto: DEK must be ${DEK_LENGTH_BYTES} bytes, got ${dek.length}`);
  }
}

function assertKekShape(kek: Buffer): void {
  if (kek.length !== DEK_LENGTH_BYTES) {
    throw new Error(`receipt-crypto: KEK must be ${DEK_LENGTH_BYTES} bytes, got ${kek.length}`);
  }
}

function assertAadShape(aad: Buffer): void {
  // The AAD is the tenant orgId — an empty buffer would silently drop
  // the cross-org binding, so it is rejected outright.
  if (aad.length === 0) {
    throw new Error("receipt-crypto: AAD must be a non-empty buffer (the receipt's tenant orgId)");
  }
}
