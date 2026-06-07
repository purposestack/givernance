// @ts-nocheck
"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
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
import { ConstituentTypeBadge } from "@/components/constituents/constituent-type-badge";
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
  /** Server-resolved sort/order — see donations-table.tsx for rationale. */
  sort: ConstituentSortField;
  order: ConstituentSortOrder;
}

export function ConstituentsTable({
  constituents,
  pagination,
  canManageAdminActions,
  canWrite,
  bulkEmailEnabled,
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

  const initialLastDonationFrom = searchParams.get("lastDonationFrom") ?? "";
  const initialLastDonationTo = searchParams.get("lastDonationTo") ?? "";
  const initialMinLifetime = searchParams.get("minLifetimeAmountCents") ?? "";

  const hasActiveAdvancedFilters =
    initialLastDonationFrom !== "" || initialLastDonationTo !== "" || initialMinLifetime !== "";
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
        cell: ({ row }) => <ConstituentTypeBadge type={String(row.original.type)} />,
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
      selectedIds,
      t,
      togglePageSelection,
    ],
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
        <Button
          type="button"
          variant={hasActiveAdvancedFilters ? "primary" : "secondary"}
          size="sm"
          onClick={() => setAdvancedFiltersOpen(true)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          {tFilters("advancedLabel")}
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

      <DataTable
        columns={columns}
        data={constituents}
        pagination={pagination}
        onPageChange={navigateToPage}
        sorting={sorting}
        onSortingChange={onSortingChange}
        isPending={isPending}
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
              placeholder="0"
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
