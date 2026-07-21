"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type Header,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Rows2,
  Rows3,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Density = "comfortable" | "compact";

/**
 * ADR-035 rule A2 — the entrance cascade covers the first 6 rows; rows
 * past the cap enter together on the last step so a 100-row page never
 * stretches the choreography past the 1 s budget (rule A4). Animated
 * rows also set a local `--stagger-step: 25ms` (half the page-level
 * rhythm): rows are interactive targets, and the invisible-but-clickable
 * window must stay short — the worst-case row settles well under 500 ms.
 */
const ENTRANCE_ROW_CAP = 6;

export interface DataTablePagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface DataTableProps<TData> {
  /** Optional callback fired when a row is clicked */
  onRowClick?: (row: import("@tanstack/react-table").Row<TData>) => void;
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  /**
   * Pagination metadata. Omit for inherently unpaginated lists (e.g.
   * `/v1/users` returns the full members array — issue #161). When omitted,
   * the table hides the range summary and the prev/next footer; the data
   * is rendered as-is.
   */
  pagination?: DataTablePagination;
  /**
   * Navigate to a new page — the DataTable is stateless about transport,
   * the caller wires this to router.push / searchParams updates. Required
   * when `pagination` is provided; ignored otherwise.
   */
  onPageChange?: (page: number) => void;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /**
   * When `true`, the table dims and goes non-interactive while a sort/
   * filter/page round-trip is in flight (issue #216). Caller wires this
   * to `useTransition`'s `isPending`. Also surfaces `aria-busy` for
   * screen-reader users.
   */
  isPending?: boolean;
  /**
   * Opt-in entrance choreography (ADR-035 rule A2): the first
   * ENTRANCE_ROW_CAP (6) rows cascade in via the fade-only
   * `.row-reveal` utility (opacity only — `translateY` on a `<tr>`
   * de-collapses the table borders in WebKit), once per mount only.
   * Gated on the mount-time `data` reference AND the mount-time sorting
   * state — every filter/pagination/refetch round-trip swaps in a NEW
   * array, and any sort (uncontrolled header click included) swaps the
   * sorting state, which disables the animation classes, so data swaps
   * and re-sorts never replay the entrance (rule B12).
   */
  animateEntrance?: boolean;
  /**
   * Reading-order offset for the entrance cascade — set to the number
   * of cascade slots above the rows (e.g. `1` when the table container
   * itself is a `.reveal-item` at slot 0) so rows enter after them
   * (ADR-035 rule A2). Ignored unless `animateEntrance` is set.
   */
  entranceCascadeOffset?: number;
  emptyState?: React.ReactNode;
  defaultDensity?: Density;
  className?: string;
}

const densityClasses: Record<Density, { row: string; header: string }> = {
  comfortable: { row: "py-4", header: "py-3" },
  compact: { row: "py-3", header: "py-2.5" },
};

function sortDirectionAriaValue(sort: "asc" | "desc" | false) {
  if (sort === "asc") return "ascending" as const;
  if (sort === "desc") return "descending" as const;
  return "none" as const;
}

function SortDirectionIndicator({ sort }: { sort: "asc" | "desc" | false }) {
  if (sort === "asc") return <ArrowUp size={14} aria-hidden="true" />;
  if (sort === "desc") return <ArrowDown size={14} aria-hidden="true" />;
  return <ArrowUpDown size={14} aria-hidden="true" className="opacity-60" />;
}

interface HeaderCellProps<TData> {
  header: Header<TData, unknown>;
  padding: string;
}

function HeaderCell<TData>({ header, padding }: HeaderCellProps<TData>) {
  const isSortable = header.column.getCanSort();
  const sortDirection = header.column.getIsSorted();
  const content = flexRender(header.column.columnDef.header, header.getContext());
  const metaClassName = (header.column.columnDef.meta as { className?: string } | undefined)
    ?.className;

  return (
    <th
      scope="col"
      className={cn("px-5 font-medium", padding, metaClassName)}
      aria-sort={sortDirectionAriaValue(sortDirection)}
    >
      {isSortable ? (
        <button
          type="button"
          onClick={header.column.getToggleSortingHandler()}
          className="inline-flex items-center gap-1 rounded-sm hover:text-on-surface focus-visible:outline-none focus-visible:shadow-ring"
        >
          {content}
          <SortDirectionIndicator sort={sortDirection} />
        </button>
      ) : (
        content
      )}
    </th>
  );
}

