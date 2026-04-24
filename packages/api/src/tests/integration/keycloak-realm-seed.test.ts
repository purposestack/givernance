/**
 * Keycloak 26 realm-seed shape validation (issue #114).
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
  it("enables Organizations at the realm level", () => {
    expect(realm.organizationsEnabled).toBe(true);
  });

  it("seeds a platform Organization with the canonical org_id attribute", () => {
    const platform = realm.organizations?.find((o) => o.alias === "platform");
    expect(platform, "platform Organization must be seeded").toBeDefined();
    expect(platform?.attributes?.org_id).toEqual([PLATFORM_ORG_ID]);
  });

  it("binds the super-admin user to the platform Organization", () => {
    const platform = realm.organizations?.find((o) => o.alias === "platform");
    const usernames = platform?.members?.map((m) => m.username) ?? [];
    expect(usernames).toContain(SEED_USERNAME);
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
});
