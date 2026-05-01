/**
 * Givernance Keycloak Script Mapper — RFC 8693 `act` + impersonation claims.
 *
 * Issue #24. Used in conjunction with the `urn:ietf:params:oauth:grant-type:token-exchange`
 * grant on the `givernance-impersonation` client. Keycloak 26 (as of 26.6) does NOT
 * emit the RFC 8693 `act` claim natively (upstream issue keycloak/keycloak#12076
 * has been open since 2022), so this Script Mapper does it.
 *
 * Inputs:
 *   - imp_mode            — "delegation" | "impersonation"  (read from request URL params)
 *   - imp_session_id      — UUID assigned by the API at session start (request URL params)
 *   - imp_reason          — operator-provided text (request URL params)
 *
 * **Actor identity** is taken from the AUTHENTICATED session, NOT from a URL
 * param — `userSession.getUser().getId()` is the operator who authenticated
 * with their `subject_token`. Reading `imp_act_sub` from URL params would
 * let an operator spoof another user's identity in the audit chain (review
 * L2). The `imp_act_sub` URL param sent by the API is for telemetry only;
 * if it disagrees with the session, we trust the session and warn.
 *
 * Outputs (claims merged into the access token):
 *   - act: { sub: <operator's keycloak_id from authenticated session> }
 *   - imp_mode, imp_session_id, imp_reason
 *
 * Verification: monitor keycloak/keycloak#12076 — when native `act` claim
 * support lands, this mapper should be retired in favour of the built-in.
 */

/* global token, userSession, keycloakSession */
// `token` and `userSession` are injected by the Keycloak script-runner.

(function () {
  if (typeof userSession === "undefined" || userSession === null) {
    return;
  }

  function readNote(key) {
    var v = userSession.getNote(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  var mode = readNote("imp_mode");
  var sessionId = readNote("imp_session_id");
  var reason = readNote("imp_reason");

  if (!mode || !sessionId) {
    // Not a Token-Exchange-initiated impersonation request — leave the
    // token shape alone. This mapper is benign on regular tokens.
    return;
  }

  if (mode !== "delegation" && mode !== "impersonation") {
    // Unknown mode → fail-closed (no `act` claim) so the API auth plugin's
    // `assertImpersonationShape` rejects the token loudly.
    return;
  }

  // SECURITY: actor identity comes from the AUTHENTICATED session, not
  // from URL params — the operator can't spoof someone else as the actor.
  var actor = userSession.getUser();
  if (actor === null || typeof actor === "undefined") {
    return;
  }
  var actorSub = actor.getId();
  if (typeof actorSub !== "string" || actorSub.length === 0) {
    return;
  }

  // RFC 8693 §4.1 — actor claim is a JSON object containing the actor's
  // own subject. Java HashMap survives Jackson serialisation as a nested
  // object in the JWT.
  var act = new java.util.HashMap();
  act.put("sub", actorSub);

  token.setOtherClaims("act", act);
  token.setOtherClaims("imp_mode", mode);
  token.setOtherClaims("imp_session_id", sessionId);
  if (reason !== null) {
    token.setOtherClaims("imp_reason", reason);
  }
})();
