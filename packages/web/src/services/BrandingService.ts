/**
 * BrandingService — browser-side façade over the org-logo endpoints
 * (Epic #286). Keeps fetch + CSRF + multipart plumbing out of the
 * components, mirroring the OrgPickerService / TenantService patterns.
 *
 * The DELETE on a missing logo is treated as a no-op (404 swallowed) so the
 * "Remove" button stays click-once even if a parallel session already
 * cleared it.
 */

import type { ApiClient } from "@/lib/api";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { OrgLogo, OrgLogoPending } from "@/models/branding";

const PATH = "/v1/branding/org-logo";

export const BrandingService = {
  /**
   * Fetch the current logo (or `null` when none uploaded yet). The API is
   * expected to return 200 with `null` body or 404 — we collapse both into
   * the same null sentinel so callers don't fork on it.
   */
  async getOrgLogo(client: ApiClient = createClientApiClient()): Promise<OrgLogo | null> {
    try {
      // The contract lets the API respond with `null` directly OR a wrapped
      // `{ data: OrgLogo | null }`. We accept both shapes — the wrapped form
      // matches every other Givernance endpoint, but the spec excerpt in the
      // issue body shows the bare object, so we hedge.
      const raw = await client.get<unknown>(PATH);
      return unwrap<OrgLogo>(raw);
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * Upload a new logo. Browser sets the multipart boundary itself once
   * `client.request` notices a `FormData` body and drops the JSON
   * Content-Type — see `lib/api/client.ts`.
   *
   * Returns the freshly-created asset row — `status="pending"` until the
   * worker derives the variants. Type matches the canonical
   * `BrandingAssetResponseSchema` in `@givernance/shared/contracts/branding`.
   */
  async uploadOrgLogo(
    file: File,
    client: ApiClient = createClientApiClient(),
  ): Promise<OrgLogoPending> {
    const fd = new FormData();
    fd.append("file", file);
    const raw = await client.post<unknown>(PATH, fd);
    const unwrapped = unwrap<OrgLogoPending>(raw);
    if (!unwrapped) {
      throw new Error("Logo upload returned an empty response");
    }
    return unwrapped;
  },

  async deleteOrgLogo(client: ApiClient = createClientApiClient()): Promise<void> {
    try {
      await client.delete(PATH);
    } catch (err) {
      // Concurrent removal — already gone is the desired terminal state.
      if (err instanceof ApiProblem && err.status === 404) return;
      throw err;
    }
  },
};

function unwrap<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && raw !== null && "data" in raw) {
    const data = (raw as { data: unknown }).data;
    return (data ?? null) as T | null;
  }
  return raw as T;
}
