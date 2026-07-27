/**
 * Unit tests — receipt envelope-encryption primitives (issue #228).
 * Pure crypto + provider behaviour; no DB, no S3, mocked fetch for the
 * Scaleway provider.
 */

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createByteCounter,
  createDecryptStream,
  createEncryptStream,
  createKekProviderFromEnv,
  generateDek,
  LocalKekProvider,
  ScalewayKmsKekProvider,
  unwrapDek,
  verifyEncryptedStream,
  wrapDek,
} from "../lib/receipt-crypto.js";

const PLAINTEXT = Buffer.from(`%PDF-1.4 receipt payload ${"x".repeat(4096)}`, "utf8");
/** AAD = tenant orgId in production (D1 hardening). */
const AAD = Buffer.from("00000000-0000-0000-0000-0000000000aa");

/** Run a buffer through the streaming encrypt pipeline, like the worker does. */
async function encryptBuffer(dek: Buffer, plaintext: Buffer, aad: Buffer = AAD) {
  const { cipher, iv, getAuthTag } = createEncryptStream(dek, aad);
  const { counter, getCount } = createByteCounter();
  const chunks: Buffer[] = [];
  const out = Readable.from(plaintext).pipe(counter).pipe(cipher);
  for await (const chunk of out) {
    chunks.push(chunk as Buffer);
  }
  return {
    ciphertext: Buffer.concat(chunks),
    iv,
    authTag: getAuthTag(),
    plaintextLength: getCount(),
  };
}

describe("DEK stream encrypt / decrypt round-trip", () => {
  it("round-trips a stream and the ciphertext is not the plaintext", async () => {
    const dek = generateDek();
    expect(dek.length).toBe(32);
    const { ciphertext, iv, authTag, plaintextLength } = await encryptBuffer(dek, PLAINTEXT);

    expect(plaintextLength).toBe(PLAINTEXT.length);
    expect(ciphertext.length).toBe(PLAINTEXT.length); // GCM = CTR keystream, same length
    expect(ciphertext.subarray(0, 4).toString("utf8")).not.toBe("%PDF");

    const decipher = createDecryptStream(dek, iv, authTag, AAD);
    const chunks: Buffer[] = [];
    const out = Readable.from(ciphertext).pipe(decipher);
    for await (const chunk of out) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(PLAINTEXT)).toBe(true);
  });

  it("verifyEncryptedStream resolves with the plaintext length on an intact object", async () => {
    const dek = generateDek();
    const { ciphertext, iv, authTag } = await encryptBuffer(dek, PLAINTEXT);
    await expect(
      verifyEncryptedStream(dek, iv, authTag, AAD, Readable.from(ciphertext)),
    ).resolves.toBe(PLAINTEXT.length);
  });

  it("verifyEncryptedStream rejects on a tampered auth tag (fail-closed)", async () => {
    const dek = generateDek();
    const { ciphertext, iv, authTag } = await encryptBuffer(dek, PLAINTEXT);
    const badTag = Buffer.from(authTag);
    badTag[0] = badTag[0]! ^ 0xff;
    await expect(
      verifyEncryptedStream(dek, iv, badTag, AAD, Readable.from(ciphertext)),
    ).rejects.toThrow();
  });

  it("verifyEncryptedStream rejects on tampered ciphertext", async () => {
    const dek = generateDek();
    const { ciphertext, iv, authTag } = await encryptBuffer(dek, PLAINTEXT);
    const tampered = Buffer.from(ciphertext);
    tampered[10] = tampered[10]! ^ 0xff;
    await expect(
      verifyEncryptedStream(dek, iv, authTag, AAD, Readable.from(tampered)),
    ).rejects.toThrow();
  });

  it("rejects when the AAD does not match the one bound at encryption (cross-org transplant)", async () => {
    // D1: a crypto tuple encrypted for tenant A must NOT verify when the
    // serving context is tenant B — the AAD (orgId) is part of the tag.
    const dek = generateDek();
    const { ciphertext, iv, authTag } = await encryptBuffer(dek, PLAINTEXT, AAD);
    const otherOrgAad = Buffer.from("00000000-0000-0000-0000-0000000000bb");
    await expect(
      verifyEncryptedStream(dek, iv, authTag, otherOrgAad, Readable.from(ciphertext)),
    ).rejects.toThrow();
    // Same tuple with the RIGHT AAD still verifies (control).
    await expect(
      verifyEncryptedStream(dek, iv, authTag, AAD, Readable.from(ciphertext)),
    ).resolves.toBe(PLAINTEXT.length);
  });

  it("rejects an empty AAD outright (the org binding must never silently vanish)", () => {
    const dek = generateDek();
    expect(() => createEncryptStream(dek, Buffer.alloc(0))).toThrow(/AAD/);
  });
});

