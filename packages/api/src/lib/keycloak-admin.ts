/**
 * Keycloak Admin API client — issue #107 / ADR-016.
 *
 * Thin, typed wrapper around the Keycloak Admin REST API for the operations
 * the Givernance API needs to perform during tenant onboarding:
 *
 *  - Organizations (Keycloak 26+): create, get, delete, add domain.
 *  - Identity Providers: create, bind to Organization.
 *  - Members: attach, invite.
 *
 * Cross-cutting behaviour:
 *  - `client_credentials` access-token caching with early-refresh safety
 *    margin, in-flight deduplication so parallel callers don't stampede.
 *  - Conservative retry policy: 5xx / 429 / network errors retried on
 *    idempotent methods (GET, PUT, DELETE). **POST is retried only on
 *    429 or token rotation (401 once)**, never on 5xx, to avoid duplicate
 *    side-effects (e.g. two invitation emails).
 *  - Circuit breaker: opens for 30s after N consecutive 5xx / network
 *    failures, re-arms on a failed half-open probe. Client 4xx errors
 *    (400, 403, 404) do NOT count toward the breaker.
 *  - Structured pino logging on every request with latency + status code;
 *    `Authorization` and `client_secret` are redacted at the logger level.
 *
 * Security notes:
 *  - All path parameters are `encodeURIComponent`-encoded.
 *  - `addOrgDomain` takes `verified: boolean` explicitly; callers MUST pass
 *    `verified: true` only after out-of-band DNS TXT verification (ADR-016).
 *  - `createOrganization` recovers from empty 201 bodies via the `Location`
 *    header (not alias search) so concurrent create/race can't hand back
 *    someone else's org.
 *
 * Organization-specific endpoints are Keycloak 26+; they are exercised by
 * stubbed-fetch unit tests in `keycloak-admin.test.ts`. The real e2e smoke
 * test ships with issue #114 once the realm is upgraded.
 */

import pino from "pino";
import { env } from "../env.js";

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = pino({
  name: "keycloak-admin",
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "*.headers.authorization",
      "*.headers.Authorization",
      "*.body.client_secret",
      "accessToken",
      "*.accessToken",
    ],
    censor: "[REDACTED]",
  },
});

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

export interface BindIdpInput {
  alias: string;
}

export class KeycloakAdminError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Path relative to the realm admin base (never the full URL with baseUrl). */
    public readonly path: string,
  ) {
    super(message);
    this.name = "KeycloakAdminError";
  }
}

/** Thrown on non-retryable errors at the token endpoint (bad secret, 403, etc.) */
export class KeycloakAuthError extends KeycloakAdminError {
  constructor(status: number, path: string) {
    super(`Token endpoint returned ${status}`, status, path);
    this.name = "KeycloakAuthError";
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
  /** Injectable random for deterministic backoff in tests. Default: `Math.random`. */
  randomImpl?: () => number;
  /** Failures required before the breaker opens (default 5). */
  circuitFailureThreshold?: number;
  /** Milliseconds the breaker stays open before entering half-open (default 30_000). */
  circuitOpenMs?: number;
  /** Max retry attempts on transient failures (default 3). */
  maxAttempts?: number;
  /** Initial backoff in ms (default 200). Exponential: 200, 400, 800, …, capped at `maxBackoffMs`. */
  initialBackoffMs?: number;
  /** Hard cap on any single backoff window (default 10_000). */
  maxBackoffMs?: number;
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
  /**
   * Add a domain to an Organization.
   * @param verified   Only pass `true` after out-of-band DNS TXT verification (ADR-016 §DNS TXT).
   */
  addOrgDomain(orgId: string, domain: string, opts: { verified: boolean }): Promise<void>;
  attachUserToOrg(orgId: string, userId: string): Promise<void>;
  sendInvitation(orgId: string, email: string): Promise<void>;
  bindIdpToOrganization(orgId: string, input: BindIdpInput): Promise<void>;

  // Identity Providers (KC 24+)
  createIdentityProvider(idp: KeycloakIdentityProvider): Promise<void>;
  deleteIdentityProvider(alias: string): Promise<void>;

  // Test hooks
  _circuitState(): "closed" | "open" | "half-open";
}

/**
 * Create a Keycloak Admin API client. Factory style (not a singleton) so tests
 * can instantiate isolated clients with injected fetch + clock + random.
 */
export function createKeycloakAdminClient(config: ClientConfig): KeycloakAdminClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.nowMs ?? (() => Date.now());
  const random = config.randomImpl ?? (() => Math.random());
  const failureThreshold = config.circuitFailureThreshold ?? 5;
  const openMs = config.circuitOpenMs ?? 30_000;
  const maxAttempts = config.maxAttempts ?? 3;
  const initialBackoffMs = config.initialBackoffMs ?? 200;
  const maxBackoffMs = config.maxBackoffMs ?? 10_000;

