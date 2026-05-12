/**
 * Keycloak back-channel logout token verifier (issue #76 / PR-2).
 *
 * Implements OpenID Connect Back-Channel Logout 1.0 § 2.4 token validation:
 *
 *   - Verify the JWT signature against the realm JWKS (RS256, same key set
 *     as access tokens).
 *   - `iss` MUST equal the realm issuer.
 *   - `aud` MUST contain the client_id (`givernance-web`).
 *   - `iat` MUST be present and not absurdly old (5-minute skew window).
 *   - `jti` MUST be present.
 *   - `events` MUST contain the back-channel logout URI as a member with
 *     a JSON object value (per spec, `{}`).
 *   - `nonce` MUST NOT be present — this is the spec's distinguishing
 *     feature between an ID token and a logout token; accepting a token
 *     with `nonce` here would let an attacker replay a leaked ID token.
 *   - `sub` and/or `sid` MUST be present — at least one identifies what
 *     to revoke. We require `sid` since Keycloak's
 *     `backchannel.logout.session.required` client attribute is set to
 *     `true`, which makes every logout token carry it.
 *
 * Returns the verified `sid` (and `sub` for audit) on success; throws on
 * any spec violation. Callers blocklist the `sid` in Redis so subsequent
 * authenticated requests with a JWT carrying the same `sid` get 401.
 */

import { jwtVerify } from "jose";
import { env } from "../env.js";
import { keycloakIssuer, keycloakJwks } from "./keycloak-jwt.js";

/** Required `events` claim member URI. */
const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/** Max acceptable skew between Keycloak's clock and ours, in seconds. */
const LOGOUT_TOKEN_MAX_AGE_S = 5 * 60;

/** Audience the realm-givernance.json configures for `givernance-web`. */
const EXPECTED_AUDIENCE = env.KEYCLOAK_CLIENT_ID ?? "givernance-web";

export interface LogoutTokenClaims {
  /** Stable Keycloak SSO session id — what we blocklist. */
  sid: string;
  /** Keycloak `sub` — the user ID; surfaced for audit only. */
  sub?: string;
  /** `iat` (seconds-epoch) — used to TTL the blocklist entry. */
  iat: number;
  /** `jti` — surfaced for audit / duplicate-receipt detection. */
  jti: string;
}

export async function verifyBackchannelLogoutToken(token: string): Promise<LogoutTokenClaims> {
  const { payload } = await jwtVerify(token, keycloakJwks, {
    issuer: keycloakIssuer,
    audience: EXPECTED_AUDIENCE,
    algorithms: ["RS256"],
    maxTokenAge: LOGOUT_TOKEN_MAX_AGE_S,
  });

  // OIDC Back-Channel Logout § 2.4 step 4: nonce MUST NOT be present.
  // This is the spec's primary defence against replay of a leaked ID token
  // as a logout token. `jose` doesn't check it for us — it's an asymmetric
  // constraint specific to logout tokens.
  if ("nonce" in payload) {
    throw new Error("Logout token MUST NOT carry a `nonce` claim");
  }

  // `events` MUST be a JSON object containing the back-channel-logout URI
  // as a member whose value is itself a JSON object (per spec, the empty
  // object `{}`). We accept any object-valued member at that URI — Keycloak
  // emits `{}` today but the spec leaves the value open for future use.
  const events = payload.events;
  if (
    !isPlainObject(events) ||
    !isPlainObject((events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT])
  ) {
    throw new Error(`Logout token \`events\` claim must include "${BACKCHANNEL_LOGOUT_EVENT}"`);
  }

  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("Logout token missing required `jti` claim");
  }

  if (typeof payload.iat !== "number") {
    throw new Error("Logout token missing required `iat` claim");
  }

  const sid = payload.sid;
  if (typeof sid !== "string" || sid.length === 0) {
    // The realm sets `backchannel.logout.session.required=true`, so every
    // logout token from Keycloak carries `sid`. A token without it is
    // either malformed or coming from a different upstream — reject.
    throw new Error("Logout token missing required `sid` claim");
  }

  return {
    sid,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    iat: payload.iat,
    jti: payload.jti,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
