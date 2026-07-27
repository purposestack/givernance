/**
 * API-side KEK binding for receipt envelope encryption (issue #228).
 *
 * Thin wrapper over `@givernance/shared/lib/receipt-crypto`'s
 * env-shaped factory — the ONE crypto implementation lives in shared
 * (same no-drift pattern as `s3-branding.ts`); this file only wires the
 * API's env into it. See the worker twin
 * (`packages/worker/src/lib/receipt-kek.ts`) for why this reads
 * `process.env` at CALL time instead of the frozen `env` singleton
 * (lazy, flag-gated requirement + per-test controllability); the same
 * var names are declared (Optional) in `env.ts` so boot validates
 * their shape when present.
 *
 * Throws on absent/invalid config — the download route catches and
 * 502s, NEVER streams raw ciphertext (fail-closed).
 */

import { createKekProviderFromEnv, type KekProvider } from "@givernance/shared/lib/receipt-crypto";

/** Build the KEK provider from the API's environment. Throws on misconfiguration. */
export function getReceiptKekProvider(): KekProvider {
  return createKekProviderFromEnv({
    RECEIPT_ENCRYPTION_KEK_PROVIDER: process.env.RECEIPT_ENCRYPTION_KEK_PROVIDER,
    RECEIPT_ENCRYPTION_LOCAL_KEYRING: process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING,
    RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION: process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION,
    RECEIPT_ENCRYPTION_SCW_KEY_ID: process.env.RECEIPT_ENCRYPTION_SCW_KEY_ID,
    RECEIPT_ENCRYPTION_SCW_SECRET_KEY: process.env.RECEIPT_ENCRYPTION_SCW_SECRET_KEY,
    RECEIPT_ENCRYPTION_SCW_REGION: process.env.RECEIPT_ENCRYPTION_SCW_REGION,
    RECEIPT_ENCRYPTION_SCW_ENDPOINT: process.env.RECEIPT_ENCRYPTION_SCW_ENDPOINT,
  });
}
