import "server-only";

import { cookies } from "next/headers";
import { ApiClient } from "./client";

/**
 * Create an ApiClient for use in React Server Components and Route Handlers.
 *
 * - Reads the JWT from httpOnly cookies via `cookies()` (Next.js headers API)
 * - Uses the internal API URL (container-to-container or localhost)
 * - Not cached — creates a fresh client per request to pick up fresh cookies
 */
export async function createServerApiClient(): Promise<ApiClient> {
  const cookieStore = await cookies();
  const token = cookieStore.get("session")?.value;

  return new ApiClient({
    baseUrl: process.env.API_INTERNAL_URL ?? "http://localhost:3001",
    defaultHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}
