"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Filter, Plus, Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { ConstituentTypeBadges } from "@/components/constituents/constituent-type-badge";
import {
  FilterBuilder,
  FilterChip,
  type FilterChipData,
  type FilterPattern,
  type FilterQuery,
} from "@/components/constituents/filters";
import {
  chipsFromQuery,
  patternI18nKey,
} from "@/components/constituents/filters/filter-chip-helpers";
import {
  type FilterCondition,
  isFilterCondition,
} from "@/components/constituents/filters/filter-types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { type Constituent, type ConstituentListRow, fullName } from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";
import {
  type CampaignMember,
  type CampaignMemberSortField,
  type CampaignMemberSortOrder,
  PostalCampaignService,
} from "@/services/PostalCampaignService";

/**
 * next-intl statically validates message keys at compile-time; the
 * status→key map below produces a plain `string` that can't be narrowed
 * to the strict `NamespacedMessageKeys` union. Cast once at the call
 * site — same papercut as `notification-preferences-form.tsx`. Runtime
 * safety: every key below is checked into `en.json`/`fr.json` and
 * exercised by the integration tests.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(t: StrictTranslator, key: string, values?: Record<string, string | number>) {
  return (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
}

/**
 * Map an `ApiProblem` status to the matching toast key under
 * `campaigns.postal.members.toast` (Epic #421). Unknown statuses fall back
 * to the generic `filterFailed` copy so we never surface a raw backend
 * string to operators.
 */
function filterToastKeyFor(status: number): string {
  switch (status) {
    case 400:
      return "toast.filterBadRequest";
    case 403:
      return "toast.filterForbidden";
    case 404:
      // The backend uses 404 both for "campaign missing" and (via
      // `requireFlag`) "feature flag off". Tenants whose `advanced_filters`
      // flag is disabled will hit this branch — copy must read as
      // "advanced filters are off", which is more actionable than
      // "campaign not found".
      return "toast.filterFlagDisabled";
    case 429:
      return "toast.filterRateLimit";
    default:
      return "toast.filterFailed";
  }
}

interface CampaignMembersCardProps {
  campaignId: string;
  initialMembers: CampaignMember[];
  initialTotal: number;
  /** Disable add/remove for door-drop campaigns (no recipient list by definition). */
  doorDrop: boolean;
  /**
   * Notify the parent when the linked-constituent count changes (Epic #274
   * UX bug). The campaign detail page passes a sibling `PostalExportPanel`
   * the same count to gate the "Personalized" mode toggle — without this
   * callback the toggle stays locked on its initial server-rendered value
   * even after the user attaches recipients client-side.
   */
  onTotalChanged?: (next: number) => void;
}

/**
 * Page size for the members DataTable. Kept small (25) so a campaign with
 * thousands of constituents stays scannable — the operator pages through
 * rather than infinite-scrolling a single huge list.
 */
const MEMBERS_PER_PAGE = 25;

/**
 * localStorage key for the accumulated `FilterQuery` applied on a given
 * campaign. Scoped per-campaign so each campaign keeps its own segmentation
 * context; cleared by the "Clear list" action.
 */
const FILTER_STORAGE_PREFIX = "givernance:campaign-filter:";

function filterStorageKey(campaignId: string): string {
  return `${FILTER_STORAGE_PREFIX}${campaignId}`;
}

/** Stable content key for a condition (or nested group) so the union below dedupes re-applied filters. */
function conditionKey(c: FilterCondition | FilterQuery): string {
  return isFilterCondition(c)
    ? `c:${c.field}|${c.operator}|${JSON.stringify(c.value)}`
    : `g:${JSON.stringify(c)}`;
}

/**
 * Accumulate filters across successive applications. Each "apply" ADDS the
 * matching constituents to the campaign (membership is cumulative and can't
 * be undone by a filter), so the summary must show EVERY filter used to build
 * the list — not just the last one. Patterns are unioned by value; top-level
 * conditions are deduped by content so re-applying the same filter doesn't
 * stack duplicate chips. `base` is null on the first apply.
 */
export function unionQueries(base: FilterQuery | null, incoming: FilterQuery): FilterQuery {
  const patterns = Array.from(new Set([...(base?.patterns ?? []), ...(incoming.patterns ?? [])]));
  const seen = new Set((base?.conditions ?? []).map(conditionKey));
  const conditions: Array<FilterCondition | FilterQuery> = [...(base?.conditions ?? [])];
  for (const c of incoming.conditions) {
    const key = conditionKey(c);
    if (!seen.has(key)) {
      seen.add(key);
      conditions.push(c);
    }
  }
  return { ...incoming, conditions, patterns };
}

