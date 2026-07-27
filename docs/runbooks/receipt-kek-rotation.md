# Runbook — Receipt KEK provisioning, rotation & compromise response (issue #228)

> Operator-facing reference for the receipt envelope-encryption key hierarchy
> shipped behind `donation.receipt_envelope_encryption`. Covers: (a) first-time
> provisioning per environment, (b) planned KEK rotation, (c) response to a
> suspected KEK compromise, (d) feature-flag rollback semantics.
> Related: [ADR-037](../adrs/adr-037-receipt-envelope-encryption.md),
> [docs/06 § Receipt envelope encryption](../06-security-compliance.md),
> [feature-flag-rollback.md](feature-flag-rollback.md),
> [staging-secrets-setup.md](../dev/staging-secrets-setup.md).

## 0. Why this exists — at a glance

Each envelope-encrypted receipt PDF is sealed with its own DEK; that DEK is
wrapped by a **KEK** the platform operator controls — a JSON keyring in env
vars (dev / staging / self-hosted) or a Scaleway Key Manager key (SaaS prod).
Rotating the KEK is a **DB-only** operation: the `receipts.rewrap_deks` worker
job unwraps each row's 32-byte DEK under the old KEK version and re-wraps it
under the active one. **No S3 object is ever rewritten** — that is the entire
point of the envelope design. This runbook is the only sanctioned procedure for
touching KEK material.

Two invariants to keep in mind throughout:

1. **Fail-closed**: flag ON + missing/invalid `RECEIPT_ENCRYPTION_*` config ⇒
   receipt-generation jobs FAIL (no silent plaintext fallback) and encrypted
   downloads 502. Deploy config **before** flipping the flag; never "fix" a
   config error by turning encryption off while encrypted rows exist — they'd
   still need the KEK to be served.
2. **Never destroy a KEK version that can still unwrap rows.** A version is
   retirable only after a re-wrap sweep reports `failed: 0` and no row's
   `kek_version_id` references it (verification query in §2, step 6).

## 1. First-time provisioning

### 1.1 The 7 env vars (api AND worker — identical values)

| Var | local provider | scaleway provider |
|---|---|---|
| `RECEIPT_ENCRYPTION_KEK_PROVIDER` | `local` | `scaleway` |
| `RECEIPT_ENCRYPTION_LOCAL_KEYRING` | JSON `{"v1":"<base64 32B>"}` | — |
| `RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION` | `v1` | — |
| `RECEIPT_ENCRYPTION_SCW_KEY_ID` | — | Key Manager key UUID |
| `RECEIPT_ENCRYPTION_SCW_SECRET_KEY` | — | IAM secret key |
| `RECEIPT_ENCRYPTION_SCW_REGION` | — | `fr-par` (default) |
| `RECEIPT_ENCRYPTION_SCW_ENDPOINT` | — | only for tests / private gateways |

Both packages declare them as optional TypeBox env entries
([`packages/api/src/env.ts`](../../packages/api/src/env.ts),
[`packages/worker/src/env.ts`](../../packages/worker/src/env.ts)) and read them
**lazily at call time** — a deploy without them boots fine as long as the flag
is off and no encrypted rows exist.

### 1.2 Staging / dev / self-hosted — local keyring

```sh
# Generate a 32-byte key, base64-encoded:
openssl rand -base64 32
# → e.g. 4fWn…hK0=   (save to the password manager BEFORE setting anywhere)
```

Set (staging: as GitHub Environment secrets — see
[staging-secrets-setup.md](../dev/staging-secrets-setup.md) § conditional
secrets; local dev: `.env`, see the commented block in
[`.env.example`](../../.env.example)):

```sh
RECEIPT_ENCRYPTION_KEK_PROVIDER=local
RECEIPT_ENCRYPTION_LOCAL_KEYRING={"v1":"<the base64 value>"}
RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION=v1
```

> The keyring JSON is a secret in its entirety. Never commit a real value; the
> `.env.example` sample key is a published throwaway.

### 1.3 SaaS prod — Scaleway Key Manager

1. **Create the key** (console: *Key Manager → Create key*, region `fr-par`,
   symmetric encryption; or CLI):

   ```sh
   scw keymanager key create name=givernance-receipt-kek region=fr-par \
     usage=symmetric_encryption
   # note the key UUID → RECEIPT_ENCRYPTION_SCW_KEY_ID
   ```

