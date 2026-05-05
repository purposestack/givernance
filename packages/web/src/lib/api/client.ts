import type { ProblemDetail } from "./problem";
import { ApiNetworkError, ApiProblem } from "./problem";

/** HTTP methods supported by the API client. */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Options for an individual API request. */
export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Query parameters appended to the URL. */
  params?: Record<string, string | number | boolean | undefined>;
}

/** Configuration for the ApiClient factory. */
export interface ApiClientConfig {
  /** Base URL for the API (e.g. http://localhost:3001 or /api). */
  baseUrl: string;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Fetch implementation (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

/**
 * Typed fetch wrapper for the Givernance REST API (ADR-011 Layer 1).
 *
 * - Parses RFC 9457 Problem Details on error responses
 * - Appends query params, merges headers
 * - Returns typed JSON responses
 *
 * Instantiated via `createServerApiClient()` or `createClientApiClient()`.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(config: ApiClientConfig) {
    // Strip trailing slash for consistent URL joining
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // `Content-Type: application/json` is set conditionally per-request
    // (only when a body is present) — Fastify's content-type parser rejects
    // requests that advertise JSON but send no body (e.g. bodiless DELETE
    // / resend POSTs) with a 400. Keeping it out of the defaults avoids
    // the silent breakage that surfaced on PR #154's resend / revoke flows.
    this.defaultHeaders = {
      Accept: "application/json",
      ...config.defaultHeaders,
    };
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, body, options);
  }

  async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, body, options);
  }

  async delete<T = void>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, undefined, options);
  }

  /**
   * Resolve a relative API path to the absolute browser-resolvable URL the
   * client would fetch. Use this for callers that need the URL itself
   * rather than the parsed JSON body — e.g. `window.open` for a streamed
   * file download. Mirrors `buildUrl` so the configured `baseUrl` (and
   * its `NEXT_PUBLIC_API_URL` override) is the single source of truth;
   * components must not hardcode `/api` themselves (issue #214 review).
   */
  resolveBrowserUrl(path: string): string {
    return this.buildUrl(path);
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    body: unknown | undefined,
    options?: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, options?.params);
    // FormData uploads must let the browser set `Content-Type: multipart/...`
    // itself so the boundary parameter matches the body — pinning JSON here
    // would cause Fastify's multipart plugin to 415 the request. Detect the
    // FormData case before merging headers so neither the default
    // `application/json` nor a stale caller override survives (Epic #286).
    const isFormData = isFormDataBody(body);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(body !== undefined && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    };
    if (isFormData) {
      // Defensive: a caller-provided `Content-Type` would still bypass the
      // browser's auto-boundary. Strip it explicitly.
      delete headers["Content-Type"];
      delete headers["content-type"];
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: resolveRequestBody(body, isFormData),
        signal: options?.signal,
      });
    } catch (err) {
      throw new ApiNetworkError(`Network error: ${method} ${path}`, err);
    }

    if (!response.ok) {
      await this.handleErrorResponse(response, method, path);
    }

    // 204 No Content — return undefined as T
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    // Server-side always receives an absolute URL (API_URL). Browser-side may
    // receive a relative path (/api) — resolve it against the current origin.
    const base =
      this.baseUrl.startsWith("http://") || this.baseUrl.startsWith("https://")
        ? this.baseUrl
        : `${window.location.origin}${this.baseUrl}`;

    // Strip a leading slash from `path` so the URL constructor resolves it
    // relative to `base` (which may include a base path like `/api`).
    // `new URL("/v1/…", "http://host/api/")` otherwise drops `/api` because
    // an absolute path resolves against the origin, not the base URL's path.
    const relativePath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(relativePath, `${base}/`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async handleErrorResponse(
    response: Response,
    method: string,
    path: string,
  ): Promise<never> {
    const contentType = response.headers.get("content-type") ?? "";

    if (
      contentType.includes("application/problem+json") ||
      contentType.includes("application/json")
    ) {
      try {
        const problem = (await response.json()) as ProblemDetail;
        if (problem.type && problem.title && problem.status) {
          throw new ApiProblem(problem);
        }
      } catch (err) {
        if (err instanceof ApiProblem) throw err;
        // Fall through to generic error if JSON parsing fails
      }
    }

    throw new ApiProblem({
      type: "about:blank",
      title: response.statusText || "Request failed",
      status: response.status,
      detail: `${method} ${path} returned ${response.status}`,
    });
  }
}

/**
 * Detect a FormData body so the multipart code path keeps boundaries intact.
 * `FormData` is a global in both Node 22 (web-fetch) and the browser, but we
 * still hedge with `typeof` so an unexpected runtime (a hypothetical edge
 * function without `FormData`) degrades to JSON serialisation rather than
 * throwing on the type guard.
 */
function isFormDataBody(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function resolveRequestBody(body: unknown, isFormData: boolean): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (isFormData) return body as FormData;
  return JSON.stringify(body);
}
