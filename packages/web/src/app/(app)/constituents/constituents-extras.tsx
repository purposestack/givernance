"use client";

/**
 * Constituent list extras (Epic #274) — filter bar and bulk-email dialog.
 *
 * Lives next to `constituents-table.tsx` rather than inside it so the
 * existing data-table logic stays focused on selection / sorting and the
 * MVP filters can be iterated independently. Pages compose both: the
 * filter bar above the table, the bulk-email dialog triggered from the
 * selection toolbar.
 */

import { Mail, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { ConstituentService } from "@/services/ConstituentService";

/**
 * Read-only `<input>` controlled by the URL — drops back to `?param=` on
 * empty so the listing page doesn't carry stale filter values across
 * navigations. Pagination is reset whenever a filter changes (issue #217
 * convention).
 */
export function ConstituentFilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const initial = {
    lastDonationFrom: searchParams.get("lastDonationFrom") ?? "",
    lastDonationTo: searchParams.get("lastDonationTo") ?? "",
    totalAmountMin: searchParams.get("totalAmountMinCents") ?? "",
    totalAmountMax: searchParams.get("totalAmountMaxCents") ?? "",
    campaignId: searchParams.get("campaignId") ?? "",
  };
  const [draft, setDraft] = useState(initial);

  // Re-sync drafts on URL changes (back/forward navigation).
  useEffect(() => {
    setDraft({
      lastDonationFrom: searchParams.get("lastDonationFrom") ?? "",
      lastDonationTo: searchParams.get("lastDonationTo") ?? "",
      totalAmountMin: searchParams.get("totalAmountMinCents") ?? "",
      totalAmountMax: searchParams.get("totalAmountMaxCents") ?? "",
      campaignId: searchParams.get("campaignId") ?? "",
    });
  }, [searchParams]);

  const apply = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    const setOrDelete = (key: string, value: string) => {
      if (value && value.length > 0) params.set(key, value);
      else params.delete(key);
    };
    // Convert decimal-string amounts to cents at write time so the URL
    // layer stays integer-only and the API never sees fractional values.
    const minCents = draft.totalAmountMin
      ? Math.round(Number.parseFloat(draft.totalAmountMin) * 100)
      : null;
    const maxCents = draft.totalAmountMax
      ? Math.round(Number.parseFloat(draft.totalAmountMax) * 100)
      : null;

    setOrDelete(
      "lastDonationFrom",
      draft.lastDonationFrom ? new Date(draft.lastDonationFrom).toISOString() : "",
    );
    setOrDelete(
      "lastDonationTo",
      draft.lastDonationTo ? new Date(draft.lastDonationTo).toISOString() : "",
    );
    setOrDelete("totalAmountMinCents", minCents ? String(minCents) : "");
    setOrDelete("totalAmountMaxCents", maxCents ? String(maxCents) : "");
    setOrDelete("campaignId", draft.campaignId);
    params.delete("page");
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  }, [draft, pathname, router, searchParams]);

  const reset = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "lastDonationFrom",
      "lastDonationTo",
      "totalAmountMinCents",
      "totalAmountMaxCents",
      "campaignId",
      "page",
    ]) {
      params.delete(key);
    }
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  }, [pathname, router, searchParams]);

  const hasFilters =
    initial.lastDonationFrom ||
    initial.lastDonationTo ||
    initial.totalAmountMin ||
    initial.totalAmountMax ||
    initial.campaignId;

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl bg-surface-container-low p-4">
      <Field label="Last donation — from">
        <Input
          type="date"
          value={draft.lastDonationFrom ? draft.lastDonationFrom.slice(0, 10) : ""}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              lastDonationFrom: e.target.value ? `${e.target.value}T00:00:00.000Z` : "",
            }))
          }
        />
      </Field>
      <Field label="Last donation — to">
        <Input
          type="date"
          value={draft.lastDonationTo ? draft.lastDonationTo.slice(0, 10) : ""}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              lastDonationTo: e.target.value ? `${e.target.value}T23:59:59.999Z` : "",
            }))
          }
        />
      </Field>
      <Field label="Total amount min (€)">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          value={draft.totalAmountMin ? String(Number(draft.totalAmountMin) / 100) : ""}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              totalAmountMin: e.target.value,
            }))
          }
        />
      </Field>
      <Field label="Total amount max (€)">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          value={draft.totalAmountMax ? String(Number(draft.totalAmountMax) / 100) : ""}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              totalAmountMax: e.target.value,
            }))
          }
        />
      </Field>
      <Field label="Campaign ID">
        <Input
          placeholder="Paste a campaign UUID"
          value={draft.campaignId}
          onChange={(e) => setDraft((d) => ({ ...d, campaignId: e.target.value }))}
        />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" onClick={apply} disabled={isPending}>
          Apply filters
        </Button>
        {hasFilters ? (
          <Button size="sm" variant="ghost" onClick={reset} disabled={isPending}>
            <X size={14} aria-hidden="true" />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // Wrapping the inner Input in `<label>` is an a11y win — the click target
  // expands to include the caption — but Biome's `noLabelWithoutControl`
  // rule can't see through the children prop. Use an outer `<div>` with a
  // proper `<label htmlFor>` instead. Children must wire up `id` themselves
  // when they need explicit association; for our inline filter inputs the
  // implicit "label adjacent to input" is sufficient.
  return (
    <div className="flex flex-col gap-1 text-xs text-on-surface-variant">
      <span>{label}</span>
      {children}
    </div>
  );
}

/**
 * Page-level "bulk email" button + dialog wrapper. Kept here so the
 * server-rendered constituents page can ship the entire control without
 * touching the heavier TanStack table component (which already owns
 * search/sort/delete state). Clicking the button opens the dialog with
 * the visible constituent ids — i.e. "email everyone matching the
 * current filter set, on this page".
 */
export function BulkEmailButton({
  visibleIds,
  filteredCount,
}: {
  visibleIds: string[];
  filteredCount: number;
}) {
  const [open, setOpen] = useState(false);
  if (visibleIds.length === 0) return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Mail size={14} aria-hidden="true" />
        Email {visibleIds.length} of {filteredCount} visible
      </Button>
      <BulkEmailDialog open={open} onOpenChange={setOpen} selectedIds={visibleIds} />
    </>
  );
}

