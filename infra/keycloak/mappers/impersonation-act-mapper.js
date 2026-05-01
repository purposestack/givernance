/**
 * Givernance Keycloak Script Mapper — RFC 8693 `act` + impersonation claims.
 *
 * Issue #24. Used in conjunction with the `urn:ietf:params:oauth:grant-type:token-exchange`
 * grant on the `givernance-impersonation` client. Keycloak 26 (as of 26.6) does NOT
 * emit the RFC 8693 `act` claim natively (upstream issue keycloak/keycloak#12076
 * has been open since 2022), so this Script Mapper does it.
 *
 * Inputs (all read from `userSession.getNote("kc.session.note.<key>")` after the
 * Token Exchange request maps URL params into session notes):
 *   - imp_act_sub         — Keycloak `sub` of the operator (the actor)
 *   - imp_mode            — "delegation" | "impersonation"
 *   - imp_session_id      — UUID assigned by the API at session start
 *   - imp_reason          — operator-provided text
 *
 * Outputs (claims merged into the access token):
 *   - act: { sub: <imp_act_sub> }
 *   - imp_mode, imp_session_id, imp_reason — Givernance-specific top-level claims
 *   - iss override is NOT done here; we keep Keycloak's realm issuer string so
 *     the API's auth plugin can verify against the realm JWKS in the
 *     IMPERSONATION_USE_KEYCLOAK_EXCHANGE=true path.
 *
 * Output binding: this file is registered as a JS Script Mapper provider; the
 * mapper config in realm-givernance.json points at this file by name and
 * targets `givernance-impersonation`'s access token.
 *
 * Verification: monitor keycloak/keycloak#12076 — when native `act` claim
 * support lands, this mapper should be retired in favour of the built-in.
 */

/* global token, userSession */
// `token` and `userSession` are injected by the Keycloak script-runner. The
// signature follows Keycloak's JS Mapper convention — return value is ignored;
// claims are added to `token` via setOtherClaims.

(function () {
  if (typeof userSession === "undefined" || userSession === null) {
    return;
  }

  function readNote(key) {
    var v = userSession.getNote(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  var actSub = readNote("imp_act_sub");
  var mode = readNote("imp_mode");
  var sessionId = readNote("imp_session_id");
  var reason = readNote("imp_reason");

  if (!actSub || !mode || !sessionId) {
    // Not a Token-Exchange-initiated impersonation request — leave the
    // token shape alone. This mapper is benign on regular tokens.
    return;
  }

  if (mode !== "delegation" && mode !== "impersonation") {
    // Reject unknown modes silently — fail closed (no `act` claim) so the
    // API auth plugin's `assertImpersonationShape` rejects it loudly.
    return;
  }

  // RFC 8693 §4.1 — the actor claim is a JSON object containing the actor's
  // own subject. Java's HashMap keeps the `act` claim as a structured object
  // when emitted to JSON.
  var act = new java.util.HashMap();
  act.put("sub", actSub);

  token.setOtherClaims("act", act);
  token.setOtherClaims("imp_mode", mode);
  token.setOtherClaims("imp_session_id", sessionId);
  if (reason !== null) {
    token.setOtherClaims("imp_reason", reason);
  }
})();
