/**
 * Worker-side KEK binding for receipt envelope encryption (issue #228).
 *
 * Thin wrapper over `@givernance/shared/lib/receipt-crypto`'s
 * env-shaped factory — the ONE crypto implementation lives in shared
 * (same no-drift pattern as `s3-branding.ts`); this file only wires the
 * worker's env into it.
 *
 * Deliberately reads `process.env` at CALL time rather than the frozen
 * `env` singleton from `env.ts`:
 *   - The vars are optional at boot (the flag is default-off) and only
 *     become load-bearing when a gated job actually runs — lazy reads
 *     mean flipping the flag + rolling the env vars needs no special
 *     ordering beyond "vars first".
 *   - Integration tests can exercise the configured / misconfigured
 *     branches in one process by mutating `process.env` per test.
 * The same var names are still declared (Optional) in `env.ts` so boot
 * validates their SHAPE when present.
 *
 * Throws on absent/invalid config — the generate/rewrap job must FAIL,
 * never fall back to uploading plaintext (fail-closed).
 */

import { createKekProviderFromEnv, type KekProvider } from "@givernance/shared/lib/receipt-crypto";

/** Build the KEK provider from the worker's environment. Throws on misconfiguration. */
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
