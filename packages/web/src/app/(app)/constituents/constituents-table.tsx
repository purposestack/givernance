"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useTransition } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { type Constituent, fullName, initials } from "@/models/constituent";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const TYPE_VARIANTS: Record<string, BadgeVariant> = {
  donor: "success",
  volunteer: "info",
  member: "warning",
  beneficiary: "warning",
  partner: "neutral",
};

const KNOWN_TYPES = new Set(["donor", "volunteer", "member", "beneficiary", "partner"]);

function translateType(
  tType: (key: "donor" | "volunteer" | "member" | "beneficiary" | "partner") => string,
  type: string,
): string {
  if (KNOWN_TYPES.has(type)) {
    return tType(type as "donor" | "volunteer" | "member" | "beneficiary" | "partner");
  }
  return type;
}

interface ConstituentsTableProps {
  constituents: Constituent[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
}

export function ConstituentsTable({ constituents, pagination }: ConstituentsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("constituents");
  const tType = useTranslations("constituents.types");

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

  const columns = useMemo<ColumnDef<Constituent>[]>(
    () => [
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
        cell: ({ row }) => {
          const type = String(row.original.type);
          const variant = TYPE_VARIANTS[type] ?? "neutral";
          const label = translateType(tType, type);
          return <Badge variant={variant}>{label}</Badge>;
        },
      },
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.email ?? "—"}</span>
        ),
      },
      {
        id: "lastDonation",
        header: () => t("columns.lastDonation"),
        enableSorting: false,
        cell: () => <span className="text-on-surface-variant">—</span>,
      },
    ],
    [t, tType],
  );

  return (
    <div
      className={cn("transition-opacity duration-normal", isPending ? "opacity-60" : "opacity-100")}
      aria-busy={isPending || undefined}
    >
      <DataTable
        columns={columns}
        data={constituents}
        pagination={pagination}
        onPageChange={navigateToPage}
        emptyState={
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.description")} />
        }
      />
    </div>
  );
}