  let cachedToken: CachedToken | null = null;
  let inFlightToken: Promise<string> | null = null;
  let consecutiveFailures = 0;
  let circuitOpenedAtMs: number | null = null;
  let halfOpenInFlight = false;

  // ─── Circuit breaker helpers ────────────────────────────────────────────

  const circuitState = (): "closed" | "open" | "half-open" => {
    if (circuitOpenedAtMs === null) return "closed";
    if (now() - circuitOpenedAtMs >= openMs) return "half-open";
    return "open";
  };

  const recordSuccess = () => {
    consecutiveFailures = 0;
    circuitOpenedAtMs = null;
    halfOpenInFlight = false;
  };

  /**
   * Record a breaker-counting failure. Called only for 5xx / network failures,
   * not for client 4xx errors. Transitions to "open" on threshold, and
   * re-arms the timer on a failed half-open probe.
   */
  const recordBreakerFailure = () => {
    const wasHalfOpen = circuitState() === "half-open";
    consecutiveFailures += 1;
    if (wasHalfOpen) {
      // Failed probe — re-arm timer so we stay in `open`, not stuck `half-open`.
      circuitOpenedAtMs = now();
      halfOpenInFlight = false;
      logger.warn({ consecutiveFailures }, "Keycloak admin half-open probe failed");
      return;
    }
    if (consecutiveFailures >= failureThreshold && circuitOpenedAtMs === null) {
      circuitOpenedAtMs = now();
      logger.warn({ consecutiveFailures }, "Keycloak admin circuit opened");
    }
  };

  // ─── Token cache ────────────────────────────────────────────────────────

  const fetchToken = async (): Promise<string> => {
    const path = `/realms/${config.realm}/protocol/openid-connect/token`;
    const url = `${config.baseUrl}${path}`;
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
      // 403 / 401 at the token endpoint = bad secret, not a rotation issue.
      throw new KeycloakAuthError(res.status, path);
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
    // In-flight dedup: parallel callers share a single `/token` request.
    if (!inFlightToken) {
      inFlightToken = fetchToken().finally(() => {
        inFlightToken = null;
      });
    }
    return inFlightToken;
  };

  // ─── Core request with retry + CB ──────────────────────────────────────

  /**
   * `POST` is only retried on 429 or 401-one-shot. `GET`/`PUT`/`DELETE` are
   * retried on any transient error.
   */
  const isRetryableAdminStatus = (status: number, method: string): boolean => {
    if (status === 401) return true; // token rotated — retry once with fresh token
    if (status === 429) return true;
    if (status >= 500 && status < 600) {
      return method !== "POST"; // don't retry non-idempotent writes on 5xx
    }
    return false;
  };

  const isRetryable = (err: unknown, method: string): boolean => {
    // Malformed JSON on a 200 — not transient.
    if (err instanceof SyntaxError) return false;
    // Bad client secret — don't loop.
    if (err instanceof KeycloakAuthError) return false;
    if (err instanceof KeycloakAdminError) {
      return isRetryableAdminStatus(err.status, method);
    }
    // Network / fetch abort / DNS — retry idempotent methods only.
    return method !== "POST";
  };

  const countsTowardBreaker = (err: unknown): boolean => {
    if (err instanceof KeycloakAdminError) {
      return err.status >= 500 && err.status < 600;
    }
    return true; // network/DNS/abort count
  };

  type AttemptOutcome<U> = { result: { value: U | null } } | { err: unknown };

  const interpretResponse = async <U>(
    method: string,
    path: string,
    res: Response,
  ): Promise<AttemptOutcome<U>> => {
    if (res.status === 401) {
      cachedToken = null;
      return { err: new KeycloakAdminError("Unauthorized (token rotated)", 401, path) };
    }
    if (res.status === 201) {
      // Honor the Location header for POST-create recovery.
      const location = res.headers.get("location");
      if (location) {
        return { result: { value: { __locationHeader: location } as unknown as U } };
      }
    }
    if (!res.ok) {
      return {
        err: new KeycloakAdminError(
          `Admin API ${method} ${path} → ${res.status}`,
          res.status,
          path,
        ),
      };
    }
    if (res.status === 204) {
      return { result: { value: null } };
    }
    const text = await res.text();
    return { result: { value: text ? (JSON.parse(text) as U) : null } };
  };

  const runAttempt = async <U>(
    method: string,
    url: string,
    path: string,
    body: unknown,
    attempt: number,
  ): Promise<AttemptOutcome<U>> => {
    try {
      // If the token endpoint rejects our credentials (bad secret), it
      // throws KeycloakAuthError which is non-retryable — that's the
      // "bad config" path. A 401 on the admin API, by contrast, means
      // the token we just sent was rejected mid-session (rotation); we
      // invalidate the cache and retry.
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
      logger.debug({ method, path, status: res.status, latencyMs, attempt }, "kc-admin");

      return await interpretResponse<U>(method, path, res);
    } catch (thrown) {
      if (thrown instanceof CircuitOpenError) {
        halfOpenInFlight = false;
        throw thrown;
      }
      return { err: thrown };
    }
  };

