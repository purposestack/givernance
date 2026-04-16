/**
 * RFC 9457 Problem Details for HTTP APIs.
 * Parsed from API error responses with content-type: application/problem+json.
 */
export interface ProblemDetail {
  /** URI reference identifying the problem type. */
  type: string;
  /** Short human-readable summary. */
  title: string;
  /** HTTP status code. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying the specific occurrence. */
  instance?: string;
  /** Extension members (validation errors, etc.). */
  [key: string]: unknown;
}

/**
 * Error class for API responses that follow RFC 9457 Problem Details.
 * Thrown by ApiClient when the API returns a non-2xx response.
 */
export class ApiProblem extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(problem: ProblemDetail) {
    super(problem.detail ?? problem.title);
    this.name = "ApiProblem";
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;

    // Collect extension members (anything not in the standard fields)
    const { type: _t, title: _ti, status: _s, detail: _d, instance: _i, ...extensions } = problem;
    this.extensions = extensions;
  }

  /** Check if this problem matches a specific type URI. */
  is(typeUri: string): boolean {
    return this.type === typeUri;
  }
}

/**
 * Error class for network-level failures (timeout, DNS, offline).
 * Thrown by ApiClient when fetch itself fails (no HTTP response).
 */
export class ApiNetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ApiNetworkError";
  }
}
