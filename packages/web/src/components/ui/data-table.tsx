"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type Header,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, Rows2, Rows3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Density = "comfortable" | "compact";

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
  pagination: DataTablePagination;
  /**
   * Navigate to a new page — the DataTable is stateless about transport,
   * the caller wires this to router.push / searchParams updates.
   */
  onPageChange: (page: number) => void;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
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

function sortDirectionIndicator(sort: "asc" | "desc" | false) {
  if (sort === "asc") return " ▲";
  if (sort === "desc") return " ▼";
  return "";
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
          className="inline-flex items-center gap-1 hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          {content}
          {sortDirectionIndicator(sortDirection)}
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
  emptyState,
  defaultDensity = "comfortable",
  className,
}: DataTableProps<TData>) {
  const t = useTranslations("dataTable");
  const [density, setDensity] = useState<Density>(defaultDensity);
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);

  const sorting = controlledSorting ?? internalSorting;
  const setSorting = onSortingChange ?? setInternalSorting;

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
    },
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: pagination.totalPages,
  });

  const hasRows = data.length > 0;
  const rowPadding = densityClasses[density].row;
  const headerPadding = densityClasses[density].header;

  const rangeStart = hasRows ? (pagination.page - 1) * pagination.perPage + 1 : 0;
  const rangeEnd = hasRows ? Math.min(pagination.page * pagination.perPage, pagination.total) : 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl bg-surface-container-lowest shadow-card",
        className,
      )}
    >
      <div className="flex flex-col gap-3 border-b border-outline-variant px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-on-surface-variant">
          {hasRows
            ? t("rangeSummary", {
                start: rangeStart,
                end: rangeEnd,
                total: pagination.total,
              })
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
              "flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-normal ease-out",
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
              "flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-normal ease-out",
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
        <table className="w-full border-collapse text-left">
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
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-t border-outline-variant transition-colors duration-normal ease-out hover:bg-surface-container-low",
                    onRowClick && "cursor-pointer",
                  )}
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
                <td colSpan={columns.length} className="px-5">
                  {emptyState}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasRows ? (
        <div className="flex flex-col gap-3 border-t border-outline-variant px-5 py-3 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
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
