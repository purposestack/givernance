/**
 * Back-channel logout endpoint tests (issue #76 / PR-2).
 *
 * Validates:
 *   - Spec-compliant logout token → 200, sid persisted in Redis blocklist.
 *   - Subsequent access token carrying the same `sid` → 401 with
 *     `Session revoked.` body (the auth plugin reads the blocklist).
 *   - Logout token with `nonce` claim → 400 (replay-of-ID-token defence).
 *   - Logout token missing `events` claim → 400.
 *   - Logout token signed for a different audience → 400.
 *   - Logout token missing `sid` → 400 (realm sets `session.required=true`).
 *   - Endpoint exempted from JWT auth (no cookie, no header).
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, signLogoutToken, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function formBody(token: string): string {
  return new URLSearchParams({ logout_token: token }).toString();
}

describe("POST /v1/auth/backchannel-logout — happy path", () => {
  it("accepts a spec-compliant token, returns 200, and blocklists the sid", async () => {
    const token = signLogoutToken();
    // Decode sid from the token (we generated it; just parse the payload back)
    const payloadJson = Buffer.from(token.split(".")[1] ?? "", "base64url").toString();
    const { sid } = JSON.parse(payloadJson) as { sid: string };

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sid });

    const blocklisted = await redis.get(`auth:kc-sid-blocklist:${sid}`);
    expect(blocklisted).toBe("1");
  });

  it("rejects a subsequent access token carrying the revoked sid", async () => {
    const sid = `kc-sid-rev-${Date.now()}`;
    const logoutToken = signLogoutToken({ sid });

    // 1. Trigger back-channel logout for that sid.
    const logoutRes = await app.inject({
      method: "POST",
      url: "/v1/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody(logoutToken),
    });
    expect(logoutRes.statusCode).toBe(200);

    // 2. Mint an access token (still cryptographically valid) with the
    //    same sid and try to use it. Auth plugin should 401.
    const accessToken = signToken(app, { sid });
    const meRes = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(accessToken),
    });
    expect(meRes.statusCode).toBe(401);
    expect(meRes.json()).toMatchObject({
      status: 401,
      title: "Unauthorized",
      detail: "Session revoked.",
    });
  });

  it("does NOT require a JWT cookie or auth header (server-to-server call)", async () => {
    const token = signLogoutToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody(token),
    });
    // 401 here would mean the JWT gate ran. 200 = exempted as expected.
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/auth/backchannel-logout — rejected tokens", () => {
  async function postLogout(claims: Record<string, unknown>) {
    const token = signLogoutToken(claims);
    return app.inject({
      method: "POST",
      url: "/v1/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody(token),
    });
  }

  it("400s a token carrying a `nonce` claim (ID-token replay defence)", async () => {
    const res = await postLogout({ nonce: "should-not-be-here" });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token missing the `events` claim", async () => {
    const res = await postLogout({ events: undefined });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token with the wrong audience", async () => {
    const res = await postLogout({ aud: "some-other-client" });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token missing the `sid` claim", async () => {
    const res = await postLogout({ sid: undefined });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token with `events` set to a non-object value at the spec URI", async () => {
    const res = await postLogout({
      events: { "http://schemas.openid.net/event/backchannel-logout": "not-an-object" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a missing logout_token body field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "logout_token=",
    });
    expect(res.statusCode).toBe(400);
  });
});
