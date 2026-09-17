/**
 * `requireAuth` redirect targets (issue #613).
 *
 * A present-but-unverifiable session cookie used to redirect to `/login`.
 * The proxy only checks `exp`, so it saw a signed-in user on `/login` and
 * bounced them to `/dashboard`, whose guard failed again — an infinite
 * loop. The guard now detours through `/api/auth/restore-session`, which
 * either swaps in a verified token or clears the cookies before `/login`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let jwtCookie: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "givernance_jwt" && jwtCookie !== undefined ? { value: jwtCookie } : undefined,
  }),
}));

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const verifyKeycloakJwtMock = vi.fn();
vi.mock("./verify-keycloak-jwt", () => ({
  verifyKeycloakJwt: (token: string) => verifyKeycloakJwtMock(token),
}));

const { requireAuth } = await import("./guards");

function fakeJwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

beforeEach(() => {
  jwtCookie = undefined;
  verifyKeycloakJwtMock.mockReset();
});

describe("requireAuth", () => {
  it("redirects to /login when there is no session cookie", async () => {
    await expect(requireAuth()).rejects.toMatchObject({ target: "/login" });
  });

  it("detours an unverifiable Keycloak JWT through restore-session, not /login", async () => {
    jwtCookie = fakeJwt({ iss: "http://localhost:8080/realms/givernance", sub: "u1" });
    verifyKeycloakJwtMock.mockRejectedValue(new Error("JWKS unreachable"));

    await expect(requireAuth()).rejects.toMatchObject({ target: "/api/auth/restore-session" });
  });

  it("sends an unverifiable impersonation token back to the session list via restore-session", async () => {
    // Real verifier, garbage signature → the HS256 check fails (the
    // rotated-IMPERSONATION_JWT_SECRET case).
    jwtCookie = fakeJwt({ iss: "givernance-impersonation", sub: "target-1" });

    await expect(requireAuth()).rejects.toMatchObject({
      target: "/api/auth/restore-session?return=%2Fadmin%2Fimpersonation",
    });
    expect(verifyKeycloakJwtMock).not.toHaveBeenCalled();
  });

  it("returns the auth context for a verifiable token", async () => {
    jwtCookie = fakeJwt({ iss: "http://localhost:8080/realms/givernance", sub: "u1" });
    verifyKeycloakJwtMock.mockResolvedValue({
      sub: "u1",
      org_id: "org-1",
      email: "claire@solidarite-med.org",
      role: "org_admin",
      realm_access: { roles: ["offline_access"] },
    });

    const auth = await requireAuth();

    expect(auth.userId).toBe("u1");
    expect(auth.roles).toEqual(["offline_access", "org_admin"]);
    expect(auth.impersonation).toBeUndefined();
  });
});