/**
 * Dialog wrapping {@link ConstituentService.sendBulkEmail}. The trigger is
 * controlled by the parent (so the constituents-table can wire it into its
 * selection toolbar without owning the dialog state).
 */
export function BulkEmailDialog({
  open,
  onOpenChange,
  selectedIds,
  onSent,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  selectedIds: string[];
  onSent?: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSend = useCallback(async () => {
    setSubmitting(true);
    try {
      const result = await ConstituentService.sendBulkEmail(createClientApiClient(), {
        constituentIds: selectedIds,
        subject,
        bodyText: body,
      });
      toast.success(
        `Email queued for ${result.reachable} of ${result.requested} constituents (${
          result.requested - result.reachable
        } missing email).`,
      );
      onOpenChange(false);
      onSent?.();
      setSubject("");
      setBody("");
    } catch (err) {
      const message =
        err instanceof ApiProblem ? (err.detail ?? err.title ?? "Send failed") : "Send failed";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [body, onOpenChange, onSent, selectedIds, subject]);

  const canSubmit =
    selectedIds.length > 0 && subject.trim().length > 0 && body.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send email to selection</DialogTitle>
          <DialogDescription>
            Queues a transactional email to {selectedIds.length} constituent
            {selectedIds.length === 1 ? "" : "s"}. Constituents without an email address are
            skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="bulk-email-subject">Subject</Label>
            <Input
              id="bulk-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={255}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bulk-email-body">Body</Label>
            <Textarea
              id="bulk-email-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={10000}
              rows={8}
              required
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSend()} disabled={!canSubmit}>
            <Mail size={14} aria-hidden="true" />
            Queue email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
