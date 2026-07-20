// @ts-nocheck
"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  Check,
  ChevronDown,
  History,
  Mail,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  ConstituentTypeBadge,
  ConstituentTypeBadges,
} from "@/components/constituents/constituent-type-badge";
import {
  FilterBuilder,
  FilterChip,
  type FilterPattern,
  type FilterQuery,
  filterPresets,
} from "@/components/constituents/filters";
import {
  chipsFromQuery,
  patternI18nKey,
} from "@/components/constituents/filters/filter-chip-helpers";
import {
  type FilterCondition as FilterConditionType,
  isFilterCondition,
} from "@/components/constituents/filters/filter-types";
import { EmptyState } from "@/components/shared/empty-state";
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
import { CheckboxVisual } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatDate } from "@/lib/format";
import {
  type ConstituentListRow,
  type ConstituentSortField,
  type ConstituentSortOrder,
  fullName,
  initials,
} from "@/models/constituent";
import { type BulkEmailJobView, ConstituentService } from "@/services/ConstituentService";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

/**
 * next-intl statically validates message keys at compile-time; pattern / preset
 * labels are dynamic keys (built from BE enum values) that can't be narrowed to
 * the strict `NamespacedMessageKeys` union. Cast once at the call site — same
 * papercut as `campaign-members-card.tsx`.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(t: StrictTranslator, key: string, values?: Record<string, string | number>) {
  return (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
}

/**
 * Parse the shareable `?filters=` URL param into a FilterQuery, or null when
 * absent/unparseable/malformed. The server component runs the same JSON.parse
 * guard before forwarding the param to the API, so both sides agree on what
 * counts as "no filter".
 */
