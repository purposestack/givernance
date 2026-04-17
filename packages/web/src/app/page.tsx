import { redirect } from "next/navigation";

/**
 * Root route redirects to the authenticated home. The proxy redirects
 * unauthenticated users to /login, so / → /dashboard → /login when signed out.
 */
export default function HomePage() {
  redirect("/dashboard");
}
