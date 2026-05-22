"use client";

import { Plus, Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { FilterBuilder, type Filter } from "@/components/constituents/filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { type Constituent, type ConstituentListRow, fullName } from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";
import { type CampaignMember, PostalCampaignService } from "@/services/PostalCampaignService";

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
 * Enhanced linked-constituents widget with advanced filtering support.
 * Allows users to build complex queries to select campaign members.
 */
export function CampaignMembersCard({
  campaignId,
  initialMembers,
  initialTotal,
  doorDrop,
  onTotalChanged,
}: CampaignMembersCardProps) {
  const t = useTranslations("campaigns.postal.members");
  const [members, setMembers] = useState<CampaignMember[]>(initialMembers);
  const [total, setTotal] = useState(initialTotal);
  const [dialogOpen, setDialogOpen] = useState(false);

  const updateTotal = useCallback(
    (next: number | ((prev: number) => number)) => {
      setTotal((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        onTotalChanged?.(resolved);
        return resolved;
      });
    },
    [onTotalChanged],
  );

  const handleRemove = useCallback(
    async (constituentId: string) => {
      const client = createClientApiClient();
      try {
        await PostalCampaignService.removeMember(client, campaignId, constituentId);
        setMembers((prev) => prev.filter((m) => m.constituentId !== constituentId));
        updateTotal((prev) => Math.max(0, prev - 1));
        toast.success(t("toast.removed"));
      } catch (err) {
        const message =
          err instanceof ApiProblem
            ? (err.detail ?? err.title ?? t("toast.removeFailed"))
            : t("toast.removeFailed");
        toast.error(message);
      }
    },
    [campaignId, t, updateTotal],
  );

  const handleAdded = useCallback(
    async (added: string[]) => {
      // After adding, refetch the first page so the UI shows the new rows
      // with their addedAt timestamps.
      const client = createClientApiClient();
      try {
        const fresh = await PostalCampaignService.listMembers(client, campaignId);
        setMembers(fresh.data);
        updateTotal(fresh.pagination.total);
        toast.success(t("toast.added", { count: added.length }));
      } catch {
        // Silently swallow refetch errors — the add itself succeeded so the
        // user already got their primary feedback. They can refresh.
      }
    },
    [campaignId, t, updateTotal],
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
          <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            {t("actions.add")}
          </Button>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="rounded-lg border border-dashed border-outline-variant px-4 py-6 text-center text-sm text-on-surface-variant">
              {t("empty")}
            </p>
          ) : (
            <ul className="divide-y divide-outline-variant rounded-lg border border-outline-variant">
              {members.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium text-on-surface">
                      {member.firstName} {member.lastName}
                    </p>
                    {member.email ? (
                      <p className="text-xs text-on-surface-variant">{member.email}</p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRemove(member.constituentId)}
                    aria-label={t("actions.remove")}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AddMembersWithFilterDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        campaignId={campaignId}
        existingIds={new Set(members.map((m) => m.constituentId))}
        onAdded={handleAdded}
      />
    </>
  );
}

interface AddMembersWithFilterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  existingIds: Set<string>;
  onAdded: (addedIds: string[]) => void;
}

/**
 * Enhanced dialog that supports both text search and advanced filtering.
 * Users can either search by name/email or build complex filter queries.
 */
function AddMembersWithFilterDialog({
  open,
  onOpenChange,
  campaignId,
  existingIds,
  onAdded,
}: AddMembersWithFilterDialogProps) {
  const t = useTranslations("campaigns.postal.members.dialog");
  const [filter, setFilter] = useState<Filter | null>(null);
  const [results, setResults] = useState<Constituent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [countLoading, setCountLoading] = useState(false);

  // Run filter search when filter changes
  useEffect(() => {
    if (!filter) {
      setResults([]);
      setMatchCount(0);
      return;
    }

    setCountLoading(true);
    startTransition(async () => {
      const client = createClientApiClient();
      try {
        // TODO: Update this once the backend supports advanced filtering
        // For now, we'll use the basic search as a placeholder
        const fresh = await ConstituentService.listConstituents(client, {
          perPage: 100, // Get more results for filtering
        });
        
        // Client-side filtering as a temporary solution
        const filtered = (fresh.data as ConstituentListRow[]).filter((constituent) => {
          // Apply filter conditions client-side
          // This is a simplified implementation - real filtering should happen server-side
          return filter.conditions.every((condition) => {
            const value = constituent[condition.field as keyof Constituent];
            
            switch (condition.operator) {
              case "equals":
                return value === condition.value;
              case "not_equals":
                return value !== condition.value;
              case "contains":
                return value && String(value).toLowerCase().includes(String(condition.value).toLowerCase());
              case "is_null":
                return value === null || value === undefined || value === "";
              case "is_not_null":
                return value !== null && value !== undefined && value !== "";
              // Add more operators as needed
              default:
                return true;
            }
          });
        });
        
        setResults(filtered);
        setMatchCount(filtered.length);
      } catch {
        setResults([]);
        setMatchCount(0);
      } finally {
        setCountLoading(false);
      }
    });
  }, [filter]);

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
      setFilter(null);
      setResults([]);
    } catch (err) {
      const message =
        err instanceof ApiProblem ? (err.detail ?? err.title ?? t("error")) : t("error");
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [campaignId, onAdded, onOpenChange, selected, t]);

  const handleSelectAll = useCallback(() => {
    const newSelected = new Set(selected);
    results.forEach((r) => {
      if (!existingIds.has(r.id)) {
        newSelected.add(r.id);
      }
    });
    setSelected(newSelected);
  }, [results, existingIds, selected]);

  const handleSelectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const filteredResults = useMemo(
    () => results.filter((r) => !existingIds.has(r.id)),
    [existingIds, results],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("descriptionEnhanced")}</DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Filter Builder */}
          <FilterBuilder
            filter={filter}
            onChange={setFilter}
            showCount={true}
            matchCount={matchCount}
            countLoading={countLoading}
            compact={false}
          />

          {/* Results */}
          {filter && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-on-surface">
                  {t("results", { count: filteredResults.length })}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAll}
                    disabled={filteredResults.length === 0}
                  >
                    {t("selectAll")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectNone}
                    disabled={selected.size === 0}
                  >
                    {t("selectNone")}
                  </Button>
                </div>
              </div>
              
              <div className="max-h-96 overflow-y-auto rounded-lg border border-outline-variant">
                {isPending && results.length === 0 ? (
                  <p className="p-3 text-sm text-on-surface-variant">{t("loading")}</p>
                ) : filteredResults.length === 0 ? (
                  <p className="p-3 text-sm text-on-surface-variant">
                    {filter ? t("noMatches") : t("empty")}
                  </p>
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
                              {r.city ? (
                                <span className="text-xs text-on-surface-variant">
                                  {r.city}{r.postalCode ? ` ${r.postalCode}` : ""}
                                </span>
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
          )}
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