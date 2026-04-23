/**
 * Keycloak Admin API client — issue #107 / ADR-016.
 *
 * Thin, typed wrapper around the Keycloak Admin REST API for operations the
 * Givernance API needs to perform on behalf of the platform (tenant
 * onboarding flow):
 *
 *  - Organizations (Keycloak 26+): create, get, delete, add domain.
 *  - Identity Providers: create, bind to Organization.
 *  - Users: lookup by sub, attach to Organization.
 *  - Invitations: send via Organization invite endpoint.
 *
 * Cross-cutting behaviour:
 *  - `client_credentials` access-token caching with early-refresh margin.
 *  - Exponential-backoff retry on transient errors (network + 5xx + 429).
 *  - Circuit breaker: opens for 30s after 5 consecutive failures; while
 *    open, every call fails fast with `CircuitOpenError`.
 *  - Structured pino logging on every request with latency + status code.
 *
 * The client is intentionally minimal. Organization-specific endpoints are
 * Keycloak 26+ and will only reach real infrastructure once issue #114
 * upgrades the realm — until then they are exercised by the stubbed-fetch
 * unit tests in `keycloak-admin.test.ts`.
 */

import pino from "pino";
import { env } from "../env.js";

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = pino({ name: "keycloak-admin", level: env.LOG_LEVEL });

// ─── Public types ────────────────────────────────────────────────────────────

export interface KeycloakOrganization {
  id: string;
  name: string;
  alias: string;
  attributes?: Record<string, string[]>;
  domains?: Array<{ name: string; verified: boolean }>;
}

export interface KeycloakIdentityProvider {
  alias: string;
  providerId: "oidc" | "saml";
  enabled?: boolean;
  config?: Record<string, string>;
}

/** One-of: either a new IdP config, or an existing alias to bind. */
export interface BindIdpInput {
  alias: string;
}

export class KeycloakAdminError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "KeycloakAdminError";
  }
}

export class CircuitOpenError extends Error {
  constructor() {
    super("Keycloak Admin API circuit breaker is open");
    this.name = "CircuitOpenError";
  }
}

// ─── Config + private state ──────────────────────────────────────────────────

interface ClientConfig {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /** Override for tests — default is global fetch. */
  fetchImpl?: typeof fetch;
  /** Current epoch milliseconds — injectable for deterministic tests. */
  nowMs?: () => number;
  /** Failures required before the breaker opens (default 5). */
  circuitFailureThreshold?: number;
  /** Milliseconds the breaker stays open before entering half-open (default 30_000). */
  circuitOpenMs?: number;
  /** Max retry attempts on transient failures (default 3). */
  maxAttempts?: number;
  /** Initial backoff in ms (default 200). Exponential: 200, 400, 800, … */
  initialBackoffMs?: number;
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms at which the token becomes stale (with 30s safety margin). */
  expiresAtMs: number;
}

export interface KeycloakAdminClient {
  // Organizations (KC 26+)
  createOrganization(input: {
    name: string;
    alias: string;
    attributes?: Record<string, string[]>;
  }): Promise<KeycloakOrganization>;
  getOrganization(id: string): Promise<KeycloakOrganization | null>;
  deleteOrganization(id: string): Promise<void>;
  addOrgDomain(orgId: string, domain: string): Promise<void>;
  attachUserToOrg(orgId: string, userId: string): Promise<void>;
  sendInvitation(orgId: string, email: string): Promise<void>;
  bindIdpToOrganization(orgId: string, input: BindIdpInput): Promise<void>;

  // Identity Providers (KC 24+)
  createIdentityProvider(idp: KeycloakIdentityProvider): Promise<void>;
  deleteIdentityProvider(alias: string): Promise<void>;

  // Test hooks
  _circuitState(): "closed" | "open" | "half-open";
  _clearTokenCache(): void;
}

/**
 * Create a Keycloak Admin API client. Factory style (not a singleton) so tests
 * can instantiate isolated clients with injected fetch + clock.
 */
