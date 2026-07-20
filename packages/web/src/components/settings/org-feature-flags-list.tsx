"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { FeatureFlagsService, type TenantFlagViewRow } from "@/services/FeatureFlagsService";

/**
 * Org-admin self-service feature-flags list (Epic #365 / PR #366).
 *
 * Mirrors the visual shape of the super-admin Back Office table for
 * UX familiarity, but scoped to the caller's own organisation: every
 * row is `scope='tenant' AND tenant_override_allowed=true` (the API
 * enforces it), and the only verbs are "Turn on" / "Turn off" / "Use
 * the default". Org-admins never see the API key, audit metadata, or
 * platform-wide stats — those are super-admin concerns.
 *
 * The "platform default" badge shows the value Givernance ships for
 * every NPO; the effective-state badge reflects whether this org has
 * overridden it. The "Use the default" action is only present when
 * an override is currently set.
 */
interface OrgFeatureFlagsListProps {
  initialRows: TenantFlagViewRow[];
}

export function OrgFeatureFlagsList({ initialRows }: OrgFeatureFlagsListProps) {
  const t = useTranslations("settings.featureFlags");
  const [rows, setRows] = useState<TenantFlagViewRow[]>(initialRows);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const applyRow = (key: string, mutator: (row: TenantFlagViewRow) => TenantFlagViewRow) => {
    setRows((prev) => prev.map((row) => (row.key === key ? mutator(row) : row)));
  };

  const handleSet = async (row: TenantFlagViewRow, value: boolean) => {
    setBusyKey(row.key);
    const previous = row;
    applyRow(row.key, (r) => ({
      ...r,
      override: {
        tenantId: r.override?.tenantId ?? "",
        flagKey: r.key,
        value,
        reason: null,
        setBy: null,
        setAt: new Date().toISOString(),
      },
      effectiveValue: value,
    }));
    try {
      const updated = await FeatureFlagsService.setOrgOverride(createClientApiClient(), row.key, {
        value,
      });
      applyRow(row.key, (r) => ({ ...r, override: updated, effectiveValue: value }));
      toast.success(
        value
          ? t("toast.enabled", { label: row.label })
          : t("toast.disabled", { label: row.label }),
      );
    } catch (err) {
      applyRow(row.key, () => previous);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("toast.error"))
          : t("toast.error");
      toast.error(message);
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Org-admin "use the default" — calls the real DELETE endpoint so
   * the override row is genuinely removed and a reload returns
   * `override: null`. (Replaces a prior PATCH-as-delete emulation
   * that desynced optimistic FE state from the persisted state —
   * see FE review R3 + API review item 2 on PR #366.)
   */
  const handleUseDefault = async (row: TenantFlagViewRow) => {
    setBusyKey(row.key);
    const previous = row;
    applyRow(row.key, (r) => ({
      ...r,
      override: null,
      effectiveValue: r.platformDefault,
    }));
    try {
      await FeatureFlagsService.deleteOrgOverride(createClientApiClient(), row.key);
      toast.success(t("toast.cleared", { label: row.label }));
    } catch (err) {
      applyRow(row.key, () => previous);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("toast.error"))
          : t("toast.error");
      toast.error(message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    // ADR-035 rules A2/A3 — the list container is cascade slot 0 and the
    // flag cards stagger in reading order via `.cascade` (nth-child slots
    // 1..12). Entrances run once per mount (rule B12): optimistic toggle
    // re-renders keep stable `row.key` keys, so nothing replays.
    <ul className="reveal-item cascade space-y-3">
      {rows.map((row) => {
        const hasOverride = row.override !== null;
        const busy = busyKey === row.key;
        const defaultStateLabel = row.platformDefault
          ? t("platformDefaultEnabled")
          : t("platformDefaultDisabled");
        const effectiveStateLabel = row.effectiveValue
          ? t("effectiveEnabled")
          : t("effectiveDisabled");
        return (
          <li
            key={row.key}
            aria-busy={busy}
            className="rounded-2xl border border-outline-variant bg-surface p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium text-on-surface">{row.label}</h2>
                  <Badge variant={row.effectiveValue ? "success" : "neutral"} shape="square">
                    {t("effectiveLabel", { state: effectiveStateLabel })}
                  </Badge>
                  {hasOverride ? (
                    <Badge variant="warning" shape="square">
                      {t("source.override")}
                    </Badge>
                  ) : (
                    <span className="text-xs italic text-on-surface-variant">
                      {t("source.default")}
                    </span>
                  )}
                </div>
                <p className="text-sm text-on-surface-variant">{row.description}</p>
                <p className="text-xs text-on-surface-variant">
                  {t("platformDefaultLabel", { state: defaultStateLabel })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={row.effectiveValue ? "secondary" : "primary"}
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleSet(row, !row.effectiveValue)}
                >
                  {busy
                    ? t("actions.saving")
                    : row.effectiveValue
                      ? t("actions.disable")
                      : t("actions.enable")}
                </Button>
                {hasOverride ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleUseDefault(row)}
                  >
                    {t("actions.clearOverride")}
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