/**
 * Linked-constituents widget for the campaign detail page (Epic #274).
 *
 * Renders the current membership and a search-driven add dialog. The dialog
 * does an async constituent search via `GET /v1/constituents?search=` and
 * batch-adds the picked ids in one call.
 */
export function CampaignMembersCard({
  campaignId,
  initialMembers,
  initialTotal,
  doorDrop,
  onTotalChanged,
}: CampaignMembersCardProps) {
  const t = useTranslations("campaigns.postal.members");
  // Dedicated translator for pattern labels — kept on the constituents-side
  // namespace so the label is reusable from any surface that renders pattern
  // chips (the constituents list page renders the same chips via
  // filter-chip-helpers.ts).
  const tFilters = useTranslations("constituents.filters");
  const patternLabelFor = useCallback(
    (pattern: FilterPattern) =>
      trDynamic(tFilters, `patterns.${patternI18nKey(pattern)}`) as string,
    [tFilters],
  );

  const [members, setMembers] = useState<CampaignMember[]>(initialMembers);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  // "Start over" — detach every constituent from the campaign.
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [activeFilters, setActiveFilters] = useState<FilterChipData[]>([]);
  // The accumulated FilterQuery — the union of every filter applied to build
  // this list. Drives the chip strip + the FilterBuilder's `initialQuery`.
  const [lastAppliedQuery, setLastAppliedQuery] = useState<FilterQuery | null>(null);
  // Server-side sort (the list is paginated, so client-only sorting would
  // only reorder the visible page). Defaults to "newest added first".
  const [sortField, setSortField] = useState<CampaignMemberSortField>("addedAt");
  const [sortOrder, setSortOrder] = useState<CampaignMemberSortOrder>("desc");
  const [isFetchingPage, startPageTransition] = useTransition();

  // Restore the accumulated FilterQuery for this campaign from localStorage on
  // mount (client-side only — SSR has no localStorage). We hydrate the chip
  // strip + the FilterBuilder's `initialQuery` so reopening the page shows the
  // full set of filters used so far. Per-campaign scoping (the storage key
  // includes `campaignId`) keeps two campaigns from cross-leaking context.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(filterStorageKey(campaignId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as FilterQuery;
      // Defensive: a saved query from an older schema or hand-edited storage
      // could be malformed — drop silently rather than crash the card.
      if (!parsed || !Array.isArray(parsed.conditions)) return;
      setLastAppliedQuery(parsed);
      setActiveFilters(chipsFromQuery(parsed, patternLabelFor));
    } catch {
      // localStorage may throw under privacy-locked profiles; ignore.
    }
  }, [campaignId, patternLabelFor]);

  // Notify the parent whenever the local `total` shifts. Done from an effect
  // (not inside the `setTotal` updater) so a strict-mode / concurrent render
  // can't trigger the parent's setState mid-render — React surfaces that
  // exact pattern as "Cannot update a component while rendering a different
  // component".
  useEffect(() => {
    onTotalChanged?.(total);
  }, [total, onTotalChanged]);

  const updateTotal = useCallback((next: number | ((prev: number) => number)) => {
    setTotal((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  /**
   * Fetch a specific page of members and write it into local state. Used by
   * both the pagination controls and by the post-add/remove refresh paths
   * so the UI always reflects what the server just persisted.
   */
  const fetchMembersPage = useCallback(
    async (
      targetPage: number,
      sortOverride?: { sort: CampaignMemberSortField; order: CampaignMemberSortOrder },
    ) => {
      const client = createClientApiClient();
      const fresh = await PostalCampaignService.listMembers(client, campaignId, {
        page: targetPage,
        perPage: MEMBERS_PER_PAGE,
        sort: sortOverride?.sort ?? sortField,
        order: sortOverride?.order ?? sortOrder,
      });
      setMembers(fresh.data);
      setPage(fresh.pagination.page);
      updateTotal(fresh.pagination.total);
      return fresh;
    },
    [campaignId, sortField, sortOrder, updateTotal],
  );

  // Tanstack's resolved SortingState ↔ our (sort, order) pair. Changing the
  // sort refetches page 1 server-side so it reorders the WHOLE list, not just
  // the 25 rows currently on screen.
  const sorting = useMemo<SortingState>(
    () => [{ id: sortField, desc: sortOrder === "desc" }],
    [sortField, sortOrder],
  );
  const handleSortingChange = useCallback(
    (nextSorting: SortingState) => {
      const next = nextSorting[0];
      const sort = (next?.id as CampaignMemberSortField | undefined) ?? "addedAt";
      const order: CampaignMemberSortOrder = next ? (next.desc ? "desc" : "asc") : "desc";
      setSortField(sort);
      setSortOrder(order);
      startPageTransition(async () => {
        try {
          await fetchMembersPage(1, { sort, order });
        } catch {
          // Transient — keep the current view; the user can re-click to retry.
        }
      });
    },
    [fetchMembersPage],
  );

  const handlePageChange = useCallback(
    (nextPage: number) => {
      startPageTransition(async () => {
        try {
          await fetchMembersPage(nextPage);
        } catch {
          // Page change failures are transient — keep the current page
          // visible. The user can retry by clicking the pager again.
        }
      });
    },
    [fetchMembersPage],
  );

  const handleRemove = useCallback(
    async (constituentId: string) => {
      const client = createClientApiClient();
      try {
        await PostalCampaignService.removeMember(client, campaignId, constituentId);
        // Optimistic decrement of the count, then refetch the page we're
        // looking at so a row that was on a later page slides in to fill
        // the gap (and pagination stays consistent if we were on the last
        // page with a single row).
        updateTotal((prev) => Math.max(0, prev - 1));
        toast.success(t("toast.removed"));
        await fetchMembersPage(page);
      } catch (err) {
        const message =
          err instanceof ApiProblem
            ? (err.detail ?? err.title ?? t("toast.removeFailed"))
            : t("toast.removeFailed");
        toast.error(message);
      }
    },
    [campaignId, fetchMembersPage, page, t, updateTotal],
  );

  const handleAdded = useCallback(
    async (added: string[]) => {
      // After adding, jump back to page 1 so the new rows are visible
      // (the API orders by `added_at DESC` so they cluster at the top).
      try {
        await fetchMembersPage(1);
        toast.success(t("toast.added", { count: added.length }));
      } catch {
        // Silently swallow refetch errors — the add itself succeeded so the
        // user already got their primary feedback. They can refresh.
      }
    },
    [fetchMembersPage, t],
  );

  const handleApplyFilters = useCallback(
    async (query: FilterQuery) => {
      const client = createClientApiClient();
      try {
        // Single round-trip: the backend resolves the filter AND links every
        // match to the campaign in one transaction (rate-limited to 5/min).
        // Returns the inserted vs. skipped counts so we can surface both.
        const result = await PostalCampaignService.addMembersFromFilter(client, campaignId, query);

        // Jump back to page 1 (most recent additions cluster at the top per
        // `added_at DESC`).
        await fetchMembersPage(1);

        // Accumulate this filter into the running record (membership is
        // cumulative — every applied filter contributed constituents), so the
        // summary shows ALL filters used, not just the last. Persist the
        // accumulated query so the chip strip + the FilterBuilder's
        // `initialQuery` survive a page refresh.
        const accumulated = unionQueries(lastAppliedQuery, query);
        setActiveFilters(chipsFromQuery(accumulated, patternLabelFor));
        setLastAppliedQuery(accumulated);
        try {
          window.localStorage.setItem(filterStorageKey(campaignId), JSON.stringify(accumulated));
        } catch {
          // Quota or privacy-locked storage — non-blocking; the in-memory
          // `lastAppliedQuery` still feeds `initialQuery` for the current session.
        }

        toast.success(t("toast.filtered", { count: result.added }));
        if (result.skipped > 0) {
          // Soft-info toast so operators understand why `added + skipped`
          // doesn't equal the preview count (constituents already linked).
          toast.success(t("toast.filterSkipped", { count: result.skipped }));
        }
      } catch (err) {
        if (err instanceof ApiProblem) {
          toast.error(trDynamic(t, filterToastKeyFor(err.status)));
        } else {
          toast.error(t("toast.filterFailed"));
        }
      }
    },
    [campaignId, fetchMembersPage, lastAppliedQuery, patternLabelFor, t],
  );

  /**
   * "Start over" — detach EVERY constituent from the campaign and reset the
   * filter breadcrumb. The constituents themselves are untouched (only the
   * membership links are removed). Replaces the old per-chip / clear-filter
   * affordances, which only edited the visible filter record and confused
   * operators into thinking they were narrowing the mailing.
   */
  const handleClearMembers = useCallback(async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      const client = createClientApiClient();
      const { removed } = await PostalCampaignService.clearMembers(client, campaignId);
      setMembers([]);
      setTotal(0);
      onTotalChanged?.(0);
      setPage(1);
      // Repartir de zéro: drop the filter summary + persisted query too.
      setActiveFilters([]);
      setLastAppliedQuery(null);
      try {
        window.localStorage.removeItem(filterStorageKey(campaignId));
      } catch {
        // Privacy-locked storage — ignore.
      }
      toast.success(t("toast.cleared", { count: removed }));
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("toast.clearFailed"))
          : t("toast.clearFailed");
      toast.error(message);
    } finally {
      setIsClearing(false);
      setClearConfirmOpen(false);
    }
  }, [campaignId, isClearing, onTotalChanged, t]);

  const columns = useMemo<ColumnDef<CampaignMember>[]>(
    () => [
      {
        accessorKey: "name",
        header: () => t("columns.name"),
        cell: ({ row }) => {
          const member = row.original;
          return (
            <div className="min-w-0">
              <p className="truncate font-medium text-on-surface">
                {member.firstName} {member.lastName}
              </p>
              {member.email ? (
                <p className="truncate text-xs text-on-surface-variant">{member.email}</p>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "type",
        header: () => t("columns.type"),
        // Issue #465: this read-only members projection still carries only the
        // legacy singular `type` (the API members endpoint hasn't been widened
        // to `types`). Render it through the multi-chip component unconditionally
        // — wrapping the single value in a one-element array renders exactly one
        // chip today, and the cell automatically shows every type with a `+N`
        // overflow the moment the backend starts returning the `types` array,
        // with no further FE change and no flag-threading into this read view.
        cell: ({ row }) => <ConstituentTypeBadges types={[row.original.type]} maxVisible={2} />,
        meta: { className: "hidden md:table-cell" },
      },
      {
        accessorKey: "addedAt",
        header: () => t("columns.addedAt"),
        cell: ({ row }) => {
          const addedAt = row.original.addedAt;
          if (!addedAt) return null;
          // Display in the user's locale; the API returns an ISO 8601 string.
          const date = new Date(addedAt);
          return (
            <span className="text-xs text-on-surface-variant">
              {Number.isNaN(date.getTime()) ? addedAt : date.toLocaleDateString()}
            </span>
          );
        },
        meta: { className: "hidden lg:table-cell" },
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">{t("actions.remove")}</span>,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleRemove(row.original.constituentId)}
            aria-label={t("actions.remove")}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        ),
        meta: { className: "w-12 text-right" },
      },
    ],
    [handleRemove, t],
  );

  const tablePagination = useMemo(
    () => ({
      page,
      perPage: MEMBERS_PER_PAGE,
      total,
      totalPages: Math.max(1, Math.ceil(total / MEMBERS_PER_PAGE)),
    }),
    [page, total],
  );

  if (doorDrop) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users size={18} aria-hidden="true" />
            {t("title")}
          </CardTitle>
          <CardDescription>{t("doorDropExplanation")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users size={18} aria-hidden="true" />
              {t("title")} <Badge variant="neutral">{total}</Badge>
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {total > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-error hover:text-error"
                onClick={() => setClearConfirmOpen(true)}
              >
                <Trash2 size={16} aria-hidden="true" />
                {t("actions.clearList")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setFilterDialogOpen(true)}
            >
              <Filter size={16} aria-hidden="true" />
              {t("actions.filter")}
            </Button>
            <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus size={16} aria-hidden="true" />
              {t("actions.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeFilters.length > 0 && (
            // Read-only record of HOW this list was built — the advanced
            // filter(s) last applied to bulk-add constituents. NOT a live
            // selection lens: applying a filter immediately links every match
            // to the campaign, and the letter goes to EVERY member in the
            // table below. The chips are deliberately non-removable (removing
            // one would only edit this record, not the list) — to start over,
            // the operator uses "Clear list" in the header.
            <div className="rounded-lg border border-outline-variant bg-surface-container/40 p-3 space-y-2">
              <p className="text-xs text-on-surface-variant">{t("activeSelectionHint")}</p>
              <div className="flex flex-wrap gap-2">
                {activeFilters.map((filter) => (
                  <FilterChip key={filter.id} filter={filter} />
                ))}
              </div>
            </div>
          )}
          <DataTable
            columns={columns}
            data={members}
            sorting={sorting}
            onSortingChange={handleSortingChange}
            pagination={tablePagination}
            onPageChange={handlePageChange}
            isPending={isFetchingPage}
            defaultDensity="compact"
            emptyState={
              <p className="py-6 text-center text-sm text-on-surface-variant">{t("empty")}</p>
            }
          />
        </CardContent>
      </Card>

      <AddMembersDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        campaignId={campaignId}
        onAdded={handleAdded}
      />

      <FilterBuilder
        open={filterDialogOpen}
        onOpenChange={setFilterDialogOpen}
        onApply={handleApplyFilters}
        initialQuery={lastAppliedQuery ?? undefined}
      />

      <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clearDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("clearDialog.body", { count: total })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>{t("clearDialog.cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleClearMembers()}
              disabled={isClearing}
            >
              {isClearing ? t("clearDialog.clearing") : t("clearDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface AddMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  onAdded: (addedIds: string[]) => void;
}

function AddMembersDialog({ open, onOpenChange, campaignId, onAdded }: AddMembersDialogProps) {
  const t = useTranslations("campaigns.postal.members.dialog");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Constituent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  // Tracks whether at least one search round-trip has completed, so the
  // "nothing to add" copy never flashes before the first fetch resolves.
  const [hasSearched, setHasSearched] = useState(false);

  const runSearch = useCallback(
    (term: string) => {
      startTransition(async () => {
        const client = createClientApiClient();
        try {
          const fresh = await ConstituentService.listConstituents(client, {
            search: term || undefined,
            perPage: 25,
            // Exclude constituents already on this campaign in the SOURCE
            // QUERY (NOT EXISTS) — paginated, so we never load the full
            // membership into memory to filter it client-side.
            excludeCampaignId: campaignId,
          });
          setResults(fresh.data as ConstituentListRow[]);
        } catch {
          setResults([]);
        } finally {
          setHasSearched(true);
        }
      });
    },
    [campaignId],
  );

  // Load the (already-excluded) candidates as soon as the dialog opens, so an
  // operator who opens it sees the list — and the "all already added" state —
  // without having to click into the search box first.
  useEffect(() => {
    if (open) {
      setHasSearched(false);
      runSearch("");
    }
  }, [open, runSearch]);

  const handleConfirm = useCallback(async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const client = createClientApiClient();
      const ids = Array.from(selected);
      await PostalCampaignService.addMembers(client, campaignId, ids);
      onAdded(ids);
      onOpenChange(false);
      setSelected(new Set());
      setSearch("");
      setResults([]);
    } catch (err) {
      const message =
        err instanceof ApiProblem ? (err.detail ?? err.title ?? t("error")) : t("error");
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [campaignId, onAdded, onOpenChange, selected, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="search"
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              runSearch(e.target.value);
            }}
          />
          <div className="min-h-24 max-h-72 overflow-y-auto rounded-lg border border-outline-variant">
            {isPending && results.length === 0 ? (
              <p className="p-3 text-sm text-on-surface-variant">{t("loading")}</p>
            ) : results.length === 0 ? (
              // No search term + nothing left to add ⇒ every constituent is
              // already on this campaign. A search term + nothing ⇒ no match.
              <p className="p-3 text-sm text-on-surface-variant">
                {hasSearched && !search.trim() ? t("allAdded") : t("empty")}
              </p>
            ) : (
              <ul className="divide-y divide-outline-variant">
                {results.map((r) => {
                  const checked = selected.has(r.id);
                  return (
                    <li key={r.id}>
                      <label className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 hover:bg-surface-container">
                        <span className="flex flex-col text-sm">
                          <span className="font-medium text-on-surface">{fullName(r)}</span>
                          {r.email ? (
                            <span className="text-xs text-on-surface-variant">{r.email}</span>
                          ) : null}
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) {
                              next.add(r.id);
                            } else {
                              next.delete(r.id);
                            }
                            setSelected(next);
                          }}
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={submitting || selected.size === 0}>
            {submitting ? t("submitting") : t("confirm", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