describe("wrapDek / unwrapDek", () => {
  it("round-trips under the same KEK", () => {
    const dek = generateDek();
    const kek = randomBytes(32);
    const wrapped = wrapDek(dek, kek);
    expect(unwrapDek(wrapped, kek).equals(dek)).toBe(true);
  });

  it("throws when unwrapping with the wrong KEK", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, randomBytes(32));
    expect(() => unwrapDek(wrapped, randomBytes(32))).toThrow();
  });

  it("throws on a truncated blob", () => {
    const wrapped = wrapDek(generateDek(), randomBytes(32));
    const truncated = Buffer.from(wrapped, "base64").subarray(0, 20).toString("base64");
    expect(() => unwrapDek(truncated, randomBytes(32))).toThrow(/blob/);
  });
});

describe("LocalKekProvider", () => {
  const v1 = randomBytes(32).toString("base64");
  const v2 = randomBytes(32).toString("base64");

  it("wraps under the active version and unwraps any retained version", async () => {
    const oldProvider = new LocalKekProvider({ v1 }, "v1");
    const dek = generateDek();
    const { wrapped, kekVersionId } = await oldProvider.wrap(dek);
    expect(kekVersionId).toBe("v1");

    // Rotation: keyring keeps v1, active flips to v2.
    const rotated = new LocalKekProvider({ v1, v2 }, "v2");
    expect(rotated.activeVersionId()).toBe("v2");
    expect((await rotated.unwrap(wrapped, "v1")).equals(dek)).toBe(true);

    const rewrapped = await rotated.wrap(dek);
    expect(rewrapped.kekVersionId).toBe("v2");
    expect((await rotated.unwrap(rewrapped.wrapped, "v2")).equals(dek)).toBe(true);
  });

  it("fails closed on a version id absent from the keyring", async () => {
    const provider = new LocalKekProvider({ v1 }, "v1");
    const { wrapped } = await provider.wrap(generateDek());
    await expect(provider.unwrap(wrapped, "v9")).rejects.toThrow(/v9/);
  });

  it("rejects an active version missing from the keyring", () => {
    expect(() => new LocalKekProvider({ v1 }, "v2")).toThrow(/v2/);
  });

  it("rejects keyring entries that are not 32 bytes", () => {
    expect(
      () => new LocalKekProvider({ v1: Buffer.from("short").toString("base64") }, "v1"),
    ).toThrow(/32 bytes/);
  });
});

