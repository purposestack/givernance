"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { SearchInput } from "@/components/shared/search-input";
import { Checkbox } from "@/components/ui/checkbox";
import { useDebounced } from "@/lib/hooks/use-debounced";

interface Props {
  /** Initial value of `?q=` (server-rendered into the input). */
  initialQ: string;
  /** Initial value of `?includeDeleted=` (server-rendered into the toggle). */
  initialIncludeDeleted: boolean;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Filter bar above the platform-admin list (issue #260). Owns two
 * URL-synced controls:
 *
 *  - `q`            — case-insensitive substring search across
 *                     first / last name + email (API does the matching).
 *  - `includeDeleted` — when true, soft-deleted rows are returned and
 *                     the table renders a distinct "offboarded" badge.
 *
 * Pattern matches `PlatformAdminsTable.onSortingChange` (issue #217):
 *   - URL is the source of truth — typing or toggling rewrites
 *     `?q=` / `?includeDeleted=` via `router.replace` (NOT `push`),
 *     so the back button escapes the page in one press instead of
 *     unwinding every keystroke.
 *   - The component is wrapped in a transition so the server-side
 *     refetch doesn't block input.
 *   - Debounced 250 ms — same trailing-edge primitive as the
 *     impersonation picker (`useDebounced` in `lib/hooks`).
 *
 * Sort params on the URL are preserved verbatim. Pagination params
 * (limit/offset) are NOT — changing the filter resets the listing
 * back to the first page, matching tenant-list semantics. The list
 * page caps at `limit=200` server-side until pagination UI lands
 * (ADR-018, separate concern).
 */
export function PlatformAdminsFilters({ initialQ, initialIncludeDeleted }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("admin.platformAdmins.list.filters");
  const [, startTransition] = useTransition();

  const [q, setQ] = useState(initialQ);
  const [includeDeleted, setIncludeDeleted] = useState(initialIncludeDeleted);
  const debouncedQ = useDebounced(q, SEARCH_DEBOUNCE_MS);
  // The mount tick of the debounce effect runs with `debouncedQ ===
  // initialQ`, which would otherwise rewrite the URL with the very
  // params it was built from — harmless on a clean URL, but it
  // re-frames the back stack on `?q=ada` deep-links and triggers a
  // pointless server refetch. Skip the first effect tick.
  const isFirstRender = useRef(true);

  // Stabilise `useSearchParams()` for the effect dep list. Next.js
  // returns a new `URLSearchParams` instance on every render, which
  // breaks `Object.is` reference equality and would re-trigger any
  // effect that depended on it on every render — feedback loop in
  // tests (where `router.replace` is mocked and doesn't update
  // searchParams, so each render gets a fresh instance, which
  // re-fires the effect, which calls replace, which re-renders…).
  // The string serialisation IS stable across renders when the URL
  // hasn't changed.
  const searchParamsString = searchParams.toString();

  const writeUrl = useCallback(
    (nextQ: string, nextIncludeDeleted: boolean) => {
      const params = new URLSearchParams(searchParamsString);
      // `q` is omitted when empty so a cleared search rewrites a clean
      // URL bar (`?sort=…&order=…` instead of `?q=&sort=…&order=…`).
      if (nextQ.trim().length === 0) {
        params.delete("q");
      } else {
        params.set("q", nextQ.trim());
      }
      if (nextIncludeDeleted) {
        params.set("includeDeleted", "true");
      } else {
        params.delete("includeDeleted");
      }
      // Filter changes drop pagination — the user expects to see
      // results from the start, not be stuck on page 4 of the prior
      // listing. (Pagination UI itself is deferred per ADR-018.)
      params.delete("offset");

      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParamsString],
  );

  // One effect drives BOTH controls. `debouncedQ` updates 250 ms after
  // the last keystroke; `includeDeleted` updates synchronously on
  // toggle. Either change → URL rewrite. The `isFirstRender` ref
  // suppresses the mount tick so a server-rendered initial state
  // doesn't re-write itself.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    writeUrl(debouncedQ, includeDeleted);
  }, [debouncedQ, includeDeleted, writeUrl]);

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="min-w-[260px] flex-1 max-w-md">
        <label htmlFor="platform-admins-search" className="sr-only">
          {t("searchLabel")}
        </label>
        <SearchInput
          id="platform-admins-search"
          value={q}
          placeholder={t("searchPlaceholder")}
          onChange={(e) => setQ(e.currentTarget.value)}
          onClear={() => {
            // Skip the debounce — clearing is intentful, fire the URL
            // rewrite ahead of the next debounce tick so the table
            // refetches immediately. The effect above will no-op when
            // it eventually runs (debouncedQ catches up to "" anyway).
            setQ("");
            writeUrl("", includeDeleted);
          }}
        />
      </div>
      <label
        htmlFor="platform-admins-include-deleted"
        className="flex items-center gap-2 text-sm text-on-surface"
      >
        <Checkbox
          id="platform-admins-include-deleted"
          checked={includeDeleted}
          onCheckedChange={(next) => setIncludeDeleted(next === true)}
        />
        <span>{t("includeDeletedLabel")}</span>
      </label>
    </div>
  );
}
