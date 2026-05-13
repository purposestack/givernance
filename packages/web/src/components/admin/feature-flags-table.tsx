"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatDate } from "@/lib/format";
import { type FeatureFlagRow, FeatureFlagsService } from "@/services/FeatureFlagsService";

/**
 * Feature-flag toggle table — super-admin Back Office. Phase 2
 * (Epic #365 / PR #366) added the override-stats badge per row so
 * the global view answers "how many tenants have diverged from the
 * platform default?" at a glance.
 *
 * The override-stats badge renders only when `row.overrideStats`
 * is non-null — the API returns `null` when the Phase-2 self-flag
 * (`admin.feature_flags_phase2`) is off, so the column gracefully
 * vanishes in the kill-switch case without an empty UI element.
 */
interface FeatureFlagsTableProps {
  rows: FeatureFlagRow[];
}

export function FeatureFlagsTable({ rows: initialRows }: FeatureFlagsTableProps) {
  const t = useTranslations("admin.featureFlags");
  const locale = useLocale();
  const [rows, setRows] = useState<FeatureFlagRow[]>(initialRows);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-on-surface-variant">{t("empty")}</p>;
  }

  const handleToggle = async (row: FeatureFlagRow) => {
    setBusyKey(row.key);
    const previousEnabled = row.enabled;
    setRows((prev) =>
      prev.map((r) => (r.key === row.key ? { ...r, enabled: !previousEnabled } : r)),
    );
    try {
      const updated = await FeatureFlagsService.setEnabled(
        createClientApiClient(),
        row.key,
        !previousEnabled,
      );
      setRows((prev) => prev.map((r) => (r.key === row.key ? updated : r)));
      toast.success(
        updated.enabled
          ? t("toast.enabled", { key: row.key })
          : t("toast.disabled", { key: row.key }),
      );
    } catch (err) {
      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, enabled: previousEnabled } : r)),
      );
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
    <ul className="space-y-3">
      {rows.map((row) => (
        <li
          key={row.key}
          aria-busy={busyKey === row.key}
          className="rounded-2xl border border-outline-variant bg-surface p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-medium text-on-surface">{row.label}</h2>
                <Badge variant={row.enabled ? "success" : "neutral"} shape="square">
                  {row.enabled ? t("status.enabled") : t("status.disabled")}
                </Badge>
                <Badge variant="neutral" shape="square">
                  {t(`scope.${row.scope}`)}
                </Badge>
              </div>
              <p className="text-sm text-on-surface-variant">{row.description}</p>
              {/*
                Scope hint — surfaces the "platform-wide vs per-org"
                distinction in plain language for non-technical
                operators (per the non-technical-wording rule).
              */}
              <p className="text-xs italic text-on-surface-variant">
                {t(`scopeHint.${row.scope}`)}
              </p>
              {/*
                Override-stats summary — present only when Phase-2 is
                on (overrideStats is null otherwise so the row gracefully
                degrades to the Phase-1 shape).
              */}
              {row.overrideStats ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {t("overrideStats.label")}
                  </span>
                  {row.overrideStats.enabledCount === 0 && row.overrideStats.disabledCount === 0 ? (
                    <span className="text-xs text-on-surface-variant">
                      {t("overrideStats.noOverrides")}
                    </span>
                  ) : (
                    <>
                      <Badge variant="success" shape="square">
                        {t("overrideStats.enabledCount", {
                          count: row.overrideStats.enabledCount,
                        })}
                      </Badge>
                      <Badge variant="neutral" shape="square">
                        {t("overrideStats.disabledCount", {
                          count: row.overrideStats.disabledCount,
                        })}
                      </Badge>
                    </>
                  )}
                </div>
              ) : null}
              <p className="text-xs text-on-surface-variant">
                <span className="sr-only">Internal identifier: </span>
                <code className="font-mono">{row.key}</code>
                <span className="mx-1">·</span>
                {t("lastUpdated", { date: formatDate(row.updatedAt, locale) })}
              </p>
            </div>
            <Button
              type="button"
              variant={row.enabled ? "secondary" : "primary"}
              size="sm"
              disabled={busyKey === row.key}
              onClick={() => void handleToggle(row)}
            >
              {busyKey === row.key
                ? t("actions.saving")
                : row.enabled
                  ? t("actions.disable")
                  : t("actions.enable")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
