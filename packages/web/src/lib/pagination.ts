import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

interface PageInfo {
  page: number;
  total: number;
  totalPages: number;
}

/**
 * Build the URL of the last page when `pagination.page` overshoots it,
 * preserving every other search param (filters, sort, the sibling table's
 * paginator…). Returns `null` when the requested page is reachable or the
 * list is genuinely empty (the empty state is the right answer there).
 */
export function lastPageHref(
  pathname: string,
  params: SearchParams,
  pagination: PageInfo,
  pageParam = "page",
): string | null {
  if (pagination.total <= 0 || pagination.totalPages < 1) return null;
  if (pagination.page <= pagination.totalPages) return null;

  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === pageParam || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) next.append(key, v);
  }
  next.set(pageParam, String(pagination.totalPages));
  return `${pathname}?${next.toString()}`;
}

/**
 * Server-component guard for paginated list pages (issue #614): a page past
 * the last one (stale bookmark, rows deleted since, hand-edited URL) used to
 * be a dead end — zero rows, no footer. Redirect to the last real page.
 *
 * `redirect()` throws — call this OUTSIDE any try/catch around the fetch.
 */
export function redirectPastLastPage(
  pathname: string,
  params: SearchParams,
  pagination: PageInfo,
  pageParam = "page",
): void {
  const href = lastPageHref(pathname, params, pagination, pageParam);
  if (href) redirect(href);
}
