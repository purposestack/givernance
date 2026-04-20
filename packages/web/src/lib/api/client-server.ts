import "server-only";

import { cookies } from "next/headers";
import { ApiClient } from "./client";

/**
 * Create an ApiClient for use in React Server Components and Route Handlers.
 *
 * - Reads the JWT from httpOnly cookies via `cookies()` (Next.js headers API)
 * - Uses API_URL for the internal API URL (container-to-container or localhost per ADR-011)
 * - Not cached — creates a fresh client per request to pick up fresh cookies
 */
export async function createServerApiClient(): Promise<ApiClient> {
  const cookieStore = await cookies();
  const token = cookieStore.get("givernance_jwt")?.value;

  return new ApiClient({
    baseUrl: process.env.API_URL ?? "http://127.0.0.1:4000",
    defaultHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}