2. **Minimal IAM**: create a dedicated IAM application + policy scoped to
   **that key only**, with encrypt/decrypt permissions (`KeyManagerFullAccess`
   is more than needed — prefer a custom rule carrying only
   `key_manager:*:encrypt` / `decrypt` / read on the key's project). Generate an
   API key for the application → its secret key is
   `RECEIPT_ENCRYPTION_SCW_SECRET_KEY`. Do **not** reuse the Object-Storage
   credentials — separating them is what keeps "bucket creds leaked" from
   implying "KEK usable".

3. Set the four `RECEIPT_ENCRYPTION_*` prod values (provider, key id, secret
   key, region) in the prod secret bag for **both** api and worker services.

### 1.4 Order of operations — env vars FIRST, flag SECOND

1. Deploy the env vars to api + worker (a no-op for behaviour: flag still off).
2. Verify the containers rebooted with the vars present
   (`docker exec givernance-worker env | grep RECEIPT_ENCRYPTION` — the
   keyring value will display; treat the shell session accordingly).
3. Flip `donation.receipt_envelope_encryption` ON (Back Office
   `/admin/feature-flags` — platform scope, super-admin only).
4. Generate a test receipt (create a donation on a test org) and confirm:
   - worker log line `Receipt generated` carries `envelopeEncrypted: true`;
   - the new `receipts` row has `encryption_scheme = 'dek-aes256gcm.v1'`;
   - the receipt downloads fine from the operator UI;
   - the raw S3 object is opaque (`Content-Type: application/octet-stream`,
     not a `%PDF` header).

### 1.5 Staged enablement

Staging first, prod after a soak: enable on staging, run §1.4 step 4 checks,
leave it on for a few days of organic receipt generation (watch for
`Receipt DEK unwrap failed` / `Receipt ciphertext integrity verification
failed` API log lines — there should be none), then repeat §1.4 on prod.

## 2. Planned KEK rotation

Rotation cadence is a policy decision (annual is a reasonable default; also
rotate on operator offboarding for the local provider). The sweep is idempotent
and cheap — when in doubt, rotate.

1. **Add the new KEK version, keeping the old one resolvable.**
   - *local*: add `"v2"` to the keyring JSON **without removing `v1`**, and
     flip the active pointer:

     ```sh
     RECEIPT_ENCRYPTION_LOCAL_KEYRING={"v1":"<old>","v2":"<openssl rand -base64 32>"}
     RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION=v2
     ```

   - *scaleway*: `scw keymanager key rotate key-id=<uuid>` — Scaleway rotates
     the key material internally; its ciphertext is self-describing, so old
     wraps keep unwrapping with no env change (`kek_version_id` stays
     `scw:{keyId}`). If you are instead migrating to a **new key resource**,
     set `RECEIPT_ENCRYPTION_SCW_KEY_ID` to the new UUID and keep the IAM
     policy granting decrypt on the **old** key until step 6.

2. **Redeploy api + worker** so both read the new config. New receipts now
   wrap under the new version immediately; old rows still unwrap (the provider
   resolves the version recorded per-row).

3. **Trigger the re-wrap sweep** (manual by design — no cron):

   ```sh
   REWRAP_REQUESTED_BY="ops@givernance.eu" \
     pnpm --filter @givernance/worker run rewrap:trigger
   ```

   The script enqueues one `receipts.rewrap_deks` job and prints the job id;
   the sweep runs inside the live worker.

4. **Watch the summary** in the worker logs:

   ```sh
   kamal app logs -r worker --follow | grep "re-wrap sweep"
   # → Receipt DEK re-wrap sweep finished { scanned, rewrapped, failed, activeVersion }
   ```

   Per-row failures are isolated (`Receipt DEK re-wrap failed for row —
   continuing sweep`, with `receiptId` + old `kekVersionId` + reason) and do
   not abort the sweep; failed rows keep their old version and match the next
   sweep.

5. **If `failed > 0`**: the usual cause is a version id the provider can no
   longer resolve (keyring pruned too early, IAM decrypt revoked on the old
   Scaleway key). Restore resolvability of the old version, redeploy, re-run
   step 3. Do not proceed to step 6 with failures outstanding.

6. **Retire the old version ONLY after `failed: 0`** and this returns zero
   rows:

   ```sql
   SELECT count(*) FROM receipts
    WHERE encryption_scheme IS NOT NULL
      AND kek_version_id <> '<active version id>';   -- 'v2' or 'scw:<new-uuid>'
   ```

   Then: *local* — remove `"v1"` from the keyring JSON + redeploy; *scaleway*
   (new key resource case) — revoke IAM decrypt on the old key, then schedule
   its deletion. Record the rotation (date, operator, versions) in the ops log.

## 3. KEK compromise response

Assume the **KEK** (keyring value or Scaleway credentials) is exposed, not the
receipts themselves — the object store and DB are separate concerns.

1. **Contain**: for *scaleway*, immediately revoke the leaked IAM API key (and
   create a fresh one for the platform). For *local*, treat every keyring
   version present in the leaked env as burned.
2. **Emergency rotation**: run §2 steps 1–4 now (new version, redeploy,
   sweep). Until the sweep completes, rows wrapped under the compromised
   version remain at risk **only** if the attacker also has DB access to
   `dek_wrapped` — the KEK alone decrypts nothing.
3. **Destroy the compromised version** the moment step 6's query hits zero:
   local — remove it from the keyring; scaleway — disable then delete the key
   / rotate credentials. This is the step that actually ends the exposure.
4. **If `failed > 0` during an emergency rotation**: the failing rows are
   still wrapped under the compromised version — do NOT destroy it yet (that
   would brick those receipts). Fix resolvability, re-sweep, and only then
   destroy. If a row is genuinely unrecoverable (corrupted blob), escalate:
   the receipt may need regeneration from the donation record, and the
   incident write-up must note it.
5. **Assess notification duty**: KEK-only exposure with no evidence of DB
   `dek_wrapped` access is a key-rotation event, not a personal-data breach.
   KEK + DB exposure together = treat as a receipts breach (donor name,
   address, amount) → CNIL 72h assessment per the incident process in
   [docs/06](../06-security-compliance.md).

## 4. Feature-flag rollback semantics

`donation.receipt_envelope_encryption` OFF (Back Office, or the psql +
`redis-cli DEL flags:global` path in
[feature-flag-rollback.md](feature-flag-rollback.md)) affects **new receipts
only**: generation reverts to plaintext + SSE-S3, and a pending
`receipts.rewrap_deks` job no-ops loudly. **Already-encrypted receipts keep
being decrypted and served** — the download route branches on the row's
`encryption_scheme`, not on the flag. Consequently:

- Rollback never bricks existing receipts, and needs no data migration.
- The `RECEIPT_ENCRYPTION_*` env vars must **stay deployed** (and the KEK
  versions resolvable) for as long as any `encryption_scheme IS NOT NULL` row
  exists — flag state notwithstanding.
- Rollback is the right move for "encryption path is misbehaving on
  generation"; it is the wrong move for "KEK config is broken" (fix the
  config — downloads of encrypted rows depend on it either way).
