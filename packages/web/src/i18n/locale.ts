"use server";

import { cookies } from "next/headers";

/**
 * Set the active locale via NEXT_LOCALE cookie.
 * Called from client-side locale switcher.
 * The page must be refreshed (router.refresh()) after calling this.
 */
export async function setLocale(locale: string) {
  const store = await cookies();
  store.set("NEXT_LOCALE", locale, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
}
