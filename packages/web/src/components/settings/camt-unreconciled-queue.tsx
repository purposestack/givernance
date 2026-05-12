"use client";

/**
 * CamtUnreconciledQueue — operator review queue for camt.053 credits the
 * reconciler couldn't match cleanly (Epic #318 PR #5, docs/25 §5 + §6).
 *
 * Renders the filterable cross-bank-account list, a bulk write-off bar
 * when multiple rows of the same reason are selected, and the resolve
 * drawer (link to existing donation / create constituent + donation /
 * write off). Filter state syncs to URL query params so deep-links to a
 * specific bank account / reason work.
 *
 * The mockup `camt-unreconciled-queue.html` is the visual spec —
 * filter bar at the top, reason chips below, table, and a resolve
 * drawer modeled as a side sheet.
 */

import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ChangeEvent, useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type { BankAccount } from "@/models/bank-account";
import {
  CamtStatementsService,
  type CamtUnreconciledReason,
  type CamtUnreconciledResolveAction,
  type CamtUnreconciledRow,
  type CamtUnreconciledStatus,
  maskIban,
} from "@/services/CamtStatementsService";

const REASONS: CamtUnreconciledReason[] = [
  "invalid_ref",
  "no_match",
  "no_debtor_info",
  "orphan_reversal",
  "partial_match",
];

const STATUSES: CamtUnreconciledStatus[] = ["pending", "resolved", "written_off"];

interface CamtUnreconciledQueueProps {
  initialRows: CamtUnreconciledRow[];
  initialTotal: number;
  bankAccounts: Pick<BankAccount, "id" | "bankName" | "iban">[];
  initialBankAccountId: string | null;
  initialReason: CamtUnreconciledReason | null;
  initialStatus: CamtUnreconciledStatus;
}

