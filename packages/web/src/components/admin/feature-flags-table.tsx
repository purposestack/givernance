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
 * Feature-flag toggle table — super-admin Back Office (PR #352
 * follow-up). One row per registered flag. Tile-style cards instead of
 * a `<table>` because the only "data" is a key + description + a
 * single toggle; a flat list reads cleaner than a 4-column table on
 * mobile and we never expect more than ~10 rows.
 *
 * The Enable / Disable button is the entire toggle — no <Switch>
 * component because the project doesn't ship one yet, and a labelled
 * Button ("Disable communication.bulk_email") is more accessible than
 * a hand-rolled checkbox-styled-as-switch for an action that has
 * platform-wide consequences.
 *
 * Optimistic update + rollback on failure: clicking the button flips
 * the local state immediately so the operator sees instant feedback;
 * if the API call fails we revert + toast the error. Same pattern as
 * the donations status toggle.
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
    // Optimistic flip — instant UI feedback.
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
      // Roll back to the pre-click value.
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
          className="rounded-2xl border border-outline-variant bg-surface p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              {/*
                Heading is the friendly `label` (e.g. "Bulk emails to
                constituents"), not the dotted `key`. The key still
                renders below as a small monospaced subtitle so an
                engineer reading audit_logs can match
                `PATCH:/v1/admin/feature-flags/:key` back to a row.
              */}
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-medium text-on-surface">{row.label}</h2>
                <Badge variant={row.enabled ? "success" : "neutral"} shape="square">
                  {row.enabled ? t("status.enabled") : t("status.disabled")}
                </Badge>
              </div>
              <p className="text-sm text-on-surface-variant">{row.description}</p>
              <p className="text-xs text-on-surface-variant">
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
