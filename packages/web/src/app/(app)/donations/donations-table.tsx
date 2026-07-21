"use client";

import type { CustomFieldDefinition } from "@givernance/shared/custom-fields";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Gift, MoreHorizontal, Pencil, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { FilterBuilder, FilterChip } from "@/components/constituents/filters";
import { chipsFromQuery } from "@/components/constituents/filters/filter-chip-helpers";
import {
  type FilterCondition as FilterConditionType,
  type FilterQuery,
  isFilterCondition,
} from "@/components/constituents/filters/filter-types";
import {
  DONATION_FILTER_ENDPOINTS,
  DONATION_FILTERS_NAMESPACE,
  useDonationFilterCatalog,
} from "@/components/donations/filters";
import { buildCustomFieldColumns } from "@/components/shared/custom-fields";
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
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  type DonationListRow,
  type DonationSortField,
  type DonationSortOrder,
  donationDonorName,
  type ReceiptStatus,
} from "@/models/donation";
import { DonationService } from "@/services/DonationService";
import { DonationsFiltersButton } from "./donations-filters";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const RECEIPT_VARIANTS: Record<ReceiptStatus, BadgeVariant> = {
  generated: "success",
  pending: "warning",
  failed: "error",
};

/**
 * Parse the shareable `?filters=` URL param into a FilterQuery, or null when
 * absent/unparseable/malformed. The server component runs the same JSON.parse
 * guard before forwarding the param to the API, so both sides agree on what
 * counts as "no filter". (Mirror of the constituents-table helper.)
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
 * Translate the legacy basic-dialog date params into DSL conditions so an
 * operator upgrading from a bookmarked `?dateFrom=&dateTo=` URL opens the
 * builder pre-seeded with the equivalent query instead of an empty one.
 */
function legacyParamsToConditions(dateFrom: string, dateTo: string): FilterConditionType[] {
  const conditions: FilterConditionType[] = [];
  if (dateFrom) {
    conditions.push({
      id: "legacy-date-from",
      field: "donation.donatedAt",
      operator: "gte",
      value: dateFrom,
    });
  }
  if (dateTo) {
    conditions.push({
      id: "legacy-date-to",
      field: "donation.donatedAt",
      operator: "lte",
      value: dateTo,
    });
  }
  return conditions;
}

interface DonationsTableProps {
  donations: DonationListRow[];
  pagination: DataTablePagination;
  canWrite: boolean;
  canDelete: boolean;
  /** URL-driven date-range filter values (YYYY-MM-DD or empty). */
  dateFrom: string;
  dateTo: string;
  /**
   * Server-resolved sort field from `searchParams` (validated against the
   * `DONATION_SORT_FIELDS` whitelist on the page). Mirrors the
   * tenants-table (admin) pattern: the table renders the indicator from
   * this prop and pushes new query params on click — sorting always
   * round-trips through the API, never via TanStack's local sort.
   */
  sort: DonationSortField;
  order: DonationSortOrder;
  /**
   * Epic #539 — donation-domain custom columns rendered from `row.custom`.
   * Empty (flag off / no defs) ⇒ no custom columns, table identical to today.
   */
  customFieldDefs?: CustomFieldDefinition[];
  /**
   * Epic #539 §6 — projected (showOnRelated ∧ ¬sensitive) constituent
   * definitions rendered as donor columns from `row.donorCustom`.
   */
  donorCustomDefs?: CustomFieldDefinition[];
  /**
   * `true` when the `donations.advanced_filters` flag is on. On → the
   * "More filters" button opens the full FilterBuilder (donation-domain
   * query DSL, live count) and the applied query lives in the shareable
   * `?filters=` URL param, rendered as a chip strip. Off → the legacy basic
   * date dialog renders unchanged and every advanced surface (button
   * behaviour, chips, param handling) is completely absent.
   */
  advancedFiltersEnabled?: boolean;
  /**
   * `true` when the server rejected the URL's `?filters=` value (hand-edited
   * or stale shared link). The table shows the unfiltered list plus an
   * inline notice instead of silently pretending the filter applied.
   */
  advancedFilterInvalid?: boolean;
}

