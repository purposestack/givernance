/**
 * Keycloak Token Exchange (RFC 8693) — phase-2 path.
 *
 * Active when `IMPERSONATION_USE_KEYCLOAK_EXCHANGE=true`. The realm needs:
 *   1. Token Exchange feature enabled (`features=token-exchange` startup flag)
 *   2. The `givernance-admin` service account granted `realm-management/impersonation`
 *   3. `infra/keycloak/mappers/impersonation-act-mapper.js` deployed as a
 *      protocol mapper on the `givernance-web` client — it injects the
 *      RFC 8693 `act` claim plus the `imp_*` claims that the API's auth
 *      plugin reads. (Keycloak 26 still does NOT emit `act` natively —
 *      keycloak/keycloak#12076.)
 *
 * Both flows produce identical JWT shapes (`sub`/`act`/`imp_mode`/...) so
 * the auth plugin treats them through one code path.
 */

import { env } from "../../env.js";
import type { ImpersonationModeName } from "./types.js";

export interface KeycloakExchangeArgs {
  operatorAccessToken: string;
  targetKeycloakId: string;
  sessionId: string;
  mode: ImpersonationModeName;
  reason: string;
  ttlSeconds: number;
}

export interface KeycloakExchangeResult {
  token: string;
  /** Decoded `jti` (UUID) — needed to mirror revocation in our own Redis blocklist. */
  jti: string;
  /** Decoded `exp` (seconds-epoch). */
  exp: number;
}

const KEYCLOAK_INTERNAL_BASE = env.KEYCLOAK_INTERNAL_URL ?? env.KEYCLOAK_URL;
const TOKEN_ENDPOINT = `${KEYCLOAK_INTERNAL_BASE}/realms/${env.KEYCLOAK_REALM}/protocol/openid-connect/token`;

export async function exchangeTokenViaKeycloak(
  args: KeycloakExchangeArgs,
): Promise<KeycloakExchangeResult> {
  if (!env.KEYCLOAK_ADMIN_CLIENT_SECRET) {
    throw new Error(
      "exchangeTokenViaKeycloak: KEYCLOAK_ADMIN_CLIENT_SECRET is required when IMPERSONATION_USE_KEYCLOAK_EXCHANGE=true",
    );
  }

  // Custom request parameters (`imp_*`) are read by the Script Mapper
  // (`infra/keycloak/mappers/impersonation-act-mapper.js`) via
  // `userSession.getNote("kc.session.note...")`. The mapper copies them
  // from the access-token request URL parameters into JWT claims.
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: env.KEYCLOAK_ADMIN_CLIENT_ID,
    client_secret: env.KEYCLOAK_ADMIN_CLIENT_SECRET,
    subject_token: args.operatorAccessToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_subject: args.targetKeycloakId,
    audience: env.KEYCLOAK_ADMIN_CLIENT_ID,
    imp_mode: args.mode,
    imp_session_id: args.sessionId,
    imp_reason: args.reason,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Keycloak Token Exchange failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("Keycloak Token Exchange returned no access_token");
  }

  // Decode payload to extract jti / exp without verifying — verification
  // happens via the realm JWKS in the auth plugin on every subsequent
  // request. Here we only need the metadata for our Redis bookkeeping.
  const parts = json.access_token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
    jti?: string;
    exp?: number;
  };
  if (typeof payload.jti !== "string" || typeof payload.exp !== "number") {
    throw new Error("Keycloak Token Exchange response missing jti or exp");
  }

  return { token: json.access_token, jti: payload.jti, exp: payload.exp };
}
