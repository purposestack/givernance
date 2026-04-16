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
    this.defaultHeaders = {
      "Content-Type": "application/json",
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

  private async request<T>(
    method: HttpMethod,
    path: string,
    body: unknown | undefined,
    options?: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, options?.params);
    const headers = { ...this.defaultHeaders, ...options?.headers };

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
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
    // Support both absolute URLs (server-side) and relative paths (browser-side)
    const base =
      this.baseUrl.startsWith("http://") || this.baseUrl.startsWith("https://")
        ? this.baseUrl
        : typeof window !== "undefined"
          ? `${window.location.origin}${this.baseUrl}`
          : `http://localhost:3000${this.baseUrl}`;

    const url = new URL(path, `${base}/`);
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