function parseFiltersParam(raw: string | null): FilterQuery | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FilterQuery;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.conditions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Translate the legacy basic-dialog URL params (Epic #274) into DSL
 * conditions so an operator upgrading from a bookmarked basic-filter URL
 * opens the builder pre-seeded with the equivalent query instead of an empty
 * one. Amounts convert cents → EUR (the builder's input unit); the DSL
 * boundary multiplies back by 100.
 */
function legacyParamsToConditions(
  lastDonationFrom: string,
  lastDonationTo: string,
  minLifetimeAmountCents: string,
): FilterConditionType[] {
  const conditions: FilterConditionType[] = [];
  const from = lastDonationFrom ? lastDonationFrom.slice(0, 10) : "";
  const to = lastDonationTo ? lastDonationTo.slice(0, 10) : "";
  if (from && to) {
    conditions.push({
      id: "legacy-last-donation",
      field: "donations.lastDate",
      operator: "between",
      value: [from, to],
    });
  } else if (from) {
    conditions.push({
      id: "legacy-last-donation",
      field: "donations.lastDate",
      operator: "gte",
      value: from,
    });
  } else if (to) {
    conditions.push({
      id: "legacy-last-donation",
      field: "donations.lastDate",
      operator: "lte",
      value: to,
    });
  }
  const cents = Number.parseInt(minLifetimeAmountCents, 10);
  if (Number.isFinite(cents) && cents > 0) {
    conditions.push({
      id: "legacy-min-lifetime",
      field: "donations.totalAmount",
      operator: "gte",
      value: cents / 100,
    });
  }
  return conditions;
}

interface ConstituentsTableProps {
  constituents: ConstituentListRow[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
  /**
   * Delete is `requireOrgAdmin` server-side; when `false`, the row's
   * dropdown only shows Edit. Mirrors the donations + members table
   * shortcut pattern.
   */
  canManageAdminActions: boolean;
  /**
   * `false` for the `viewer` role — Edit is gated to write-capable roles
   * server-side (`PUT /v1/constituents/:id` is `requireWrite`), so we hide
   * the row dropdown entirely when no action is available.
   */
  canWrite: boolean;
  /**
   * `false` when `communication.bulk_email` feature flag is off (PR #352
   * follow-up; issue #326). Hides the "Email selection" + "Recent emails"
   * buttons. The API also 404s the bulk-email routes when the flag is
   * off — this prop is the UI half of the same gate.
   */
  bulkEmailEnabled: boolean;
  /**
   * `true` when the `constituents.multi_type` flag is on (issue #465). Off →
   * the type cell shows a single badge (`types[0]`) and the quick filter is a
   * single-value `Select` writing `?type=`. On → the cell renders every type
   * (with a `+N` overflow) and the quick filter is a multi-select writing
   * repeatable `?types=`.
   */
  multiTypeEnabled: boolean;
  /**
   * `true` when the `advanced_filters` flag is on (Epic #418). On → the
   * "More filters" button opens the full FilterBuilder (query DSL, presets,
   * live count preview) and the applied query lives in the shareable
   * `?filters=` URL param, rendered as a chip strip. Off → the legacy basic
   * dialog (last-donation range + minimum total giving) renders unchanged
   * and no advanced surface exists.
   */
  advancedFiltersEnabled: boolean;
  /**
   * `true` when the server rejected the URL's `?filters=` value (hand-edited
   * or stale shared link). The list below is UNFILTERED — an inline notice
   * says so instead of silently pretending the filter applied.
   */
  advancedFilterInvalid?: boolean;
  /** Server-resolved sort/order — see donations-table.tsx for rationale. */
  sort: ConstituentSortField;
  order: ConstituentSortOrder;
}

const QUICK_FILTER_TYPES = ["donor", "volunteer", "member", "beneficiary", "partner"] as const;

export function ConstituentsTable({
  constituents,
  pagination,
  canManageAdminActions,
  canWrite,
  bulkEmailEnabled,
  multiTypeEnabled,
  advancedFiltersEnabled,
  advancedFilterInvalid = false,
  sort,
  order,
}: ConstituentsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("constituents");
  const tType = useTranslations("constituents.types");
  const locale = useLocale();
  const tFilters = useTranslations("constituents.filters");
  const [deleteTarget, setDeleteTarget] = useState<ConstituentListRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const initialSearch = searchParams.get("search") ?? "";
  const initialType = searchParams.get("type") ?? "all";
  // Multi-value type filter (issue #465) — the repeatable `?types=` param.
  const initialTypes = searchParams.getAll("types");
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  // Epic #274 — bulk-select state lives here, not in the URL: unlike search/
  // sort/page, a selection is per-tab and not deep-linkable.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [bulkEmailJobsOpen, setBulkEmailJobsOpen] = useState(false);
  // After a successful dispatch we keep tracking the new job so the
  // operator can watch the ratio move from 0/N to N/N — addresses the
  // issue #326 transparency concern: the original "toast and forget"
  // UX could not tell a "0 of N delivered, worker died" story.
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);

  const initialLastDonationFrom = searchParams.get("lastDonationFrom") ?? "";
  const initialLastDonationTo = searchParams.get("lastDonationTo") ?? "";
  const initialMinLifetime = searchParams.get("minLifetimeAmountCents") ?? "";

  // Epic #418 — the applied advanced-filter DSL, deserialised from the
  // shareable `?filters=` URL param. Null when absent or unparseable (the
  // server ignored it in that case too, so strip and data always agree).
  const filtersParam = searchParams.get("filters");
  const presetIdParam = searchParams.get("filterPreset");
  const activeAdvancedQuery = useMemo<FilterQuery | null>(
    () => (advancedFiltersEnabled ? parseFiltersParam(filtersParam) : null),
    [advancedFiltersEnabled, filtersParam],
  );

  const hasActiveAdvancedFilters =
    initialLastDonationFrom !== "" ||
    initialLastDonationTo !== "" ||
    initialMinLifetime !== "" ||
    activeAdvancedQuery !== null;
  // Issue #216: see donations-table.tsx for the pattern.
  const [isPending, startTransition] = useTransition();

  // Server-side search: see campaigns-table.tsx for the rationale on why
  // `searchParams` is excluded from the deps.
  // Issue #217: search/filter/sort use `router.replace`; pagination uses
  // `router.push` so prev/next remain meaningful navigation steps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    // Trim before comparing + writing — the backend already tokenises on
    // whitespace, but a trailing space in the URL is visible cruft and
    // re-fires the effect on every keystroke past the trim boundary.
    const trimmed = searchTerm.trim();
    if (trimmed === initialSearch) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (trimmed) {
        params.set("search", trimmed);
      } else {
        params.delete("search");
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const updateType = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next && next !== "all") {
        params.set("type", next);
      } else {
        params.delete("type");
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  // Multi-value type filter (issue #465). Rewrites the repeatable `?types=`
  // param to the full selected set so the URL stays the single source of
  // truth (same `router.replace` posture as `updateType`).
  const updateTypes = useCallback(
    (next: string[]) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("types");
      // Legacy single-value param is mutually exclusive with the multi filter.
      params.delete("type");
      for (const value of next) {
        params.append("types", value);
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  // ── Epic #418: advanced-filter DSL on the list page ──────────────────
  const tFiltersRoot = useTranslations("constituents.filters");
  const patternLabelFor = useCallback(
    (pattern: FilterPattern) => trDynamic(tFiltersRoot, `patterns.${patternI18nKey(pattern)}`),
    [tFiltersRoot],
  );

  const advancedChips = useMemo(
    () => (activeAdvancedQuery ? chipsFromQuery(activeAdvancedQuery, patternLabelFor) : []),
    [activeAdvancedQuery, patternLabelFor],
  );

  /** Resolved display name of the preset that seeded the active query, if any. */
  const activePresetName = useMemo(() => {
    if (!presetIdParam || !activeAdvancedQuery) return null;
    const preset = filterPresets.find((p) => p.id === presetIdParam);
    return preset ? trDynamic(tFiltersRoot, preset.name) : null;
  }, [presetIdParam, activeAdvancedQuery, tFiltersRoot]);

  /**
   * Write (or clear, with `null`) the applied DSL to the URL — the single
   * source of truth, so the filtered view is shareable/bookmarkable. Applying
   * a DSL query clears the legacy basic-dialog params: the DSL subsumes them
   * and the two systems must never AND together invisibly.
   */
  const writeAdvancedQuery = useCallback(
    (query: FilterQuery | null, presetId?: string) => {
      const params = new URLSearchParams(searchParams.toString());
      const isEmpty =
        !query || (query.conditions.length === 0 && (query.patterns?.length ?? 0) === 0);
      if (isEmpty) {
        params.delete("filters");
        params.delete("filterPreset");
      } else {
        params.set("filters", JSON.stringify(query));
        if (presetId) {
          params.set("filterPreset", presetId);
        } else {
          params.delete("filterPreset");
        }
      }
      params.delete("lastDonationFrom");
      params.delete("lastDonationTo");
      params.delete("minLifetimeAmountCents");
      params.delete("page");
      const queryString = params.toString();
      startTransition(() => {
        router.replace(queryString ? `${pathname}?${queryString}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  // `FilterBuilder.onApply` awaits this — async so a future server-side
  // persistence step can slot in without changing the builder contract.
  const applyAdvancedQuery = useCallback(
    async (query: FilterQuery, presetId?: string) => {
      writeAdvancedQuery(query, presetId);
    },
    [writeAdvancedQuery],
  );

  /**
   * Remove one chip from the applied query. Pattern chips splice their flag
   * out of `patterns`; condition chips drop the matching condition. Any
   * hand-edit invalidates the "from preset X" claim, so the preset param is
   * always dropped.
   */
  const removeAdvancedChip = useCallback(
    (chipId: string) => {
      if (!activeAdvancedQuery) return;
      let next: FilterQuery;
      if (chipId.startsWith("pattern:")) {
        const pattern = chipId.slice("pattern:".length) as FilterPattern;
        next = {
          ...activeAdvancedQuery,
          patterns: (activeAdvancedQuery.patterns ?? []).filter((p) => p !== pattern),
        };
      } else {
        next = {
          ...activeAdvancedQuery,
          conditions: activeAdvancedQuery.conditions.filter(
            (c) => !isFilterCondition(c) || c.id !== chipId,
          ),
        };
      }
      writeAdvancedQuery(next);
    },
    [activeAdvancedQuery, writeAdvancedQuery],
  );

  /**
   * What the builder opens with: the currently-applied query (so reopening
   * edits in place), or the legacy basic-dialog params translated to DSL
   * conditions (so a bookmarked pre-DSL URL upgrades seamlessly).
   */
  const builderInitialQuery = useMemo<FilterQuery | undefined>(() => {
    if (activeAdvancedQuery) return activeAdvancedQuery;
    const legacy = legacyParamsToConditions(
      initialLastDonationFrom,
      initialLastDonationTo,
      initialMinLifetime,
    );
    return legacy.length > 0 ? { operator: "AND", conditions: legacy } : undefined;
  }, [activeAdvancedQuery, initialLastDonationFrom, initialLastDonationTo, initialMinLifetime]);

  const navigateToPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (page <= 1) {
        params.delete("page");
      } else {
        params.set("page", String(page));
      }
      const query = params.toString();
      startTransition(() => {
        router.push(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [order, sort],
  );

  const onSortingChange = useCallback(
    (nextSorting: SortingState) => {
      const [next] = nextSorting;
      const params = new URLSearchParams(searchParams.toString());
      if (!next) {
        params.delete("sort");
        params.delete("order");
      } else {
        params.set("sort", next.id);
        params.set("order", next.desc ? "desc" : "asc");
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await ConstituentService.deleteConstituent(createClientApiClient(), deleteTarget.id);
      toast.success(t("success.deleted"));
      setDeleteTarget(null);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("constituents.delete failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.deleteGeneric"))
          : t("errors.deleteGeneric");
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, router, t]);

  const togglePageSelection = useCallback(
    (rowsOnPage: ConstituentListRow[], checked: boolean) => {
      const next = new Set(selectedIds);
      for (const r of rowsOnPage) {
        if (checked) next.add(r.id);
        else next.delete(r.id);
      }
      setSelectedIds(next);
    },
    [selectedIds],
  );

  const columns = useMemo<ColumnDef<ConstituentListRow>[]>(
    () => [
      // The select-row checkboxes only earn their place when there's
      // actually a multi-select action available. Today that's solely
      // the bulk-email feature (issue #326) — when the
      // `communication.bulk_email` flag is off, the column is dead
      // surface area and confuses operators ("what is this for?").
      // Gate on `bulkEmailEnabled` alongside the role check so the
      // column disappears in lockstep with the action buttons above.
      ...(canManageAdminActions && bulkEmailEnabled
        ? [
            {
              id: "select",
              header: ({ table }) => {
                const rowsOnPage = table
                  .getRowModel()
                  .rows.map((r) => r.original as ConstituentListRow);
                const allChecked =
                  rowsOnPage.length > 0 && rowsOnPage.every((r) => selectedIds.has(r.id));
                return (
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => togglePageSelection(rowsOnPage, e.target.checked)}
                    aria-label={t("columns.selectAll")}
                    onClick={(e) => e.stopPropagation()}
                  />
                );
              },
              enableSorting: false,
              cell: ({ row }: { row: { original: ConstituentListRow } }) => {
                const id = row.original.id;
                const checked = selectedIds.has(id);
                return (
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      setSelectedIds(next);
                    }}
                    aria-label={t("columns.selectRow")}
                    onClick={(e) => e.stopPropagation()}
                  />
                );
              },
            } satisfies ColumnDef<ConstituentListRow>,
          ]
        : []),
      {
        id: "name",
        accessorFn: (row) => fullName(row),
        header: () => t("columns.name"),
        enableSorting: true,
        cell: ({ row }) => {
          const constituent = row.original;
          return (
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
              >
                {initials(constituent)}
              </span>
              <span className="font-medium text-on-surface">{fullName(constituent)}</span>
            </div>
          );
        },
      },
      {
        id: "type",
        accessorKey: "type",
        header: () => t("columns.type"),
        enableSorting: true,
        // Flag on → render every type with a `+1` overflow chip past 2 (the
        // tight table cell stays scannable; matches docs/design/.../list.html).
        // Flag off → the single legacy badge on `types[0]`, identical to today.
        cell: ({ row }) =>
          multiTypeEnabled ? (
            <ConstituentTypeBadges types={row.original.types} maxVisible={2} />
          ) : (
            <ConstituentTypeBadge type={String(row.original.type)} />
          ),
      },
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.email ?? "—"}</span>
        ),
      },
      {
        id: "tags",
        accessorKey: "tags",
        header: () => t("columns.tags"),
        enableSorting: false,
        cell: ({ row }) => {
          const tags = row.original.tags;
          if (!tags || tags.length === 0) {
            return <span className="text-on-surface-variant">—</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="neutral" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: "lastDonation",
        accessorFn: (row) => row.lastDonationAt ?? "",
        header: () => t("columns.lastDonation"),
        cell: ({ row }) =>
          row.original.lastDonationAt ? (
            <span className="whitespace-nowrap text-on-surface-variant">
              {formatDate(row.original.lastDonationAt, locale, "short")}
            </span>
          ) : (
            <span className="text-on-surface-variant opacity-60">—</span>
          ),
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: () => t("columns.createdAt"),
        enableSorting: true,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.createdAt, locale, "short")}
          </span>
        ),
      },
      // For viewers (no Edit, no Delete) we drop the column entirely — keeping
      // it would render an `sr-only` "Actions" header above empty cells, a
      // small a11y nuisance and a wasted column on info-dense screens.
      ...(canWrite || canManageAdminActions
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: ConstituentListRow } }) => (
                <ConstituentRowActions
                  constituent={row.original}
                  canEdit={canWrite}
                  canDelete={canManageAdminActions}
                  onDelete={() => setDeleteTarget(row.original)}
                  menuLabel={t("actions.menu", { name: fullName(row.original) })}
                  editLabel={t("actions.edit")}
                  deleteLabel={t("actions.delete")}
                />
              ),
            } satisfies ColumnDef<ConstituentListRow>,
          ]
        : []),
    ],
    [
      bulkEmailEnabled,
      canManageAdminActions,
      canWrite,
      locale,
      multiTypeEnabled,
      selectedIds,
      t,
      togglePageSelection,
    ],
  );

  return (
    <>
      {/* ADR-035 rule A1 — the filter bar is static shell: no entrance
          animation, instantly interactive. Only the table below cascades. */}
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant opacity-50"
            size={16}
          />
          <Input
            placeholder={tFilters("searchPlaceholder")}
            aria-label={tFilters("searchPlaceholder")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        {multiTypeEnabled ? (
          <TypeMultiFilter
            selected={initialTypes}
            onChange={updateTypes}
            labels={{
              all: tFilters("allTypes"),
              aria: tFilters("typeLabel"),
              count: (count: number) => tFilters("typesSelectedCount", { count }),
              option: (value: (typeof QUICK_FILTER_TYPES)[number]) => tType(value),
            }}
          />
        ) : (
          <Select value={initialType} onValueChange={updateType}>
            <SelectTrigger className="w-full sm:w-[180px]" aria-label={tFilters("typeLabel")}>
              <SelectValue placeholder={tFilters("allTypes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tFilters("allTypes")}</SelectItem>
              <SelectItem value="donor">{tType("donor")}</SelectItem>
              <SelectItem value="volunteer">{tType("volunteer")}</SelectItem>
              <SelectItem value="member">{tType("member")}</SelectItem>
              <SelectItem value="beneficiary">{tType("beneficiary")}</SelectItem>
              <SelectItem value="partner">{tType("partner")}</SelectItem>
            </SelectContent>
          </Select>
        )}
        {/* Epic #418 — flag on: the real FilterBuilder (DSL, presets, live
            count) replaces the basic dialog as THE filter entry point. Flag
            off: the legacy basic dialog renders unchanged. */}
        <Button
          type="button"
          variant={hasActiveAdvancedFilters ? "primary" : "secondary"}
          size="sm"
          onClick={() =>
            advancedFiltersEnabled ? setBuilderOpen(true) : setAdvancedFiltersOpen(true)
          }
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          {advancedFiltersEnabled ? tFilters("builderLabel") : tFilters("advancedLabel")}
          {hasActiveAdvancedFilters ? <Badge variant="info">•</Badge> : null}
        </Button>
        {canManageAdminActions && bulkEmailEnabled ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setBulkEmailJobsOpen(true)}
              aria-label={t("bulkEmail.jobs.openLabel")}
            >
              <History size={16} aria-hidden="true" />
              {t("bulkEmail.jobs.title")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setBulkEmailOpen(true)}
              disabled={selectedIds.size === 0}
            >
              <Mail size={16} aria-hidden="true" />
              {t("bulkEmail.action", { count: selectedIds.size })}
            </Button>
          </>
        ) : null}
      </div>

      {/* Epic #418 — active-filter strip. Static shell like the filter bar
          above (ADR-035 rule A1): no entrance animation, instantly
          interactive. Every chip is removable; removal rewrites `?filters=`
          so the URL stays the single source of truth. */}
      {advancedFiltersEnabled && activeAdvancedQuery ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-on-surface-variant">
            {activePresetName
              ? tFilters("strip.preset", { name: activePresetName })
              : tFilters("strip.label")}
          </span>
          {advancedChips.map((chip) => (
            <FilterChip key={chip.id} filter={chip} onRemove={removeAdvancedChip} />
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => writeAdvancedQuery(null)}>
            {tFilters("strip.clear")}
          </Button>
        </div>
      ) : null}
      {advancedFiltersEnabled && advancedFilterInvalid ? (
        <p className="mb-4 text-sm text-warning" role="alert">
          {tFilters("strip.invalid")}
        </p>
      ) : null}

      <DataTable
        columns={columns}
        data={constituents}
        pagination={pagination}
        onPageChange={navigateToPage}
        sorting={sorting}
        onSortingChange={onSortingChange}
        isPending={isPending}
        // ADR-035 rules A2/A3 — the table container is slot 0 of the
        // content cascade (container before content), rows follow from
        // slot 1. The DataTable gates the replay on the mount-time data +
        // sorting references (rule B12), so search keystrokes / filter
        // chips / sort / pagination stay instant.
        className="reveal-item"
        animateEntrance
        entranceCascadeOffset={1}
        onRowClick={(row) => router.push(`/constituents/${row.original.id}`)}
        emptyState={
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.description")} />
        }
      />

      <BulkEmailDialog
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        selectedIds={Array.from(selectedIds)}
        onSent={(jobId) => {
          setSelectedIds(new Set());
          // Auto-open the jobs panel pinned to the new job so the
          // operator's eye lands on the live progress ratio, not a
          // disappearing toast.
          setTrackedJobId(jobId);
          setBulkEmailJobsOpen(true);
        }}
      />

      <BulkEmailJobsDialog
        open={bulkEmailJobsOpen}
        onOpenChange={(open) => {
          setBulkEmailJobsOpen(open);
          if (!open) setTrackedJobId(null);
        }}
        highlightJobId={trackedJobId}
        onResumed={(newJobId) => setTrackedJobId(newJobId)}
      />

      {/* Epic #418 — the full FilterBuilder (flag on). The `key` remounts it
          whenever the applied query changes so its internal useState re-seeds
          from `initialQuery` (the builder resets to empty after each apply;
          without the remount, reopening would edit a stale draft instead of
          the currently-applied filter). */}
      {advancedFiltersEnabled ? (
        <FilterBuilder
          key={filtersParam ?? "no-filter"}
          open={builderOpen}
          onOpenChange={setBuilderOpen}
          onApply={applyAdvancedQuery}
          initialQuery={builderInitialQuery}
        />
      ) : null}

      <AdvancedFiltersDialog
        open={advancedFiltersOpen}
        onOpenChange={setAdvancedFiltersOpen}
        defaults={{
          lastDonationFrom: initialLastDonationFrom,
          lastDonationTo: initialLastDonationTo,
          minLifetimeAmountCents: initialMinLifetime,
        }}
        onApply={(values) => {
          const params = new URLSearchParams(searchParams.toString());
          if (values.lastDonationFrom) {
            params.set("lastDonationFrom", values.lastDonationFrom);
          } else {
            params.delete("lastDonationFrom");
          }
          if (values.lastDonationTo) {
            params.set("lastDonationTo", values.lastDonationTo);
          } else {
            params.delete("lastDonationTo");
          }
          if (values.minLifetimeAmountCents) {
            params.set("minLifetimeAmountCents", values.minLifetimeAmountCents);
          } else {
            params.delete("minLifetimeAmountCents");
          }
          params.delete("page");
          const query = params.toString();
          startTransition(() => {
            router.replace(query ? `${pathname}?${query}` : pathname);
          });
          setAdvancedFiltersOpen(false);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("deleteDialog.description", { name: fullName(deleteTarget) })
                : t("deleteDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isDeleting}>
                {t("deleteDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? t("deleteDialog.deleting") : t("deleteDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface BulkEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  /**
   * Receives the freshly-created `bulk_email_jobs.id` so the caller can
   * pin the jobs panel to it and watch live progress (issue #326).
   */
  onSent: (jobId: string) => void;
}

function BulkEmailDialog({ open, onOpenChange, selectedIds, onSent }: BulkEmailDialogProps) {
  const t = useTranslations("constituents.bulkEmail");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (subject.trim().length === 0 || body.trim().length === 0) {
      toast.error(t("errors.empty"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await ConstituentService.sendBulkEmail(createClientApiClient(), {
        constituentIds: selectedIds,
        subject,
        body,
      });
      toast.success(
        t("success.queued", {
          queued: result.queued,
          skipped: result.skippedNoEmail,
        }),
      );
      setSubject("");
      setBody("");
      onOpenChange(false);
      onSent(result.jobId);
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.send"))
          : t("errors.send");
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [body, onOpenChange, onSent, selectedIds, subject, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { count: selectedIds.length })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-on-surface" htmlFor="bulk-email-subject">
              {t("fields.subject")}
            </label>
            <Input
              id="bulk-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("fields.subjectPlaceholder")}
              maxLength={200}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-on-surface" htmlFor="bulk-email-body">
              {t("fields.body")}
            </label>
            <Textarea
              id="bulk-email-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("fields.bodyPlaceholder")}
              rows={8}
              maxLength={50000}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("actions.cancel")}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? t("actions.sending") : t("actions.send", { count: selectedIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Recent bulk-email jobs panel + resume action (issue #326).
 *
 * Lists the 20 most-recent `bulk_email_jobs` rows newest first. While any
 * job is non-terminal (pending / processing), the panel polls every 3s so
 * the ratio moves in real time — same UX as the postal-export progress
 * bar. The `Resume` button is gated on the server-side eligibility
 * (`partial` / `failed` / stalled `processing`); the API decides, the UI
 * doesn't second-guess.
 *
 * `highlightJobId` is a soft visual anchor for the row the parent wants
 * the operator's eye to land on (most commonly the job we just dispatched
 * or just resumed) — the row is rendered first if present.
 */
interface BulkEmailJobsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightJobId: string | null;
  onResumed: (newJobId: string) => void;
}

const BULK_EMAIL_POLL_MS = 3000;

function BulkEmailJobsDialog({
  open,
  onOpenChange,
  highlightJobId,
  onResumed,
}: BulkEmailJobsDialogProps) {
  const t = useTranslations("constituents.bulkEmail.jobs");
  const [jobs, setJobs] = useState<BulkEmailJobView[]>([]);
  const [loading, setLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const rows = await ConstituentService.listBulkEmailJobs(createClientApiClient());
      setJobs(rows);
    } catch (err) {
      // Console-only: a transient list error shouldn't cover the screen
      // with a toast that re-fires every 3s. The panel falls back to the
      // last-known list — same shape as the postal-export polling UI.
      console.error("bulkEmail.jobs.list failed", err);
    }
  }, []);

  // Initial fetch on open, plus poll while any job is in-flight.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void fetchJobs().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, fetchJobs]);

  const anyInFlight = useMemo(
    () => jobs.some((job) => job.status === "pending" || job.status === "processing"),
    [jobs],
  );

  useEffect(() => {
    if (!open) return;
    if (!anyInFlight) return;
    const id = setInterval(() => {
      void fetchJobs();
    }, BULK_EMAIL_POLL_MS);
    return () => clearInterval(id);
  }, [open, anyInFlight, fetchJobs]);

  const orderedJobs = useMemo(() => {
    if (!highlightJobId) return jobs;
    const anchor = jobs.find((job) => job.id === highlightJobId);
    if (!anchor) return jobs;
    return [anchor, ...jobs.filter((job) => job.id !== highlightJobId)];
  }, [jobs, highlightJobId]);

  const handleResume = useCallback(
    async (jobId: string) => {
      setResumingId(jobId);
      try {
        const next = await ConstituentService.resumeBulkEmailJob(createClientApiClient(), jobId);
        toast.success(t("resumeSuccess"));
        onResumed(next.id);
        // Optimistically prepend so the operator sees the new row before
        // the next poll tick lands.
        setJobs((prev) => [next, ...prev.filter((row) => row.id !== next.id)]);
      } catch (err) {
        // Branch on the structured code the API sets in `title`. Falls
        // back to a generic toast for transport-level errors.
        const code = err instanceof ApiProblem ? err.title : "";
        if (code === "job_still_running") {
          toast.error(t("resumeErrors.still_running"));
        } else if (code === "nothing_to_resume") {
          toast.error(t("resumeErrors.nothing_to_resume"));
        } else {
          const message =
            err instanceof ApiProblem
              ? (err.detail ?? err.title ?? t("resumeErrors.generic"))
              : t("resumeErrors.generic");
          toast.error(message);
        }
      } finally {
        setResumingId(null);
      }
    },
    [onResumed, t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void fetchJobs()}
              disabled={loading}
              aria-label={t("refresh")}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {t("refresh")}
            </Button>
          </div>
          {orderedJobs.length === 0 ? (
            <p className="text-sm text-on-surface-variant">{t("empty")}</p>
          ) : (
            <ul className="space-y-2">
              {orderedJobs.map((job) => (
                <BulkEmailJobCard
                  key={job.id}
                  job={job}
                  isHighlighted={job.id === highlightJobId}
                  onResume={() => void handleResume(job.id)}
                  resuming={resumingId === job.id}
                />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BulkEmailJobCardProps {
  job: BulkEmailJobView;
  isHighlighted: boolean;
  onResume: () => void;
  resuming: boolean;
}

function BulkEmailJobCard({ job, isHighlighted, onResume, resuming }: BulkEmailJobCardProps) {
  const t = useTranslations("constituents.bulkEmail.jobs");

  // Derived status for the badge. Stalled is a server-set boolean on top
  // of `processing`; we surface it as its own status label so the
  // operator immediately understands "this looks stuck".
  const effectiveStatus = job.stalled ? "stalled" : job.status;
  const variant: BadgeVariant =
    effectiveStatus === "completed"
      ? "success"
      : effectiveStatus === "partial" || effectiveStatus === "stalled"
        ? "warning"
        : effectiveStatus === "failed"
          ? "error"
          : "info";

  // Server already gates resume eligibility (issue #326 service); we
  // mirror the rule for an immediate UI affordance so the button isn't a
  // mystery 400 click. Pending / actively-processing rows hide the
  // button; partial / failed / stalled-processing rows expose it.
  const canResume =
    job.deliveredCount < job.totalRecipients &&
    (job.status === "partial" ||
      job.status === "failed" ||
      (job.status === "processing" && job.stalled));

  return (
    <li
      className={`rounded-md border border-outline-variant p-3 ${
        isHighlighted ? "ring-2 ring-primary/40" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium text-on-surface">{job.subject || t("subjectFallback")}</div>
        <Badge variant={variant} shape="square">
          {t(`status.${effectiveStatus}`)}
        </Badge>
      </div>
      <div className="mt-1 text-sm text-on-surface-variant">
        {t("ratio", { delivered: job.deliveredCount, total: job.totalRecipients })}
        {job.failedCount > 0 ? (
          <span className="ml-2">· {t("failedSuffix", { count: job.failedCount })}</span>
        ) : null}
      </div>
      {canResume ? (
        <div className="mt-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onResume}
            disabled={resuming}
          >
            {resuming ? t("resuming") : t("resume")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

interface AdvancedFiltersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults: {
    lastDonationFrom: string;
    lastDonationTo: string;
    minLifetimeAmountCents: string;
  };
  onApply: (values: {
    lastDonationFrom: string;
    lastDonationTo: string;
    minLifetimeAmountCents: string;
  }) => void;
}

function AdvancedFiltersDialog({
  open,
  onOpenChange,
  defaults,
  onApply,
}: AdvancedFiltersDialogProps) {
  const t = useTranslations("constituents.filters.advanced");
  const [lastDonationFrom, setLastDonationFrom] = useState(defaults.lastDonationFrom);
  const [lastDonationTo, setLastDonationTo] = useState(defaults.lastDonationTo);
  const [minLifetimeEur, setMinLifetimeEur] = useState(() => {
    const cents = Number.parseInt(defaults.minLifetimeAmountCents, 10);
    return Number.isFinite(cents) && cents > 0 ? String(cents / 100) : "";
  });

  // Re-sync when the dialog reopens with fresh defaults (e.g. after URL nav).
  useEffect(() => {
    if (open) {
      setLastDonationFrom(defaults.lastDonationFrom);
      setLastDonationTo(defaults.lastDonationTo);
      const cents = Number.parseInt(defaults.minLifetimeAmountCents, 10);
      setMinLifetimeEur(Number.isFinite(cents) && cents > 0 ? String(cents / 100) : "");
    }
  }, [defaults.lastDonationFrom, defaults.lastDonationTo, defaults.minLifetimeAmountCents, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-on-surface" htmlFor="lastDonationFrom">
              {t("lastDonationFrom")}
            </label>
            <Input
              id="lastDonationFrom"
              type="date"
              value={lastDonationFrom ? lastDonationFrom.slice(0, 10) : ""}
              onChange={(e) =>
                setLastDonationFrom(e.target.value ? `${e.target.value}T00:00:00.000Z` : "")
              }
            />
          </div>
          <div>
            <label className="text-sm font-medium text-on-surface" htmlFor="lastDonationTo">
              {t("lastDonationTo")}
            </label>
            <Input
              id="lastDonationTo"
              type="date"
              value={lastDonationTo ? lastDonationTo.slice(0, 10) : ""}
              onChange={(e) =>
                setLastDonationTo(e.target.value ? `${e.target.value}T23:59:59.999Z` : "")
              }
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium text-on-surface" htmlFor="minLifetimeEur">
              {t("minLifetime")}
            </label>
            <Input
              id="minLifetimeEur"
              type="number"
              min="0"
              step="1"
              value={minLifetimeEur}
              onChange={(e) => setMinLifetimeEur(e.target.value)}
              placeholder="500"
            />
            <p className="mt-1 text-xs text-on-surface-variant">{t("minLifetimeHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setLastDonationFrom("");
              setLastDonationTo("");
              setMinLifetimeEur("");
              onApply({ lastDonationFrom: "", lastDonationTo: "", minLifetimeAmountCents: "" });
            }}
          >
            {t("clear")}
          </Button>
          <Button
            onClick={() => {
              const cents = Number.parseFloat(minLifetimeEur);
              const minLifetimeAmountCents =
                Number.isFinite(cents) && cents > 0 ? String(Math.round(cents * 100)) : "";
              onApply({
                lastDonationFrom,
                lastDonationTo,
                minLifetimeAmountCents,
              });
            }}
          >
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConstituentRowActionsProps {
  constituent: ConstituentListRow;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
}

function ConstituentRowActions({
  constituent,
  canEdit,
  canDelete,
  onDelete,
  menuLabel,
  editLabel,
  deleteLabel,
}: ConstituentRowActionsProps) {
  if (!canEdit && !canDelete) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={menuLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {canEdit ? (
          <DropdownMenuItem asChild>
            <Link
              href={`/constituents/${constituent.id}/edit`}
              onClick={(event) => event.stopPropagation()}
            >
              <Pencil size={16} aria-hidden="true" />
              {editLabel}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canDelete ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDelete();
            }}
            className="text-error focus:text-error"
          >
            <Trash2 size={16} aria-hidden="true" />
            {deleteLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TypeMultiFilterProps {
  selected: string[];
  onChange: (next: string[]) => void;
  labels: {
    all: string;
    aria: string;
    count: (count: number) => string;
    option: (value: (typeof QUICK_FILTER_TYPES)[number]) => string;
  };
}

/**
 * Multi-value type quick filter (issue #465). A Popover-anchored checkbox list
 * whose committed value is a `string[]` written to the repeatable `?types=`
 * URL param. Mirrors the design-system pattern in
 * `constituents/filters/FilterCondition.tsx` (Popover + Checkbox). Only
 * rendered when the `constituents.multi_type` flag is on.
 */
function TypeMultiFilter({ selected, onChange, labels }: TypeMultiFilterProps) {
  const selectedSet = new Set(selected);
  const toggle = (value: string) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(QUICK_FILTER_TYPES.filter((t) => next.has(t)));
  };

  const triggerLabel =
    selected.length === 0
      ? labels.all
      : selected.length <= 2
        ? QUICK_FILTER_TYPES.filter((t) => selectedSet.has(t))
            .map((t) => labels.option(t))
            .join(", ")
        : labels.count(selected.length);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full justify-between sm:w-[180px]"
          aria-label={labels.aria}
        >
          <span className="truncate text-left">{triggerLabel}</span>
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        <ul className="max-h-64 overflow-y-auto">
          {QUICK_FILTER_TYPES.map((value) => {
            const checked = selectedSet.has(value);
            return (
              <li key={value}>
                <button
                  type="button"
                  onClick={() => toggle(value)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-container-low focus-visible:bg-surface-container-low focus-visible:outline-none"
                  aria-pressed={checked}
                >
                  <CheckboxVisual checked={checked} />
                  <span className="flex-1 truncate">{labels.option(value)}</span>
                  {checked ? <Check size={14} aria-hidden="true" className="opacity-60" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