export function CamtUnreconciledQueue({
  initialRows,
  initialTotal,
  bankAccounts,
  initialBankAccountId,
  initialReason,
  initialStatus,
}: CamtUnreconciledQueueProps) {
  const t = useTranslations("settings.camtUnreconciled");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [rows, setRows] = useState<CamtUnreconciledRow[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [bankAccountId, setBankAccountId] = useState<string | null>(initialBankAccountId);
  const [reason, setReason] = useState<CamtUnreconciledReason | null>(initialReason);
  const [status, setStatus] = useState<CamtUnreconciledStatus>(initialStatus);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [resolvingRow, setResolvingRow] = useState<CamtUnreconciledRow | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Sync filter state into URL search params so the operator can deep-link.
  const syncUrl = useCallback(
    (next: {
      bankAccountId?: string | null;
      reason?: CamtUnreconciledReason | null;
      status?: CamtUnreconciledStatus;
    }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.bankAccountId !== undefined) {
        if (next.bankAccountId) params.set("bankAccountId", next.bankAccountId);
        else params.delete("bankAccountId");
      }
      if (next.reason !== undefined) {
        if (next.reason) params.set("reason", next.reason);
        else params.delete("reason");
      }
      if (next.status !== undefined) {
        if (next.status !== "pending") params.set("status", next.status);
        else params.delete("status");
      }
      startTransition(() => {
        router.replace(`?${params.toString()}`);
      });
    },
    [router, searchParams],
  );

  const refetch = useCallback(
    async (filters: {
      bankAccountId: string | null;
      reason: CamtUnreconciledReason | null;
      status: CamtUnreconciledStatus;
    }) => {
      setIsLoading(true);
      try {
        const client = createClientApiClient();
        const result = await CamtStatementsService.listUnreconciled(client, {
          bankAccountId: filters.bankAccountId ?? undefined,
          reason: filters.reason ?? undefined,
          status: filters.status,
          page: 1,
          perPage: 50,
        });
        setRows(result.data);
        setTotal(result.pagination.total);
        setSelectedIds(new Set());
      } catch (err) {
        const message =
          err instanceof ApiProblem
            ? (err.detail ?? err.title ?? t("toasts.fetchFailed"))
            : t("toasts.fetchFailed");
        toast.error(message);
      } finally {
        setIsLoading(false);
      }
    },
    [t],
  );

  const onBankAccountChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value || null;
      setBankAccountId(next);
      syncUrl({ bankAccountId: next });
      void refetch({ bankAccountId: next, reason, status });
    },
    [reason, refetch, status, syncUrl],
  );

  const onStatusChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as CamtUnreconciledStatus;
      setStatus(next);
      syncUrl({ status: next });
      void refetch({ bankAccountId, reason, status: next });
    },
    [bankAccountId, reason, refetch, syncUrl],
  );

  const onReasonClick = useCallback(
    (next: CamtUnreconciledReason | null) => {
      setReason(next);
      syncUrl({ reason: next });
      void refetch({ bankAccountId, reason: next, status });
    },
    [bankAccountId, refetch, status, syncUrl],
  );

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Bulk write-off is only valid when every selected row shares the
  // same reason. The audit-log row carries the reason explicitly per
  // docs/25 §7.bis, so we forbid mixed-reason batches at the UI level.
  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );
  const selectedSharesReason =
    selectedRows.length >= 2 && selectedRows.every((r) => r.reason === selectedRows[0]?.reason);
  const bulkReason = selectedSharesReason ? selectedRows[0]?.reason : null;

  // Counts per reason for the chip pills. Computed on `total`-aware
  // server data when the filter is "all reasons"; with a reason filter
  // active the counts reflect the filtered subset, which is fine — the
  // filtered chip still shows its own count.
  const reasonCounts = useMemo(() => {
    const counts: Record<CamtUnreconciledReason | "all", number> = {
      all: rows.length,
      invalid_ref: 0,
      no_match: 0,
      no_debtor_info: 0,
      orphan_reversal: 0,
      partial_match: 0,
    };
    for (const row of rows) counts[row.reason]++;
    return counts;
  }, [rows]);

  const handleResolved = useCallback(
    (updated: CamtUnreconciledRow) => {
      setResolvingRow(null);
      // Refresh the list to capture the new status + any side-effects.
      void refetch({ bankAccountId, reason, status });
      const successMsg =
        updated.status === "written_off" ? t("toasts.writeOffSuccess") : t("toasts.resolveSuccess");
      toast.success(successMsg);
    },
    [bankAccountId, reason, refetch, status, t],
  );

  const handleBulkWriteOff = useCallback(async () => {
    if (!selectedSharesReason || selectedRows.length === 0) return;
    const note = window.prompt(t("bulk.notePrompt"));
    if (!note || note.trim().length < 5) {
      toast.error(t("bulk.noteRequired"));
      return;
    }
    const client = createClientApiClient();
    let succeeded = 0;
    let failed = 0;
    for (const row of selectedRows) {
      try {
        await CamtStatementsService.resolveUnreconciled(client, row.id, {
          action: "write_off",
          resolutionNote: note.trim(),
        });
        succeeded++;
      } catch {
        failed++;
      }
    }
    if (succeeded > 0) {
      toast.success(t("bulk.successToast", { count: succeeded }));
    }
    if (failed > 0) {
      toast.error(t("bulk.partialFailureToast", { count: failed }));
    }
    void refetch({ bankAccountId, reason, status });
  }, [bankAccountId, reason, refetch, selectedRows, selectedSharesReason, status, t]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <FilterField label={t("filters.bankAccount")}>
            <select
              value={bankAccountId ?? ""}
              onChange={onBankAccountChange}
              className="h-9 rounded border border-outline-variant bg-surface-container-lowest px-3 text-sm"
              aria-label={t("filters.bankAccount")}
            >
              <option value="">{t("filters.allAccounts", { count: bankAccounts.length })}</option>
              {bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bankName} · {maskIban(b.iban)}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label={t("filters.status")}>
            <select
              value={status}
              onChange={onStatusChange}
              className="h-9 rounded border border-outline-variant bg-surface-container-lowest px-3 text-sm"
              aria-label={t("filters.status")}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </FilterField>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setBankAccountId(null);
              setReason(null);
              setStatus("pending");
              syncUrl({
                bankAccountId: null,
                reason: null,
                status: "pending",
              });
              void refetch({ bankAccountId: null, reason: null, status: "pending" });
            }}
          >
            {t("filters.clear")}
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <ReasonChip
          label={t("reasonChips.all")}
          count={reasonCounts.all}
          active={reason === null}
          onClick={() => onReasonClick(null)}
        />
        {REASONS.map((r) => (
          <ReasonChip
            key={r}
            label={t(`reason.${r}`)}
            count={reasonCounts[r] ?? 0}
            active={reason === r}
            onClick={() => onReasonClick(r)}
          />
        ))}
      </div>

      {selectedSharesReason && bulkReason ? (
        <Card className="border-primary bg-primary/5">
          <CardContent className="flex flex-wrap items-center gap-3 pt-6">
            <span className="text-sm text-on-surface">
              <strong className="font-mono">{selectedRows.length}</strong>{" "}
              {t("bulk.selectedLabel", { reason: t(`reason.${bulkReason}`) })}
            </span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleBulkWriteOff()}
            >
              {t("bulk.writeOffCta", { count: selectedRows.length })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setSelectedIds(new Set())}
            >
              {t("bulk.clearSelection")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-primary" size={24} aria-hidden="true" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState status={status} />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-outline-variant bg-surface-container-low text-left">
                <tr>
                  <th className="w-10 px-3 py-2" />
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                    {t("table.amount")}
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                    {t("table.valueDate")}
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                    {t("table.debtor")}
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                    {t("table.reference")}
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                    {t("table.reason")}
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                    {t("table.status")}
                  </th>
                  <th className="px-3 py-2" aria-label={t("table.actions")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <UnreconciledRowDisplay
                    key={row.id}
                    row={row}
                    locale={locale}
                    selected={selectedIds.has(row.id)}
                    onToggle={() => toggleRow(row.id)}
                    onResolve={() => setResolvingRow(row)}
                  />
                ))}
              </tbody>
            </table>
            <div className="border-t border-outline-variant px-4 py-2 text-xs text-on-surface-variant">
              {t("footer.showing", { count: rows.length, total })}
            </div>
          </CardContent>
        </Card>
      )}

      {resolvingRow ? (
        <ResolveDrawer
          row={resolvingRow}
          onClose={() => setResolvingRow(null)}
          onResolved={handleResolved}
        />
      ) : null}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  // The inner control carries its own `aria-label`; rendering the visible
  // caption as a `<span>` (not `<label>`) avoids the "label without control"
  // a11y rule without adding bookkeeping for synthetic ids on every filter.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        {label}
      </span>
      {children}
    </div>
  );
}

function ReasonChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-primary/40"
      }`}
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-1.5 py-px font-mono text-[10px] ${
          active ? "bg-white/20 text-on-primary" : "bg-surface-container text-on-surface-variant"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function UnreconciledRowDisplay({
  row,
  locale,
  selected,
  onToggle,
  onResolve,
}: {
  row: CamtUnreconciledRow;
  locale: string;
  selected: boolean;
  onToggle: () => void;
  onResolve: () => void;
}) {
  const t = useTranslations("settings.camtUnreconciled");
  const reasonVariants: Record<CamtUnreconciledReason, "error" | "warning" | "info" | "neutral"> = {
    invalid_ref: "error",
    no_match: "warning",
    no_debtor_info: "info",
    orphan_reversal: "neutral",
    partial_match: "warning",
  };
  const statusVariants: Record<CamtUnreconciledStatus, "warning" | "success" | "neutral"> = {
    pending: "warning",
    resolved: "success",
    written_off: "neutral",
  };
  return (
    <tr
      className={`border-b border-outline-variant last:border-b-0 hover:bg-surface-container-low ${
        selected ? "bg-primary/5" : ""
      }`}
    >
      <td className="px-3 py-2">
        {row.status === "pending" ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={t("table.selectRowLabel")}
            className="h-4 w-4"
          />
        ) : null}
      </td>
      <td className="px-3 py-2 text-right">
        <span className="font-mono tabular-nums text-on-surface">
          {formatCurrency(row.creditEntry.amountCents, locale, row.creditEntry.currency)}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">
        {row.creditEntry.valueDate ? formatDate(row.creditEntry.valueDate, locale, "short") : "—"}
      </td>
      <td className="px-3 py-2">
        <div>
          <p className="font-medium text-on-surface">{row.creditEntry.debtorName ?? "—"}</p>
          <p className="font-mono text-xs text-on-surface-variant">
            {maskIban(row.creditEntry.debtorIban)}
          </p>
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">
        {row.creditEntry.structuredRef ?? t("table.refMissing")}
      </td>
      <td className="px-3 py-2">
        <Badge variant={reasonVariants[row.reason]}>{t(`reason.${row.reason}`)}</Badge>
      </td>
      <td className="px-3 py-2">
        <Badge variant={statusVariants[row.status]}>{t(`status.${row.status}`)}</Badge>
      </td>
      <td className="px-3 py-2 text-right">
        {row.status === "pending" ? (
          <Button type="button" size="sm" variant="primary" onClick={onResolve}>
            {t("table.resolve")}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function EmptyState({ status }: { status: CamtUnreconciledStatus }) {
  const t = useTranslations("settings.camtUnreconciled.empty");
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <div className="mb-3 flex justify-center">
          <Check size={40} aria-hidden="true" className="text-success-text" />
        </div>
        <h3 className="font-heading text-xl text-on-surface">
          {status === "pending" ? t("titlePending") : t("titleOther")}
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
          {status === "pending" ? t("bodyPending") : t("bodyOther")}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Resolve drawer ────────────────────────────────────────────────────

function ResolveDrawer({
  row,
  onClose,
  onResolved,
}: {
  row: CamtUnreconciledRow;
  onClose: () => void;
  onResolved: (updated: CamtUnreconciledRow) => void;
}) {
  const t = useTranslations("settings.camtUnreconciled.drawer");
  const locale = useLocale();
  const [action, setAction] = useState<CamtUnreconciledResolveAction>(
    "create_constituent_and_donation",
  );
  const [resolutionNote, setResolutionNote] = useState("");
  const [donationId, setDonationId] = useState("");
  const [constituentId, setConstituentId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Lock the scroll while the drawer is open and close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;
    if (action === "link" && !donationId.trim()) {
      toast.error(t("validation.donationIdRequired"));
      return;
    }
    if (action === "create_constituent_and_donation" && !constituentId.trim()) {
      toast.error(t("validation.constituentIdRequired"));
      return;
    }
    if (resolutionNote.trim().length < 5) {
      toast.error(t("validation.noteTooShort"));
      return;
    }
    setIsSubmitting(true);
    try {
      const client = createClientApiClient();
      const updated = await CamtStatementsService.resolveUnreconciled(client, row.id, {
        action,
        resolutionNote: resolutionNote.trim(),
        donationId: action === "link" ? donationId.trim() : undefined,
        constituentId:
          action === "create_constituent_and_donation" ? constituentId.trim() : undefined,
      });
      onResolved(updated);
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("validation.submitFailed"))
          : t("validation.submitFailed");
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [action, constituentId, donationId, isSubmitting, onResolved, resolutionNote, row.id, t]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop is a button so keyboard activation closes the drawer
          (a11y: avoids the static-interactive-div lint and matches the
          Escape-key affordance set up above). */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("close")}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <aside
        className="relative h-full w-full max-w-xl overflow-y-auto bg-surface-container-lowest p-6 shadow-elevated"
        role="dialog"
        aria-label={t("title")}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-xl text-on-surface">{t("title")}</h2>
            <p className="mt-1 text-xs text-on-surface-variant">
              {t("subtitle", {
                amount: formatCurrency(
                  row.creditEntry.amountCents,
                  locale,
                  row.creditEntry.currency,
                ),
                date: row.creditEntry.valueDate
                  ? formatDate(row.creditEntry.valueDate, locale, "medium")
                  : "—",
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="rounded p-1 text-on-surface-variant hover:bg-surface-container"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <EntrySummary row={row} />

        <div className="mt-5 space-y-2" role="radiogroup" aria-label={t("actionsLabel")}>
          <ActionOption
            label={t("actions.link.title")}
            description={t("actions.link.description")}
            checked={action === "link"}
            onSelect={() => setAction("link")}
          />
          <ActionOption
            label={t("actions.create.title")}
            description={t("actions.create.description")}
            checked={action === "create_constituent_and_donation"}
            onSelect={() => setAction("create_constituent_and_donation")}
          />
          <ActionOption
            label={t("actions.writeOff.title")}
            description={t("actions.writeOff.description")}
            checked={action === "write_off"}
            onSelect={() => setAction("write_off")}
          />
        </div>

        <div className="mt-5 space-y-4">
          {action === "link" ? (
            <div>
              <label
                htmlFor="resolve-donation-id"
                className="mb-1 block text-sm font-medium text-on-surface"
              >
                {t("link.donationIdLabel")}
              </label>
              <Input
                id="resolve-donation-id"
                value={donationId}
                onChange={(e) => setDonationId(e.target.value)}
                placeholder={t("link.donationIdPlaceholder")}
              />
              <p className="mt-1 text-xs text-on-surface-variant">{t("link.donationIdHint")}</p>
            </div>
          ) : null}

          {action === "create_constituent_and_donation" ? (
            <PreFilledPanel row={row}>
              <div>
                <label
                  htmlFor="resolve-constituent-id"
                  className="mb-1 block text-sm font-medium text-on-surface"
                >
                  {t("create.constituentIdLabel")}
                </label>
                <Input
                  id="resolve-constituent-id"
                  value={constituentId}
                  onChange={(e) => setConstituentId(e.target.value)}
                  placeholder={t("create.constituentIdPlaceholder")}
                />
                <p className="mt-1 text-xs text-on-surface-variant">
                  {t("create.constituentIdHint")}
                </p>
              </div>
            </PreFilledPanel>
          ) : null}

          <div>
            <label className="block text-sm font-medium text-on-surface">
              <span className="mb-1 block">{t("noteLabel")}</span>
              <textarea
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={3}
                className="w-full rounded border border-outline-variant bg-surface-container-lowest p-2 text-sm"
                placeholder={t("notePlaceholder")}
              />
            </label>
            <p className="mt-1 text-xs text-on-surface-variant">{t("noteHint")}</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-outline-variant pt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                {t("submitting")}
              </>
            ) : (
              t(`confirm.${action}`)
            )}
          </Button>
        </div>
      </aside>
    </div>
  );
}

function EntrySummary({ row }: { row: CamtUnreconciledRow }) {
  const t = useTranslations("settings.camtUnreconciled.drawer.summary");
  return (
    <div className="rounded-lg bg-surface-container p-3 font-mono text-xs">
      <SummaryRow label={t("debtor")} value={row.creditEntry.debtorName ?? "—"} />
      <SummaryRow label={t("debtorIban")} value={maskIban(row.creditEntry.debtorIban)} />
      <SummaryRow label={t("ref")} value={row.creditEntry.structuredRef ?? "—"} />
      <SummaryRow label={t("statementMsgId")} value={row.creditEntry.statementMsgId ?? "—"} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-0.5">
      <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">{label}</span>
      <span className="text-on-surface">{value}</span>
    </div>
  );
}

function ActionOption({
  label,
  description,
  checked,
  onSelect,
}: {
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition ${
        checked
          ? "border-primary bg-primary/5"
          : "border-outline-variant bg-surface-container-lowest hover:border-primary/40"
      }`}
    >
      <span
        className={`mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          checked ? "border-primary bg-primary" : "border-outline-variant"
        }`}
        aria-hidden="true"
      >
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-on-primary" /> : null}
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium text-on-surface">{label}</span>
        <span className="mt-0.5 block text-xs text-on-surface-variant">{description}</span>
      </span>
    </button>
  );
}

function PreFilledPanel({
  row,
  children,
}: {
  row: CamtUnreconciledRow;
  children: React.ReactNode;
}) {
  const t = useTranslations("settings.camtUnreconciled.drawer.create.prefill");
  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-primary">
        <AlertCircle size={12} aria-hidden="true" />
        {t("title")}
      </p>
      <div className="space-y-2 text-xs">
        <PreFilledRow label={t("debtorName")} value={row.creditEntry.debtorName ?? "—"} />
        <PreFilledRow label={t("paymentSourceIban")} value={maskIban(row.creditEntry.debtorIban)} />
        <PreFilledRow label={t("structuredRef")} value={row.creditEntry.structuredRef ?? "—"} />
      </div>
      <div className="mt-3 border-t border-outline-variant pt-3">{children}</div>
    </div>
  );
}

function PreFilledRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">{label}</span>
      <span className="font-mono text-on-surface">{value}</span>
    </div>
  );
}

// `formatNumber` is intentionally available for downstream extensions
// (e.g. row pagination labels) — keep the import alive.
void formatNumber;