export function DonationsTable({
  donations,
  pagination,
  canWrite,
  canDelete,
  sort,
  order,
  dateFrom,
  dateTo,
  customFieldDefs = [],
  donorCustomDefs = [],
  advancedFiltersEnabled = false,
  advancedFilterInvalid = false,
}: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("donations");
  const tReceipt = useTranslations("donations.receiptStatus");
  const tFilters = useTranslations("donations.filters");
  const tCustom = useTranslations("customFields");
  const [donationToDelete, setDonationToDelete] = useState<DonationListRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const initialSearch = searchParams.get("search") ?? "";
  const initialReceipt = searchParams.get("receiptStatus") ?? "all";
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  // Issue #216: surface a pending state on the table during URL-driven
  // round-trips. `isPending` flips true while the server resolves the
  // new sort/filter/page slice and flips back when the new RSC payload
  // commits. Wiring router.push/replace inside `startTransition` is the
  // canonical Next.js App Router pattern for this.
  const [isPending, startTransition] = useTransition();

  // ── donations.advanced_filters: DSL filters on the list page ─────────
  // (mirror of the constituents Epic #418 integration — the URL param is
  // the single source of truth so filtered views are shareable links).
  const [builderOpen, setBuilderOpen] = useState(false);
  const filtersParam = searchParams.get("filters");
  const activeAdvancedQuery = useMemo(
    () => (advancedFiltersEnabled ? parseFiltersParam(filtersParam) : null),
    [advancedFiltersEnabled, filtersParam],
  );

  /**
   * Legacy `?dateFrom=/?dateTo=` params translated to an equivalent DSL
   * query (flag on, no DSL applied). Rendering these through the SAME chip
   * strip gives a bookmarked pre-DSL URL a one-click clear affordance —
   * without it the builder button shows "active" but the only way to remove
   * the date restriction is a non-obvious apply-then-clear two-step.
   */
  const legacyQuery = useMemo<FilterQuery | null>(() => {
    if (!advancedFiltersEnabled || activeAdvancedQuery) return null;
    const legacy = legacyParamsToConditions(dateFrom, dateTo);
    return legacy.length > 0 ? { operator: "AND", conditions: legacy } : null;
  }, [advancedFiltersEnabled, activeAdvancedQuery, dateFrom, dateTo]);

  /** What the chip strip renders: the applied DSL, else the legacy params. */
  const stripQuery = activeAdvancedQuery ?? legacyQuery;

  // Static catalog immediately; per-org campaign/fund options once a filter
  // surface is actually in play (never fetched with the flag off).
  const filterCatalog = useDonationFilterCatalog(
    advancedFiltersEnabled && (builderOpen || stripQuery !== null),
  );

  const advancedChips = useMemo(
    () =>
      stripQuery
        ? // No pattern flags in the donations DSL — the label resolver is a
          // pass-through that can never be reached.
          chipsFromQuery(stripQuery, (pattern) => pattern, filterCatalog)
        : [],
    [stripQuery, filterCatalog],
  );

  /**
   * Write (or clear, with `null`) the applied DSL to the URL. Applying a DSL
   * query clears the legacy basic-dialog params (`dateFrom`/`dateTo` — and
   * the API-level `amountMin`/`amountMax` should a hand-built URL carry
   * them): the DSL subsumes them and the two systems must never AND together
   * invisibly.
   */
  const writeAdvancedQuery = useCallback(
    (query: FilterQuery | null) => {
      const params = new URLSearchParams(searchParams.toString());
      const isEmpty = !query || query.conditions.length === 0;
      if (isEmpty) {
        params.delete("filters");
      } else {
        params.set("filters", JSON.stringify(query));
      }
      params.delete("dateFrom");
      params.delete("dateTo");
      params.delete("amountMin");
      params.delete("amountMax");
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
    async (query: FilterQuery) => {
      writeAdvancedQuery(query);
    },
    [writeAdvancedQuery],
  );

  /**
   * Remove one chip from the applied query (rewrites `?filters=`). In legacy
   * mode the remaining condition (if any) is upgraded to a DSL query —
   * `writeAdvancedQuery` clears the legacy params either way, so the URL
   * never mixes the two systems.
   */
  const removeAdvancedChip = useCallback(
    (chipId: string) => {
      if (!stripQuery) return;
      writeAdvancedQuery({
        ...stripQuery,
        conditions: stripQuery.conditions.filter((c) => !isFilterCondition(c) || c.id !== chipId),
      });
    },
    [stripQuery, writeAdvancedQuery],
  );

  /**
   * What the builder opens with: the currently-applied query (so reopening
   * edits in place), or the legacy date params translated to DSL conditions
   * (so a bookmarked pre-DSL URL upgrades seamlessly).
   */
  const builderInitialQuery = useMemo<FilterQuery | undefined>(() => {
    if (activeAdvancedQuery) return activeAdvancedQuery;
    const legacy = legacyParamsToConditions(dateFrom, dateTo);
    return legacy.length > 0 ? { operator: "AND", conditions: legacy } : undefined;
  }, [activeAdvancedQuery, dateFrom, dateTo]);

  const hasActiveAdvancedFilters = activeAdvancedQuery !== null || Boolean(dateFrom || dateTo);

  // Server-side search: see campaigns-table.tsx for the rationale on why
  // `searchParams` is excluded from the deps.
  // Issue #217: search/filter/sort changes use `router.replace` instead
  // of `push` — back button should escape the page, not unwind every
  // header click. Pagination still uses `push` (meaningful navigation
  // users may want to retrace).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (searchTerm === initialSearch) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (searchTerm) {
        params.set("search", searchTerm);
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

  const updateReceipt = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next && next !== "all") {
        params.set("receiptStatus", next);
      } else {
        params.delete("receiptStatus");
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

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

  // Drive the DataTable's sort indicator from the server-resolved `sort` /
  // `order` URL params, not from local TanStack state. Without this, click
  // → URL update → re-render would briefly show the OLD direction's arrow
  // (DataTable's internal state lags the server round-trip by one paint).
  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [order, sort],
  );

  // Header click handler. Replaces (not pushes) the URL with the new
  // `?sort=&order=` and resets the page back to 1 — paginating into a
  // sorted slice is meaningless when the slice itself just shifted.
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
    if (!donationToDelete) {
      return;
    }

    setIsDeleting(true);
    try {
      await DonationService.deleteDonation(createClientApiClient(), donationToDelete.id);
      toast.success(t("success.deleted"));
      setDonationToDelete(null);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof ApiProblem
          ? (error.detail ?? error.title ?? t("errors.deleteGeneric"))
          : t("errors.deleteGeneric");
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }, [donationToDelete, router, t]);

  const columns = useMemo<ColumnDef<DonationListRow>[]>(
    () => [
      // Column `id` matches the API's `sort=` value (cf.
      // `DONATION_SORT_FIELDS` in the route). Every server-sortable
      // column needs an `accessorKey` or `accessorFn` even in manual-
      // sort mode — TanStack's `getCanSort()` returns false (and skips
      // the header arrow) when a column has no accessor, regardless of
      // `enableSorting`. The accessor's extracted value is unused on
      // the server-sort path; only the column's `id` reaches the API.
      {
        id: "donatedAt",
        accessorKey: "donatedAt",
        header: () => t("columns.date"),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.donatedAt, locale, "short")}
          </span>
        ),
      },
      {
        id: "donor",
        accessorFn: (row) => donationDonorName(row) ?? "",
        header: () => t("columns.donor"),
        cell: ({ row }) => {
          const name = donationDonorName(row.original) ?? t("anonymousDonor");
          return (
            <Link
              href={`/constituents/${row.original.constituentId}`}
              onClick={(event) => event.stopPropagation()}
              className="font-medium text-on-surface hover:text-primary hover:underline"
            >
              {name}
            </Link>
          );
        },
      },
      {
        id: "amountCents",
        accessorKey: "amountCents",
        header: () => <span className="block text-right">{t("columns.amount")}</span>,
        cell: ({ row }) => (
          <span className="block text-right font-mono font-semibold tabular-nums text-on-surface">
            {formatCurrency(row.original.amountCents, locale, row.original.currency)}
          </span>
        ),
      },
      {
        id: "campaign",
        accessorFn: (row) => row.campaign?.name ?? "",
        header: () => t("columns.campaign"),
        cell: ({ row }) =>
          row.original.campaign ? (
            <span className="truncate text-on-surface-variant">{row.original.campaign.name}</span>
          ) : (
            <span className="text-on-surface-variant opacity-60">—</span>
          ),
      },
      {
        id: "paymentMethod",
        accessorKey: "paymentMethod",
        header: () => t("columns.paymentMethod"),
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.paymentMethod ?? "—"}</span>
        ),
      },
      {
        id: "receipt",
        header: () => t("columns.receipt"),
        enableSorting: false,
        cell: ({ row }) => {
          const status = row.original.receiptStatus;
          if (!status) {
            return <span className="text-on-surface-variant opacity-60">—</span>;
          }
          return <Badge variant={RECEIPT_VARIANTS[status]}>{t(`receiptStatus.${status}`)}</Badge>;
        },
      },
      // Epic #539 — donation-domain custom columns, then the donor projection
      // (§6). Both flag-gated by the page: empty defs spread nothing.
      ...buildCustomFieldColumns<DonationListRow>(customFieldDefs, {
        locale,
        getValues: (row) => row.custom,
        booleanLabels: { yes: tCustom("boolean.yes"), no: tCustom("boolean.no") },
      }),
      ...buildCustomFieldColumns<DonationListRow>(donorCustomDefs, {
        locale,
        getValues: (row) => row.donorCustom,
        idPrefix: "donorCustom",
        booleanLabels: { yes: tCustom("boolean.yes"), no: tCustom("boolean.no") },
      }),
      // Drop the actions column entirely when no row action is available,
      // so we don't render an `sr-only` "Actions" header above empty cells.
      // Mirrors the constituents-table pattern from PR #170.
      ...(canWrite || canDelete
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: DonationListRow } }) => (
                <DonationActions
                  donation={row.original}
                  canEdit={canWrite}
                  canDelete={canDelete}
                  onDelete={() => setDonationToDelete(row.original)}
                  menuLabel={t("actions.menu", {
                    name: donationDonorName(row.original) ?? t("anonymousDonor"),
                  })}
                  editLabel={t("actions.edit")}
                  deleteLabel={t("actions.delete")}
                />
              ),
            } satisfies ColumnDef<DonationListRow>,
          ]
        : []),
    ],
    [canDelete, canWrite, customFieldDefs, donorCustomDefs, locale, t, tCustom],
  );

  return (
    <>
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
        <Select value={initialReceipt} onValueChange={updateReceipt}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={tFilters("receiptLabel")}>
            <SelectValue placeholder={tFilters("receiptLabel")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tFilters("allReceipts")}</SelectItem>
            <SelectItem value="generated">{tReceipt("generated")}</SelectItem>
            <SelectItem value="pending">{tReceipt("pending")}</SelectItem>
            <SelectItem value="failed">{tReceipt("failed")}</SelectItem>
          </SelectContent>
        </Select>
        {/* donations.advanced_filters — flag on: the real FilterBuilder
            (donation DSL, live count) replaces the basic date dialog as THE
            filter entry point. Flag off: the legacy basic dialog renders
            unchanged (surface byte-for-byte what it was). */}
        {advancedFiltersEnabled ? (
          <Button
            type="button"
            variant={hasActiveAdvancedFilters ? "primary" : "secondary"}
            size="sm"
            onClick={() => setBuilderOpen(true)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            {tFilters("builderLabel")}
            {hasActiveAdvancedFilters ? <Badge variant="info">•</Badge> : null}
          </Button>
        ) : (
          <DonationsFiltersButton dateFrom={dateFrom} dateTo={dateTo} />
        )}
      </div>

      {/* Active-filter strip (flag on). Static shell like the search row
          above (ADR-035 rule A1): no entrance animation, instantly
          interactive. Every chip is removable; removal rewrites `?filters=`
          so the URL stays the single source of truth. Legacy date params
          render through the same strip (see `legacyQuery`) so they are just
          as clearable as a DSL query. */}
      {advancedFiltersEnabled && stripQuery ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-on-surface-variant">
            {tFilters("strip.label")}
          </span>
          {advancedChips.map((chip) => (
            <FilterChip
              key={chip.id}
              filter={chip}
              fields={filterCatalog}
              namespace={DONATION_FILTERS_NAMESPACE}
              onRemove={removeAdvancedChip}
            />
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
        data={donations}
        pagination={pagination}
        onPageChange={navigateToPage}
        sorting={sorting}
        onSortingChange={onSortingChange}
        isPending={isPending}
        // ADR-035 rules A2/A3 — the table container is slot 0 of the
        // content cascade (container before content), rows follow from
        // slot 1. The DataTable gates the replay on the mount-time data +
        // sorting references (rule B12), so search keystrokes / filter /
        // sort / pagination stay instant.
        className="reveal-item"
        animateEntrance
        entranceCascadeOffset={1}
        onRowClick={(row) => router.push(`/donations/${row.original.id}`)}
        emptyState={
          <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.description")} />
        }
      />

      {/* The full FilterBuilder (flag on). The `key` remounts it whenever
          the applied query changes so its internal useState re-seeds from
          `initialQuery` (the builder resets to empty after each apply;
          without the remount, reopening would edit a stale draft instead of
          the currently-applied filter). No presets: LYBUNT & co are
          constituent-grain and don't transpose to the donation row grain. */}
      {advancedFiltersEnabled ? (
        <FilterBuilder
          key={filtersParam ?? "no-filter"}
          open={builderOpen}
          onOpenChange={setBuilderOpen}
          onApply={applyAdvancedQuery}
          initialQuery={builderInitialQuery}
          fields={filterCatalog}
          namespace={DONATION_FILTERS_NAMESPACE}
          previewEndpoint={DONATION_FILTER_ENDPOINTS.preview}
          suggestionsEndpoint={DONATION_FILTER_ENDPOINTS.suggestions}
          showPresets={false}
        />
      ) : null}

      <AlertDialog
        open={donationToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDonationToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {donationToDelete
                ? t("deleteDialog.description", {
                    name: donationDonorName(donationToDelete) ?? t("anonymousDonor"),
                  })
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

interface DonationActionsProps {
  donation: DonationListRow;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
}

function DonationActions({
  donation,
  canEdit,
  canDelete,
  onDelete,
  menuLabel,
  editLabel,
  deleteLabel,
}: DonationActionsProps) {
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
              href={`/donations/${donation.id}/edit`}
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
