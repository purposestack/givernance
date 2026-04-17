import "server-only";

import { cache } from "react";
import { createServerApiClient } from "@/lib/api/client-server";
import { ApiNetworkError, ApiProblem } from "@/lib/api/problem";
import type { OnboardingStep1Input, Tenant } from "@/models/tenant";

/**
 * Tenant service (ADR-011 Layer 2 — server-only service).
 *
 * Wraps the `/v1/tenants/me*` endpoints introduced in #40 PR-A4. Server
 * Components call `getTenantMe()` to gate the (app) layout on completed
 * onboarding; server actions call `saveOnboardingStep1()` /
 * `completeOnboarding()` to persist wizard state.
 */

interface TenantResponse {
  data: Tenant;
}

/**
 * Fetch the current user's tenant.
 *
 * - Returns the tenant on 200.
 * - Returns `null` on 404 (no tenant yet → caller routes to /onboarding).
 * - Returns `null` on 5xx / network errors with a server-side warn log. The
 *   `(app)` layout treats that as "don't know yet" and sends the user to
 *   /onboarding rather than bubbling a server error on every protected page
 *   when the API is briefly unavailable.
 *
 * Wrapped in `React.cache()` so a single server render fetches once even if
 * several components (layout + page) call the helper.
 */
export const getTenantMe = cache(async (): Promise<Tenant | null> => {
  const api = await createServerApiClient();
  try {
    const res = await api.get<TenantResponse>("/v1/tenants/me");
    return res.data;
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) return null;
    if (err instanceof ApiProblem || err instanceof ApiNetworkError) {
      console.warn("[tenant-service] getTenantMe failed:", err.message);
      return null;
    }
    throw err;
  }
});

/** Save Step 1 organisation profile. Creates the tenant on first call, updates thereafter. */
export async function saveOnboardingStep1(input: OnboardingStep1Input): Promise<Tenant> {
  const api = await createServerApiClient();
  const res = await api.post<TenantResponse>("/v1/tenants/me/onboarding", input);
  return res.data;
}

/** Mark the tenant's onboarding as complete. Idempotent. */
export async function completeOnboarding(): Promise<Tenant> {
  const api = await createServerApiClient();
  const res = await api.post<TenantResponse>("/v1/tenants/me/onboarding/complete");
  return res.data;
}