export function createKeycloakAdminClient(config: ClientConfig): KeycloakAdminClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.nowMs ?? (() => Date.now());
  const failureThreshold = config.circuitFailureThreshold ?? 5;
  const openMs = config.circuitOpenMs ?? 30_000;
  const maxAttempts = config.maxAttempts ?? 3;
  const initialBackoffMs = config.initialBackoffMs ?? 200;

  let cachedToken: CachedToken | null = null;
  let consecutiveFailures = 0;
  let circuitOpenedAtMs: number | null = null;

  // ─── Circuit breaker helpers ────────────────────────────────────────────

  const circuitState = (): "closed" | "open" | "half-open" => {
    if (circuitOpenedAtMs === null) return "closed";
    if (now() - circuitOpenedAtMs >= openMs) return "half-open";
    return "open";
  };

  const recordSuccess = () => {
    consecutiveFailures = 0;
    circuitOpenedAtMs = null;
  };

  const recordFailure = () => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) {
      circuitOpenedAtMs = now();
      logger.warn({ consecutiveFailures }, "Keycloak admin circuit opened");
    }
  };

  // ─── Token cache ────────────────────────────────────────────────────────

  const fetchToken = async (): Promise<string> => {
    const url = `${config.baseUrl}/realms/${config.realm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const started = now();
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      throw new KeycloakAdminError(`Token endpoint returned ${res.status}`, res.status, url);
    }

    const tokenRes = (await res.json()) as { access_token: string; expires_in: number };
    const ttlMs = tokenRes.expires_in * 1000;
    const safetyMarginMs = 30_000;
    cachedToken = {
      accessToken: tokenRes.access_token,
      expiresAtMs: now() + Math.max(ttlMs - safetyMarginMs, 1_000),
    };
    logger.debug(
      { latencyMs: now() - started, ttlSec: tokenRes.expires_in },
      "Keycloak admin token refreshed",
    );
    return tokenRes.access_token;
  };

  const getToken = async (): Promise<string> => {
    if (cachedToken && cachedToken.expiresAtMs > now()) {
      return cachedToken.accessToken;
    }
    return fetchToken();
  };

  // ─── Core request with retry + CB ──────────────────────────────────────

  const isRetryable = (err: unknown): boolean => {
    if (err instanceof KeycloakAdminError) {
      // 401: token has probably rotated — retry once with a fresh token.
      // 429: rate-limited.
      // 5xx: transient upstream failure.
      return err.status === 401 || err.status === 429 || (err.status >= 500 && err.status < 600);
    }
    // Network / fetch abort / DNS — assume retryable.
    return true;
  };

  const adminRequest = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> => {
    if (circuitState() === "open") {
      throw new CircuitOpenError();
    }

    const url = `${config.baseUrl}/admin/realms/${config.realm}${path}`;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      let err: unknown;
      let result: { value: T | null } | null = null;

      try {
        const token = await getToken();
        const started = now();
        const res = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const latencyMs = now() - started;
        logger.debug({ method, url, status: res.status, latencyMs, attempt }, "kc-admin");

        // Token probably expired — invalidate + retry once immediately.
        if (res.status === 401) {
          cachedToken = null;
          err = new KeycloakAdminError("Unauthorized", 401, url);
        } else if (!res.ok) {
          err = new KeycloakAdminError(
            `Admin API ${method} ${path} → ${res.status}`,
            res.status,
            url,
          );
        } else {
          if (res.status === 204) {
            result = { value: null };
          } else {
            const text = await res.text();
            result = { value: text ? (JSON.parse(text) as T) : null };
          }
        }
      } catch (thrown) {
        if (thrown instanceof CircuitOpenError) throw thrown;
        err = thrown;
      }

      if (result) {
        recordSuccess();
        return result.value;
      }

      // Error path — decide whether to retry or fail.
      lastErr = err;
      if (!isRetryable(err) || attempt >= maxAttempts) {
        recordFailure();
        throw err;
      }

      // Exponential backoff with full jitter.
      const delay = initialBackoffMs * 2 ** (attempt - 1);
      const jittered = Math.floor(Math.random() * delay);
      await new Promise((r) => setTimeout(r, jittered));
    }

    recordFailure();
    throw lastErr ?? new Error("unreachable");
  };

  // ─── Public surface ────────────────────────────────────────────────────

  return {
    createOrganization: async ({ name, alias, attributes }) => {
      const created = await adminRequest<KeycloakOrganization>("POST", `/organizations`, {
        name,
        alias,
        attributes: attributes ?? {},
      });
      // Keycloak returns 201 + Location; fetch-by-alias to hydrate the id.
      if (created) return created;
      const listed = await adminRequest<KeycloakOrganization[]>(
        "GET",
        `/organizations?search=${encodeURIComponent(alias)}`,
      );
      const match = listed?.find((o) => o.alias === alias);
      if (!match) {
        throw new KeycloakAdminError(
          `Organization '${alias}' not found after create`,
          500,
          "/organizations",
        );
      }
      return match;
    },

    getOrganization: async (id) => {
      try {
        return await adminRequest<KeycloakOrganization>("GET", `/organizations/${id}`);
      } catch (err) {
        if (err instanceof KeycloakAdminError && err.status === 404) return null;
        throw err;
      }
    },

    deleteOrganization: async (id) => {
      await adminRequest<void>("DELETE", `/organizations/${id}`);
    },

    addOrgDomain: async (orgId, domain) => {
      await adminRequest<void>("POST", `/organizations/${orgId}/domains`, {
        name: domain.toLowerCase(),
        verified: true,
      });
    },

    attachUserToOrg: async (orgId, userId) => {
      await adminRequest<void>("POST", `/organizations/${orgId}/members`, { id: userId });
    },

    sendInvitation: async (orgId, email) => {
      await adminRequest<void>("POST", `/organizations/${orgId}/members/invite-user`, {
        email,
      });
    },

    bindIdpToOrganization: async (orgId, { alias }) => {
      await adminRequest<void>("POST", `/organizations/${orgId}/identity-providers`, {
        alias,
      });
    },

    createIdentityProvider: async (idp) => {
      await adminRequest<void>("POST", `/identity-provider/instances`, {
        alias: idp.alias,
        providerId: idp.providerId,
        enabled: idp.enabled ?? true,
        config: idp.config ?? {},
      });
    },

    deleteIdentityProvider: async (alias) => {
      await adminRequest<void>("DELETE", `/identity-provider/instances/${alias}`);
    },

    _circuitState: circuitState,
    _clearTokenCache: () => {
      cachedToken = null;
    },
  };
}

// ─── Default singleton (env-derived) ────────────────────────────────────────

let singleton: KeycloakAdminClient | null = null;

/**
 * Lazy default client bound to the process env. Use this in Fastify route
 * handlers. Tests should instantiate their own via `createKeycloakAdminClient`.
 *
 * Throws if `KEYCLOAK_ADMIN_CLIENT_SECRET` is unset — protects against
 * accidentally trying to call the Admin API in an environment that hasn't
 * been configured for it.
 */
export function keycloakAdmin(): KeycloakAdminClient {
  if (singleton) return singleton;
  if (!env.KEYCLOAK_ADMIN_CLIENT_SECRET) {
    throw new Error(
      "KEYCLOAK_ADMIN_CLIENT_SECRET is not configured — cannot use the Keycloak Admin client.",
    );
  }
  singleton = createKeycloakAdminClient({
    baseUrl: env.KEYCLOAK_ADMIN_URL ?? env.KEYCLOAK_URL,
    realm: env.KEYCLOAK_REALM,
    clientId: env.KEYCLOAK_ADMIN_CLIENT_ID,
    clientSecret: env.KEYCLOAK_ADMIN_CLIENT_SECRET,
  });
  return singleton;
}