export function DataTable<TData>({
  onRowClick,
  columns,
  data,
  pagination,
  onPageChange,
  sorting: controlledSorting,
  onSortingChange,
  isPending = false,
  animateEntrance = false,
  entranceCascadeOffset = 0,
  emptyState,
  defaultDensity = "comfortable",
  className,
}: DataTableProps<TData>) {
  const t = useTranslations("dataTable");
  const [density, setDensity] = useState<Density>(defaultDensity);
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);

  // ADR-035 rule B12 — the entrance runs once per mount, never on data
  // swaps. Filter/pagination/refetch round-trips always deliver a new
  // array reference, so reference equality against the mount-time array
  // is the gate: the first dataset animates, every later swap renders
  // animation-free. Client-only re-renders (density toggle, row
  // selection) keep the same reference AND the same row DOM nodes, so
  // the one-shot CSS animation never restarts either.
  const initialData = useRef(data);
  // Sort gate: an UNCONTROLLED header click sorts locally without
  // changing the `data` reference, but it reorders the row DOM — which
  // would replay the entrance on the sorted order. Any sorting change
  // (controlled or internal) produces a new state reference and drops
  // the animation classes too.
  const initialSorting = useRef(controlledSorting ?? internalSorting);
  const animateRows =
    animateEntrance &&
    data === initialData.current &&
    (controlledSorting ?? internalSorting) === initialSorting.current;

  const sorting = controlledSorting ?? internalSorting;
  const setSorting = onSortingChange ?? setInternalSorting;
  const manualSorting = controlledSorting !== undefined || onSortingChange !== undefined;

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    manualPagination: true,
    manualSorting,
    // In controlled mode the URL always carries a server default (e.g.
    // donatedAt desc) — the user can never truly "unsort." Without this,
    // clicking a column whose current direction conflicts with TanStack's
    // inferred firstSortDir hits the "remove sort" branch, the page falls
    // back to the same default, and the click looks like a no-op.
    enableSortingRemoval: !manualSorting,
    pageCount: pagination?.totalPages ?? 1,
  });

  const hasRows = data.length > 0;
  const rowPadding = densityClasses[density].row;
  const headerPadding = densityClasses[density].header;

  const rangeStart = hasRows && pagination ? (pagination.page - 1) * pagination.perPage + 1 : 0;
  const rangeEnd =
    hasRows && pagination
      ? Math.min(pagination.page * pagination.perPage, pagination.total)
      : data.length;

  return (
    <div
      // Issue #216: while a sort/filter/page round-trip is in flight,
      // dim the table and disable pointer events so rage-clicks don't
      // queue conflicting URL updates. `data-pending` on the wrapper +
      // `aria-busy` on the table together cover sighted and SR users.
      data-pending={isPending || undefined}
      className={cn(
        "overflow-hidden rounded-2xl border border-border-brand bg-surface-container-lowest transition-opacity duration-[var(--duration-normal)]",
        "data-[pending=true]:pointer-events-none data-[pending=true]:opacity-60",
        className,
      )}
    >
      <div className="flex flex-col gap-3 border-b border-border-brand px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-on-surface-variant">
          {/*
           * Review D6 — when the table has no `pagination` prop, suppress
           * the row count entirely. The page header subtitle already
           * surfaces the canonical count (e.g. "5 members on file"); a
           * second "5 results" below it reads as redundant chrome. This
           * also removes the unused `countSummary` translation path —
           * keep the key in messages/* for future per-table fallback.
           */}
          {hasRows
            ? pagination
              ? t("rangeSummary", {
                  start: rangeStart,
                  end: rangeEnd,
                  total: pagination.total,
                })
              : ""
            : t("emptySummary")}
        </div>
        <div
          className="flex items-center gap-1 self-end text-on-surface-variant sm:self-auto"
          role="toolbar"
          aria-label={t("densityLabel")}
        >
          <button
            type="button"
            onClick={() => setDensity("comfortable")}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-normal)] ease-out",
              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
              density === "comfortable"
                ? "bg-surface-container text-on-surface"
                : "hover:bg-surface-container-low hover:text-on-surface",
            )}
            aria-label={t("densityComfortable")}
            aria-pressed={density === "comfortable"}
            title={t("densityComfortable")}
          >
            <Rows2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setDensity("compact")}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-normal)] ease-out",
              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
              density === "compact"
                ? "bg-surface-container text-on-surface"
                : "hover:bg-surface-container-low hover:text-on-surface",
            )}
            aria-label={t("densityCompact")}
            aria-pressed={density === "compact"}
            title={t("densityCompact")}
          >
            <Rows3 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left" aria-busy={isPending || undefined}>
          <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <HeaderCell key={header.id} header={header} padding={headerPadding} />
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {hasRows ? (
              table.getRowModel().rows.map((row, index) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-t border-border-brand transition-colors duration-[var(--duration-normal)] ease-out hover:bg-surface-container-low",
                    onRowClick && "cursor-pointer",
                    animateRows && "row-reveal",
                  )}
                  style={
                    animateRows
                      ? ({
                          "--cascade-i":
                            entranceCascadeOffset + Math.min(index, ENTRANCE_ROW_CAP - 1),
                          // Local rhythm — rows tick at half the page-level
                          // stagger so the last animated row settles fast
                          // (interactive surface, rule A4).
                          "--stagger-step": "25ms",
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => {
                    const metaClassName = (
                      cell.column.columnDef.meta as { className?: string } | undefined
                    )?.className;
                    return (
                      <td
                        key={cell.id}
                        className={cn(
                          "px-5 text-sm text-on-surface align-middle",
                          rowPadding,
                          metaClassName,
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            ) : (
              <tr>
                {/*
                 * Empty-state cell: data rows get their vertical rhythm from
                 * `rowPadding`, but this cell hosts a block component, so it
                 * needs its own `py-5` — without it the empty state sits
                 * flush against the thead border above and the container
                 * edge below (the pagination footer is hidden when
                 * `!hasRows`). Fixed here once for every DataTable consumer.
                 */}
                <td colSpan={columns.length} className="px-5 py-5">
                  {emptyState}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasRows && pagination && onPageChange ? (
        <div className="flex flex-col gap-3 border-t border-border-brand px-5 py-3 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
          <span>
            {t("pageOf", { page: pagination.page, totalPages: Math.max(pagination.totalPages, 1) })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              aria-label={t("previousPage")}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              aria-label={t("nextPage")}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
