/**
 * Minimal Keycloak Admin client for the worker — Epic #286.
 *
 * The full-featured admin client (with circuit breaker, retry, in-flight
 * dedup) lives in `packages/api/src/lib/keycloak-admin.ts`. The worker
 * only needs the `updateOrganization` GET-then-PUT pattern for the
 * `keycloak.sync_org_logo` job, so we reproduce a small slice here
 * rather than:
 *   - Importing from `packages/api/*` (breaks the worker → api
 *     dependency direction).
 *   - Hoisting to `packages/shared/*` (would pull `node:*` deps into
 *     a package the web bundle imports — ADR-013 violation).
 *
 * Behaviour parity with the api copy: token cache with safety margin,
 * GET-then-PUT for attribute merges, idempotent on 404.
 *
 * ⚠ LOCKSTEP FORK — ADR-039. Behavioural changes (token handling, retry
 * shape, error mapping) made here or in the api copy MUST be mirrored in
 * the counterpart, or the PR must state why the copies may diverge.
 * Extraction into `@givernance/keycloak-admin` becomes MANDATORY when a
 * third consumer lands OR a second two-file KC fix occurs — see
 * docs/adrs/adr-039-keycloak-admin-client-fork-extraction-trigger.md.
 */

import { assertSafeOrgAttributes } from "@givernance/shared/constants";
import { env } from "../env.js";
import { logger } from "./logger.js";

interface KeycloakOrganization {
  id: string;
  name: string;
  alias: string;
  attributes?: Record<string, string[]>;
  domains?: Array<{ name: string; verified: boolean }>;
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token is considered stale (with 30s margin). */
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

function adminBaseUrl(): string {
  const candidate = env.KEYCLOAK_ADMIN_URL ?? env.KEYCLOAK_INTERNAL_URL ?? env.KEYCLOAK_URL;
  if (!candidate) {
    throw new Error(
      "KEYCLOAK_URL / KEYCLOAK_ADMIN_URL not configured — cannot call the KC Admin API from the worker",
    );
  }
  return candidate;
}

function adminPath(path: string): string {
  return `${adminBaseUrl()}/admin/realms/${env.KEYCLOAK_REALM}${path}`;
}

async function fetchToken(): Promise<string> {
  if (!env.KEYCLOAK_ADMIN_CLIENT_SECRET) {
    throw new Error(
      "KEYCLOAK_ADMIN_CLIENT_SECRET not set — worker cannot authenticate to KC Admin API",
    );
  }
  const url = `${adminBaseUrl()}/realms/${env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.KEYCLOAK_ADMIN_CLIENT_ID,
    client_secret: env.KEYCLOAK_ADMIN_CLIENT_SECRET,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`KC token endpoint returned ${res.status}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + Math.max(json.expires_in * 1000 - 30_000, 1_000),
  };
  return json.access_token;
}

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
    return cachedToken.accessToken;
  }
  return fetchToken();
}

async function adminRequest<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const token = await getToken();
  const res = await fetch(adminPath(path), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  // 401 once → token rotation, retry with a fresh token.
  if (res.status === 401) {
    cachedToken = null;
    const retryToken = await getToken();
    const retry = await fetch(adminPath(path), {
      method,
      headers: {
        Authorization: `Bearer ${retryToken}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (retry.status === 404) return null;
    if (!retry.ok) {
      throw new Error(`KC admin ${method} ${path} → ${retry.status}`);
    }
    if (retry.status === 204 || retry.headers.get("content-length") === "0") {
      return null as T;
    }
    return (await retry.json()) as T;
  }
  if (!res.ok) {
    throw new Error(`KC admin ${method} ${path} → ${res.status}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return null as T;
  }
  return (await res.json()) as T;
}

const e = encodeURIComponent;

/**
 * Fetch an organization's current shape. Returns null on 404 so callers
 * can degrade gracefully on a tenant that was deleted out from under them.
 */
export async function getOrganization(id: string): Promise<KeycloakOrganization | null> {
  return adminRequest<KeycloakOrganization>("GET", `/organizations/${e(id)}`);
}

// F2 — Allowlist + guard sourced from `@givernance/shared/constants` so the
// api and worker copies of this guard cannot drift apart.

/**
 * Merge attributes onto an organization via GET-then-PUT. Identical
 * semantics to `KeycloakAdminClient.updateOrganization` in the api
 * package — see that file for the security rationale.
 *
 * Returns `changed: false` when every updated attribute already held
 * the requested value (the PUT is still issued — idempotence stays the
 * safety contract; the flag only tells the caller whether this call
 * was a first write or an at-least-once re-delivery, so observability
 * emissions can be gated on real transitions — issue #290 review).
 */
export async function updateOrganization(
  id: string,
  updates: { attributes?: Record<string, string[]> },
): Promise<{ changed: boolean }> {
  assertSafeOrgAttributes(updates.attributes);
  const current = await getOrganization(id);
  if (!current) {
    logger.warn(
      { keycloakOrgId: id },
      "KC org missing — skipping updateOrganization (tenant may have been deleted)",
    );
    return { changed: false };
  }
  const changed = Object.entries(updates.attributes ?? {}).some(
    ([key, value]) => JSON.stringify(current.attributes?.[key] ?? []) !== JSON.stringify(value),
  );
  const mergedAttributes = updates.attributes
    ? { ...(current.attributes ?? {}), ...updates.attributes }
    : current.attributes;
  await adminRequest<void>("PUT", `/organizations/${e(id)}`, {
    ...current,
    attributes: mergedAttributes,
  });
  return { changed };
}