describe("ScalewayKmsKekProvider", () => {
  const keyId = "11111111-2222-3333-4444-555555555555";

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it("wrap POSTs /encrypt with X-Auth-Token and returns the KMS ciphertext", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ciphertext: "a2Vr" }));
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const { wrapped, kekVersionId } = await provider.wrap(generateDek());
    expect(wrapped).toBe("a2Vr");
    expect(kekVersionId).toBe(`scw:${keyId}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.scaleway.com/key-manager/v1beta1/regions/fr-par/keys/${keyId}/encrypt`,
    );
    expect((init.headers as Record<string, string>)["X-Auth-Token"]).toBe("scw-secret");
    expect(JSON.parse(init.body as string)).toHaveProperty("plaintext");
  });

  it("unwrap POSTs /decrypt against the key id embedded in kekVersionId", async () => {
    const dek = generateDek();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { plaintext: dek.toString("base64") }));
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      region: "nl-ams",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const otherKeyId = "99999999-8888-7777-6666-555555555555";
    const result = await provider.unwrap("Y2lwaGVy", `scw:${otherKeyId}`);
    expect(result.equals(dek)).toBe(true);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe(
      `https://api.scaleway.com/key-manager/v1beta1/regions/nl-ams/keys/${otherKeyId}/decrypt`,
    );
  });

  it("retries once on 5xx and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, { ciphertext: "a2Vr" }));
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const { wrapped } = await provider.wrap(generateDek());
    expect(wrapped).toBe("a2Vr");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails after the single retry when 5xx persists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom" }));
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.wrap(generateDek())).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 4xx (terminal misconfiguration)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: "denied" }));
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.wrap(generateDek())).rejects.toThrow(/HTTP 403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to unwrap a non-Scaleway kekVersionId (provider mismatch)", async () => {
    const fetchImpl = vi.fn();
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.unwrap("blob", "v1")).rejects.toThrow(/Scaleway/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a non-UUID key id smuggled through kekVersionId — no fetch (SSRF path traversal, review M1)", async () => {
    const fetchImpl = vi.fn();
    const provider = new ScalewayKmsKekProvider({
      keyId,
      secretKey: "scw-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // A tampered DB row: fetch normalises the dot-segments, so without
    // the UUID gate this would become an arbitrary api.scaleway.com POST
    // signed with the IAM secret.
    const malicious = "scw:../../../../account/v3/projects?x=";
    await expect(provider.unwrap("blob", malicious)).rejects.toThrow(/UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID key id at construction too", () => {
    expect(() => new ScalewayKmsKekProvider({ keyId: "../evil", secretKey: "scw-secret" })).toThrow(
      /UUID/,
    );
  });
});

describe("createKekProviderFromEnv", () => {
  it("builds a LocalKekProvider from env shape", () => {
    const keyring = { v1: randomBytes(32).toString("base64") };
    const provider = createKekProviderFromEnv({
      RECEIPT_ENCRYPTION_KEK_PROVIDER: "local",
      RECEIPT_ENCRYPTION_LOCAL_KEYRING: JSON.stringify(keyring),
      RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION: "v1",
    });
    expect(provider.activeVersionId()).toBe("v1");
  });

  it("builds a ScalewayKmsKekProvider from env shape", () => {
    const envKeyId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const provider = createKekProviderFromEnv({
      RECEIPT_ENCRYPTION_KEK_PROVIDER: "scaleway",
      RECEIPT_ENCRYPTION_SCW_KEY_ID: envKeyId,
      RECEIPT_ENCRYPTION_SCW_SECRET_KEY: "secret",
    });
    expect(provider.activeVersionId()).toBe(`scw:${envKeyId}`);
  });

  it("throws on absent provider (fail-closed, never plaintext fallback)", () => {
    expect(() => createKekProviderFromEnv({})).toThrow(/RECEIPT_ENCRYPTION_KEK_PROVIDER/);
  });

  it("throws on local provider with missing keyring", () => {
    expect(() =>
      createKekProviderFromEnv({
        RECEIPT_ENCRYPTION_KEK_PROVIDER: "local",
        RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION: "v1",
      }),
    ).toThrow(/RECEIPT_ENCRYPTION_LOCAL_KEYRING/);
  });

  it("throws on invalid keyring JSON", () => {
    expect(() =>
      createKekProviderFromEnv({
        RECEIPT_ENCRYPTION_KEK_PROVIDER: "local",
        RECEIPT_ENCRYPTION_LOCAL_KEYRING: "not-json",
        RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION: "v1",
      }),
    ).toThrow(/not valid JSON/);
  });

  it("throws on scaleway provider with missing key id", () => {
    expect(() =>
      createKekProviderFromEnv({
        RECEIPT_ENCRYPTION_KEK_PROVIDER: "scaleway",
        RECEIPT_ENCRYPTION_SCW_SECRET_KEY: "secret",
      }),
    ).toThrow(/RECEIPT_ENCRYPTION_SCW_KEY_ID/);
  });
});
