"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Filter, Plus, Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  FilterBuilder,
  FilterChip,
  type FilterChipData,
  type FilterPattern,
  type FilterQuery,
  filterFields,
  filterPresets,
} from "@/components/constituents/filters";
import { isFilterCondition } from "@/components/constituents/filters/filter-types";
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
import { type CampaignMember, PostalCampaignService } from "@/services/PostalCampaignService";

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
 * localStorage keys for the last `FilterQuery` and (optional) source preset
 * applied on a given campaign. Scoped per-campaign so each campaign keeps its
 * own segmentation context; cleared by the "remove last chip" UX path once
 * the chip list empties. The preset id lives in a sibling key so an older
 * persisted query (pre-Epic #421 bugfix) deserialises without surprise.
 */
const FILTER_STORAGE_PREFIX = "givernance:campaign-filter:";
const PRESET_STORAGE_PREFIX = "givernance:campaign-filter-preset:";

function filterStorageKey(campaignId: string): string {
  return `${FILTER_STORAGE_PREFIX}${campaignId}`;
}

function presetStorageKey(campaignId: string): string {
  return `${PRESET_STORAGE_PREFIX}${campaignId}`;
}

/**
 * i18n key for a BE pattern label under `constituents.filters.patterns.*`.
 * Patterns previously had no operator-facing surface — now each one shows up
 * as a removable "active selection" chip with a clear, localised label so
 * picking "Recurring donors" actually surfaces something users can see.
 */
function patternI18nKey(pattern: FilterPattern): string {
  switch (pattern) {
    case "LYBUNT":
      return "lybunt";
    case "SYBUNT":
      return "sybunt";
    case "RECURRING":
      return "recurring";
    case "LAPSED":
      return "lapsed";
    case "MAJOR_DONOR":
      return "majorDonor";
  }
}

/**
 * Build the chip strip from a (possibly persisted) FilterQuery. Two sources:
 *  - Top-level conditions become condition chips (nested groups stay inside
 *    the FilterBuilder dialog — they remain invisible in the strip because
 *    a deeply nested predicate doesn't translate to a single chip).
 *  - Each `patterns[i]` flag becomes its own pattern chip with a localised
 *    label so operators can see *what* a preset actually selected.
 *
 * `chipLabelForField` looks up the i18n key (e.g. `fields.donations.lastDate`)
 * in `filterFields` and returns it verbatim — the chip is rendered by
 * `FilterChip`, which carries its own `useTranslations` hook and resolves
 * the key to the active locale. For unknown fields (e.g. a future BE field
 * the FE hasn't catalogued yet) we fall back to the rightmost segment so
 * the chip still reads as something rather than collapsing to empty.
 */
function chipLabelForField(field: string): string {
  const known = filterFields.find((f) => f.name === field);
  if (known) return known.label;
  return field.split(".").pop() || field;
}

function chipsFromQuery(
  query: FilterQuery,
  patternLabelFor: (pattern: FilterPattern) => string,
): FilterChipData[] {
  const conditionChips: FilterChipData[] = query.conditions.filter(isFilterCondition).map((c) => ({
    id: c.id,
    kind: "condition" as const,
    label: chipLabelForField(c.field),
    field: c.field,
    operator: c.operator,
    value: c.value,
  }));

  const patternChips: FilterChipData[] = (query.patterns ?? []).map((pattern) => ({
    // Prefix the chip id so condition ids (numeric strings) can never collide
    // with pattern ids. The strip's remove handler keys on this prefix to
    // decide whether to drop a condition or splice a pattern.
    id: `pattern:${pattern}`,
    kind: "pattern" as const,
    label: patternLabelFor(pattern),
    // Synthetic field/operator/value — pattern chips never need them, but the
    // type insists on the fields existing.
    field: pattern,
    operator: "eq",
    value: pattern,
    pattern,
  }));

  return [...patternChips, ...conditionChips];
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
  // chips (Phase 2 may show the same chips on the constituents list page).
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
  const [activeFilters, setActiveFilters] = useState<FilterChipData[]>([]);
  const [lastAppliedQuery, setLastAppliedQuery] = useState<FilterQuery | null>(null);
  // The id of the preset (if any) that produced the last applied query —
  // surfaced as a "Filter preset: <name>" affordance above the chip strip so
  // the operator sees "Recurring donors" reflected back. Cleared by the
  // FilterBuilder the moment the user hand-edits a condition.
  const [lastAppliedPresetId, setLastAppliedPresetId] = useState<string | null>(null);
  const [isFetchingPage, startPageTransition] = useTransition();

  // Restore the last applied FilterQuery (and the preset id that produced it)
  // for this campaign from localStorage on mount (client-side only — SSR has
  // no localStorage). We hydrate the chip strip, the FilterBuilder's
  // `initialQuery`, and the "Filter preset: …" affordance so reopening the
  // page continues from where the operator left off. Per-campaign scoping
  // (the storage key includes `campaignId`) keeps two campaigns from
  // cross-leaking each other's segmentation context.
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
      const presetId = window.localStorage.getItem(presetStorageKey(campaignId));
      if (presetId) setLastAppliedPresetId(presetId);
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
    async (targetPage: number) => {
      const client = createClientApiClient();
      const fresh = await PostalCampaignService.listMembers(client, campaignId, {
        page: targetPage,
        perPage: MEMBERS_PER_PAGE,
      });
      setMembers(fresh.data);
      setPage(fresh.pagination.page);
      updateTotal(fresh.pagination.total);
      return fresh;
    },
    [campaignId, updateTotal],
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
    async (query: FilterQuery, presetId?: string) => {
      const client = createClientApiClient();
      try {
        // Single round-trip: the backend resolves the filter AND links every
        // match to the campaign in one transaction (rate-limited to 5/min).
        // Returns the inserted vs. skipped counts so we can surface both.
        const result = await PostalCampaignService.addMembersFromFilter(client, campaignId, query);

        // Jump back to page 1 (most recent additions cluster at the top per
        // `added_at DESC`).
        await fetchMembersPage(1);

        // Active-filter chips (conditions + patterns) + persist the full
        // query and source preset id so reopening the dialog later starts
        // from this segmentation and the "Filter preset: …" affordance
        // survives a page refresh.
        setActiveFilters(chipsFromQuery(query, patternLabelFor));
        setLastAppliedQuery(query);
        setLastAppliedPresetId(presetId ?? null);
        try {
          window.localStorage.setItem(filterStorageKey(campaignId), JSON.stringify(query));
          if (presetId) {
            window.localStorage.setItem(presetStorageKey(campaignId), presetId);
          } else {
            window.localStorage.removeItem(presetStorageKey(campaignId));
          }
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
    [campaignId, fetchMembersPage, patternLabelFor, t],
  );

  /**
   * Clear every chip + the persisted query + the preset affordance. Wired to
   * the "Clear all" button in the Active selection card so the operator has a
   * single-click escape from a misclicked preset (without having to remove
   * each chip individually).
   */
  const clearAllFilters = useCallback(() => {
    setActiveFilters([]);
    setLastAppliedQuery(null);
    setLastAppliedPresetId(null);
    try {
      window.localStorage.removeItem(filterStorageKey(campaignId));
      window.localStorage.removeItem(presetStorageKey(campaignId));
    } catch {
      // Privacy-locked storage — ignore.
    }
    toast.success(t("filterRemoved"));
  }, [campaignId, t]);

  /**
   * Remove a single chip — either a condition (drop from `conditions`) or a
   * pattern (splice out of `patterns`). The chip id carries a `pattern:`
   * prefix when it's a pattern chip; condition chips keep their original
   * numeric id from the FilterBuilder. Persists the diff so a page refresh
   * doesn't resurrect the dropped predicate. Any user-driven removal also
   * clears `lastAppliedPresetId` because a hand-trimmed preset is no longer
   * "the preset" — it's a custom variant.
   */
  const handleChipRemove = useCallback(
    (chipId: string) => {
      setActiveFilters((prev) => prev.filter((f) => f.id !== chipId));
      setLastAppliedQuery((prev) => {
        if (!prev) return prev;
        let nextConditions = prev.conditions;
        let nextPatterns = prev.patterns;

        if (chipId.startsWith("pattern:")) {
          const removed = chipId.slice("pattern:".length) as FilterPattern;
          nextPatterns = (prev.patterns ?? []).filter((p) => p !== removed);
        } else {
          nextConditions = prev.conditions.filter(
            (c) => !(isFilterCondition(c) && c.id === chipId),
          );
        }

        const isEmpty = nextConditions.length === 0 && (nextPatterns?.length ?? 0) === 0;
        const next: FilterQuery = {
          ...prev,
          conditions: nextConditions,
          patterns: nextPatterns,
        };
        try {
          if (isEmpty) {
            window.localStorage.removeItem(filterStorageKey(campaignId));
            window.localStorage.removeItem(presetStorageKey(campaignId));
          } else {
            window.localStorage.setItem(filterStorageKey(campaignId), JSON.stringify(next));
            // A hand-trimmed preset is no longer the preset.
            window.localStorage.removeItem(presetStorageKey(campaignId));
          }
        } catch {
          // localStorage may throw under privacy-locked profiles; ignore.
        }
        return isEmpty ? null : next;
      });
      setLastAppliedPresetId(null);
      toast.success(t("filterRemoved"));
    },
    [campaignId, t],
  );

  // Resolve the human-readable preset name once per render so the affordance
  // doesn't have to re-walk `filterPresets` on every chip render. `preset.name`
  // is an i18n key (e.g. `presets.items.lybunt.name`) — resolve it through
  // the constituents-filters translator so the active locale wins.
  const activePresetName = useMemo(() => {
    if (!lastAppliedPresetId) return null;
    const preset = filterPresets.find((p) => p.id === lastAppliedPresetId);
    if (!preset) return null;
    return trDynamic(tFilters, preset.name);
  }, [lastAppliedPresetId, tFilters]);

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
        cell: ({ row }) => (
          <span className="text-xs uppercase tracking-wide text-on-surface-variant">
            {row.original.type}
          </span>
        ),
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
          <div className="flex gap-2">
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
            // Card-style container so the active selection is visually
            // isolated from the table below. Border + soft surface tells the
            // operator "this is the current selection lens applied to the
            // list". Header carries a count badge so a long custom query
            // doesn't look identical to a one-pattern preset.
            <div className="rounded-lg border border-outline-variant bg-surface-container/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-on-surface">
                    {t("activeSelectionTitle")}
                  </p>
                  <Badge variant="neutral">{activeFilters.length}</Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearAllFilters}
                  aria-label={t("clearAll")}
                >
                  {t("clearAll")}
                </Button>
              </div>
              {activePresetName && (
                <p className="text-xs text-on-surface-variant">
                  {t("presetLabel", { name: activePresetName })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {activeFilters.map((filter) => (
                  <FilterChip key={filter.id} filter={filter} onRemove={handleChipRemove} />
                ))}
              </div>
            </div>
          )}
          <DataTable
            columns={columns}
            data={members}
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
        existingIds={new Set(members.map((m) => m.constituentId))}
        onAdded={handleAdded}
      />

      <FilterBuilder
        open={filterDialogOpen}
        onOpenChange={setFilterDialogOpen}
        onApply={handleApplyFilters}
        initialQuery={lastAppliedQuery ?? undefined}
      />
    </>
  );
}

interface AddMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  existingIds: Set<string>;
  onAdded: (addedIds: string[]) => void;
}

function AddMembersDialog({
  open,
  onOpenChange,
  campaignId,
  existingIds,
  onAdded,
}: AddMembersDialogProps) {
  const t = useTranslations("campaigns.postal.members.dialog");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Constituent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  const runSearch = useCallback((term: string) => {
    startTransition(async () => {
      const client = createClientApiClient();
      try {
        const fresh = await ConstituentService.listConstituents(client, {
          search: term || undefined,
          perPage: 25,
        });
        setResults(fresh.data as ConstituentListRow[]);
      } catch {
        setResults([]);
      }
    });
  }, []);

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

  const filteredResults = useMemo(
    () => results.filter((r) => !existingIds.has(r.id)),
    [existingIds, results],
  );

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
            onFocus={() => {
              if (results.length === 0) runSearch("");
            }}
          />
          <div className="max-h-72 overflow-y-auto rounded-lg border border-outline-variant">
            {isPending && results.length === 0 ? (
              <p className="p-3 text-sm text-on-surface-variant">{t("loading")}</p>
            ) : filteredResults.length === 0 ? (
              <p className="p-3 text-sm text-on-surface-variant">{t("empty")}</p>
            ) : (
              <ul className="divide-y divide-outline-variant">
                {filteredResults.map((r) => {
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
