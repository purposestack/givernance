import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/guards";

/**
 * Settings layout — guarded by the application `org_admin` role.
 *
 * The whole `/settings/*` surface (organisation defaults, members,
 * funds, snapshot export) is admin-only: every page issues a request
 * to an `org_admin`-gated endpoint, and a non-admin landing on any of
 * them would crash the SSR render with a 403 from the API. Blocking
 * here is the right architectural layer.
 *
 * Non-admin users get a 404 (not a 403) so the surface is not
 * discoverable via authorisation-error probing — same rationale as
 * `(admin)/layout.tsx`. The sidebar / topbar entries that link here
 * are hidden client-side via `hasAppRole("org_admin")` to avoid
 * dead-end clicks; this guard is the durable enforcement.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  if (!auth.roles.includes("org_admin")) {
    notFound();
  }
  return <>{children}</>;
}
