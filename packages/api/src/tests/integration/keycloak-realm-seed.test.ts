/**
 * Keycloak 26 realm-seed shape validation (issue #114).
 *
 * Hermetic contract test — no services required (no Postgres, Redis, or
 * Keycloak). Safe to run as a pure unit test; lives in `tests/integration/`
 * to sit next to the onboarding-runtime tests it guards against regressing.
 *
 * Runs in CI without a live Keycloak: the full end-to-end smoke — login +
 * org_id claim emitted — is covered by `scripts/keycloak-smoke-test.sh` which
 * `scripts/dev-up.sh` executes on every local bring-up. CI today does not
 * spin up Keycloak (see ADR-017 consequences / .github/workflows/ci.yml),
 * so this test enforces the realm-JSON contract that the live stack relies
 * on — if this shape drifts, the smoke script will fail locally too.
 *
 * Assertions match acceptance criteria of issue #114:
 *   - Organizations feature is enabled at the realm level
 *   - A seeded platform Organization exists with the canonical org_id
 *   - The seeded super-admin user is a member of that Organization
 *   - The `givernance-web` client emits the `organization` membership claim
 *     via the Keycloak 26 built-in mapper, on the default client scopes so
 *     every token carries it without scope opt-in
 *   - The user-attribute `org_id` and the Organization-attribute `org_id`
 *     are cross-consistent (addresses the transitional two-sources-of-truth
 *     risk flagged in PR #139 review)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REALM_JSON_PATH = path.resolve(
  __dirname,
  "../../../../..",
  "infra/keycloak/realm-givernance.json",
);

interface ProtocolMapper {
  name: string;
  protocolMapper: string;
  config?: Record<string, string>;
}
interface KeycloakClient {
  clientId: string;
  defaultClientScopes?: string[];
  protocolMappers?: ProtocolMapper[];
}
interface KeycloakOrganization {
  name: string;
  alias: string;
  attributes?: Record<string, string[]>;
  domains?: Array<{ name: string; verified: boolean }>;
  members?: Array<{ username: string; membershipType?: string }>;
}
interface RealmSeed {
  realm: string;
  organizationsEnabled?: boolean;
  organizations?: KeycloakOrganization[];
  clients: KeycloakClient[];
  users: Array<{ username: string; attributes?: Record<string, string[]> }>;
}

const PLATFORM_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const SEED_USERNAME = "admin@givernance.org";

const realm = JSON.parse(readFileSync(REALM_JSON_PATH, "utf-8")) as RealmSeed;

describe("Keycloak realm seed (issue #114 — Organizations migration)", () => {
  it("has a top-level `organizations` array", () => {
    expect(Array.isArray(realm.organizations)).toBe(true);
  });

  it("enables Organizations at the realm level", () => {
    expect(realm.organizationsEnabled).toBe(true);
  });

  it("seeds a platform Organization with the canonical org_id attribute", () => {
    const platform = realm.organizations?.find((o) => o.alias === "platform");
    expect(platform, "platform Organization must be seeded").toBeDefined();
    expect(platform?.attributes?.org_id).toEqual([PLATFORM_ORG_ID]);
  });

  it("uses a non-routable domain on the platform Organization", () => {
    // Preventing Home IdP Discovery auto-routing of a real @givernance.org
    // mailbox to the dev-only Organization once a per-tenant IdP is bound
    // (security review finding on PR #139).
    const platform = realm.organizations?.find((o) => o.alias === "platform");
    const domainNames = platform?.domains?.map((d) => d.name) ?? [];
    for (const domain of domainNames) {
      expect(
        domain.endsWith(".invalid") ||
          domain.endsWith(".test") ||
          domain.endsWith(".local") ||
          domain === "platform.givernance.invalid",
        `platform org domain must be non-routable, got: ${domain}`,
      ).toBe(true);
    }
  });

  it("binds the super-admin user to the platform Organization as UNMANAGED", () => {
    const platform = realm.organizations?.find((o) => o.alias === "platform");
    const admin = platform?.members?.find((m) => m.username === SEED_USERNAME);
    expect(admin, "admin user must be a platform org member").toBeDefined();
    expect(admin?.membershipType).toBe("UNMANAGED");
  });

  it("adds the organization membership mapper on givernance-web", () => {
    const client = realm.clients.find((c) => c.clientId === "givernance-web");
    expect(client).toBeDefined();
    const mapper = client?.protocolMappers?.find(
      (m) => m.protocolMapper === "oidc-organization-membership-mapper",
    );
    expect(mapper, "oidc-organization-membership-mapper must be configured").toBeDefined();
    // Emitting the org id + attributes is what lets downstream read org_id
    // from the nested `organization` claim (docs/21 §2.1.bis target state).
    expect(mapper?.config?.addOrganizationId).toBe("true");
    expect(mapper?.config?.addOrganizationAttributes).toBe("true");
    expect(mapper?.config?.["access.token.claim"]).toBe("true");
  });

  it("puts the organization scope on givernance-web's default scopes", () => {
    // The membership mapper emits nothing unless the `organization` scope is
    // requested; pinning it on default scopes means every token carries the
    // claim without the web app needing to opt in via `scope=organization`.
    const client = realm.clients.find((c) => c.clientId === "givernance-web");
    expect(client?.defaultClientScopes).toContain("organization");
  });

  it("keeps the transitional flat org_id mapper for backward compatibility", () => {
    // Until the API's JWT verifier migrates to read org_id from the nested
    // `organization` claim (follow-up to this PR), the flat claim sourced
    // from the user attribute must keep working — otherwise the seeded
    // super-admin cannot be used by the app.
    const client = realm.clients.find((c) => c.clientId === "givernance-web");
    const orgIdMapper = client?.protocolMappers?.find((m) => m.name === "org_id");
    expect(orgIdMapper?.protocolMapper).toBe("oidc-usermodel-attribute-mapper");
    expect(orgIdMapper?.config?.["claim.name"]).toBe("org_id");
  });

  it("keeps the seeded admin user's org_id attribute aligned with the org attribute", () => {
    const admin = realm.users.find((u) => u.username === SEED_USERNAME);
    expect(admin?.attributes?.org_id).toEqual([PLATFORM_ORG_ID]);
  });

  it("cross-checks user.attributes.org_id === organization.attributes.org_id", () => {
    // Security review finding on PR #139: the transitional design has the
    // flat `org_id` claim sourced from a user attribute while the canonical
    // source of truth is the Organization's attribute. Drift between the two
    // is a silent tenancy-boundary hazard. This test is the CI gate ensuring
    // the two sources stay in lock-step at the realm seed level; the JWT
    // verifier migration to read only from the Organization claim is a
    // follow-up that will remove the user-attribute path entirely.
    const admin = realm.users.find((u) => u.username === SEED_USERNAME);
    const platform = realm.organizations?.find((o) => o.alias === "platform");
    const userOrgId = admin?.attributes?.org_id?.[0];
    const orgOrgId = platform?.attributes?.org_id?.[0];
    expect(userOrgId).toBeDefined();
    expect(orgOrgId).toBeDefined();
    expect(userOrgId).toBe(orgOrgId);
  });
});