  const guardCircuit = (): "open" | "half-open" | "closed" => {
    const state = circuitState();
    if (state === "open") {
      throw new CircuitOpenError();
    }
    if (state === "half-open") {
      if (halfOpenInFlight) throw new CircuitOpenError();
      halfOpenInFlight = true;
    }
    return state;
  };

  const computeBackoffMs = (attempt: number): number => {
    // Exponential backoff with equal jitter + hard cap.
    const baseDelay = Math.min(initialBackoffMs * 2 ** (attempt - 1), maxBackoffMs);
    const half = baseDelay / 2;
    return Math.floor(half + random() * half);
  };

  const handleTerminalError = (err: unknown, state: "open" | "half-open" | "closed"): void => {
    if (countsTowardBreaker(err)) {
      recordBreakerFailure();
    } else if (state === "half-open") {
      // Non-breaker-counting 4xx during half-open probe: still release the
      // slot but don't re-arm the timer. Leave the decision to the next caller.
      halfOpenInFlight = false;
    }
  };

  const adminRequest = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> => {
    const state = guardCircuit();
    const url = `${config.baseUrl}/admin/realms/${config.realm}${path}`;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      const outcome = await runAttempt<T>(method, url, path, body, attempt);

      if ("result" in outcome) {
        recordSuccess();
        return outcome.result.value;
      }

      lastErr = outcome.err;
      if (!isRetryable(outcome.err, method) || attempt >= maxAttempts) {
        handleTerminalError(outcome.err, state);
        throw outcome.err;
      }

      await new Promise((r) => setTimeout(r, computeBackoffMs(attempt)));
    }

    if (countsTowardBreaker(lastErr)) {
      recordBreakerFailure();
    }
    throw lastErr ?? new Error("unreachable");
  };

  // ─── Helpers for path encoding ─────────────────────────────────────────

  const e = encodeURIComponent;

  // ─── Public surface ────────────────────────────────────────────────────

  return {
    createOrganization: async ({ name, alias, attributes }) => {
      const out = await adminRequest<KeycloakOrganization & { __locationHeader?: string }>(
        "POST",
        `/organizations`,
        { name, alias, attributes: attributes ?? {} },
      );
      if (!out) {
        throw new KeycloakAdminError(
          `Organization create returned no body and no Location header`,
          500,
          `/organizations`,
        );
      }
      if (out.__locationHeader) {
        // Extract the org id from the Location header and GET it by id — never search by alias.
        const idMatch = out.__locationHeader.match(/\/organizations\/([^/]+)$/);
        const id = idMatch?.[1];
        if (!id) {
          throw new KeycloakAdminError(
            `Organization create Location header malformed: ${out.__locationHeader}`,
            500,
            `/organizations`,
          );
        }
        const fetched = await adminRequest<KeycloakOrganization>("GET", `/organizations/${e(id)}`);
        if (!fetched) {
          throw new KeycloakAdminError(
            `Organization ${id} missing after create`,
            500,
            `/organizations/${id}`,
          );
        }
        return fetched;
      }
      return out;
    },

    getOrganization: async (id) => {
      try {
        return await adminRequest<KeycloakOrganization>("GET", `/organizations/${e(id)}`);
      } catch (err) {
        if (err instanceof KeycloakAdminError && err.status === 404) return null;
        throw err;
      }
    },

    deleteOrganization: async (id) => {
      await adminRequest<void>("DELETE", `/organizations/${e(id)}`);
    },

    addOrgDomain: async (orgId, domain, { verified }) => {
      await adminRequest<void>("POST", `/organizations/${e(orgId)}/domains`, {
        name: domain.toLowerCase(),
        verified,
      });
    },

    attachUserToOrg: async (orgId, userId) => {
      await adminRequest<void>("POST", `/organizations/${e(orgId)}/members`, { id: userId });
    },

    sendInvitation: async (orgId, email) => {
      await adminRequest<void>("POST", `/organizations/${e(orgId)}/members/invite-user`, { email });
    },

    bindIdpToOrganization: async (orgId, { alias }) => {
      await adminRequest<void>("POST", `/organizations/${e(orgId)}/identity-providers`, { alias });
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
      await adminRequest<void>("DELETE", `/identity-provider/instances/${e(alias)}`);
    },

    _circuitState: circuitState,
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

/** Test helper — resets the module-level singleton + token cache. */
export function _resetKeycloakAdminSingleton(): void {
  singleton = null;
}
