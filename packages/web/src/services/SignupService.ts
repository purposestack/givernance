/**
 * Browser-side signup service — wraps the public API surface for the
 * self-serve signup flow (issue #109 / ADR-016).
 *
 * These endpoints are anonymous; the requests do NOT carry credentials and
 * MUST NOT rely on CSRF cookies (the public routes are unauthenticated).
 * Lazily pick a separate fetch path so `credentials: 'include'` is not
 * sent on these calls.
 */

import { ApiProblem } from "@/lib/api/problem";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export interface SignupPayload {
  orgName: string;
  slug: string;
  firstName: string;
  lastName: string;
  email: string;
  country?: string;
  captchaToken?: string;
}

export interface SignupSuccess {
  tenantId: string;
  email: string;
}

export interface TenantLookupResult {
  hasExistingTenant: boolean;
  hint: "contact_admin" | "create_new";
}

export interface VerifySuccess {
  tenantId: string;
  userId: string;
  slug: string;
  provisionalUntil: string;
}

export type SignupFailure =
  | { kind: "slug_taken" }
  | { kind: "email_in_use" }
  | { kind: "invalid_slug" }
  | { kind: "captcha" }
  | { kind: "rate_limited" }
  | { kind: "network" };

async function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  // No `credentials: "include"` — these endpoints must not attach cookies.
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export async function submitSignup(
  payload: SignupPayload,
): Promise<{ ok: true; data: SignupSuccess } | { ok: false; error: SignupFailure }> {
  let res: Response;
  try {
    res = await publicFetch("/v1/public/signup", {
      method: "POST",
      headers: payload.captchaToken ? { "x-captcha-token": payload.captchaToken } : {},
      body: JSON.stringify({
        orgName: payload.orgName,
        slug: payload.slug,
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        country: payload.country,
      }),
    });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }

  if (res.status === 201) {
    const json = (await res.json()) as { data: SignupSuccess };
    return { ok: true, data: json.data };
  }

  if (res.status === 400) return { ok: false, error: { kind: "captcha" } };
  if (res.status === 429) return { ok: false, error: { kind: "rate_limited" } };
  if (res.status === 422) return { ok: false, error: { kind: "invalid_slug" } };
  // The API collapses slug_taken + email_in_use to a single 409 for anti-
  // enumeration reasons. From the UI side, the friendliest we can do is tell
  // the user "could not complete". If you enter an obviously-taken slug the
  // debounced lookup catches it earlier; this is the fallback.
  if (res.status === 409) return { ok: false, error: { kind: "slug_taken" } };

  return { ok: false, error: { kind: "network" } };
}

export async function resendVerification(email: string): Promise<void> {
  try {
    await publicFetch("/v1/public/signup/resend", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  } catch {
    // Silently swallow — the API is always 204 regardless of the request
    // shape; a network failure should not surface as an error either.
  }
}

export async function verifySignup(
  token: string,
  firstName: string,
  lastName: string,
): Promise<{ ok: true; data: VerifySuccess } | { ok: false; status: number; detail?: string }> {
  let res: Response;
  try {
    res = await publicFetch("/v1/public/signup/verify", {
      method: "POST",
      body: JSON.stringify({ token, firstName, lastName }),
    });
  } catch {
    return { ok: false, status: 0 };
  }

  if (res.status === 201) {
    const json = (await res.json()) as { data: VerifySuccess };
    return { ok: true, data: json.data };
  }

  let detail: string | undefined;
  try {
    const problem = (await res.json()) as { detail?: string };
    detail = problem.detail;
  } catch {
    // no body
  }
  return { ok: false, status: res.status, detail };
}

export async function lookupTenant(email: string): Promise<TenantLookupResult | null> {
  try {
    const res = await publicFetch(`/v1/public/tenants/lookup?email=${encodeURIComponent(email)}`, {
      method: "GET",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: TenantLookupResult };
    return json.data;
  } catch {
    return null;
  }
}

/** Expose `ApiProblem` so callers can do `instanceof` checks when integrating into react-query later. */
export { ApiProblem };
