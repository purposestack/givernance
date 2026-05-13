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
 * Super-admin tenant-detail Feature flags tab (Epic #365 / PR #366).
 *
 * Renders the full registry for one tenant. Operator controls per row:
 *   - `scope='platform'` rows are read-only with an explanatory hint
 *     ("change at the platform level via the global Feature flags
 *     page"). Surfaced for context — super-admin sometimes needs to
 *     see "what's the bulk-email posture for this tenant?" without
 *     having to cross-reference the global page.
 *   - `scope='tenant'` rows have three actions:
 *       * "Turn on for this organisation" (set override = true)
 *       * "Turn off for this organisation" (set override = false)
 *       * "Use platform default" (delete override) — only shown when
 *         an override row currently exists.
 *
 * Optimistic updates + rollback on failure (same pattern as the
 * platform feature-flags table).
 */
interface TenantFeatureFlagsProps {
  tenantId: string;
  initialRows: TenantFlagViewRow[];
}

function PlatformDefaultBadge({ value, label }: { value: boolean; label: string }) {
  return (
    <Badge variant={value ? "success" : "neutral"} shape="square">
      {label}
    </Badge>
  );
}

export function TenantFeatureFlags({ tenantId, initialRows }: TenantFeatureFlagsProps) {
  const tDetail = useTranslations("admin.featureFlags.tenantDetail");
  const [rows, setRows] = useState<TenantFlagViewRow[]>(initialRows);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const applyRow = (key: string, mutator: (row: TenantFlagViewRow) => TenantFlagViewRow) => {
    setRows((prev) => prev.map((row) => (row.key === key ? mutator(row) : row)));
  };

  const handleSetOverride = async (row: TenantFlagViewRow, value: boolean) => {
    setBusyKey(row.key);
    const previous = row;
    // Optimistic: assume the override lands and the effective value flips.
    applyRow(row.key, (r) => ({
      ...r,
      override: {
        tenantId,
        flagKey: r.key,
        value,
        reason: null,
        setBy: null,
        setAt: new Date().toISOString(),
      },
      effectiveValue: value,
    }));
    try {
      const updated = await FeatureFlagsService.setTenantOverride(
        createClientApiClient(),
        tenantId,
        row.key,
        { value },
      );
      applyRow(row.key, (r) => ({
        ...r,
        override: updated,
        effectiveValue: value,
      }));
      toast.success(tDetail("toast.set", { key: row.label }));
    } catch (err) {
      // Roll back the row.
      applyRow(row.key, () => previous);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? tDetail("toast.error"))
          : tDetail("toast.error");
      toast.error(message);
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearOverride = async (row: TenantFlagViewRow) => {
    setBusyKey(row.key);
    const previous = row;
    applyRow(row.key, (r) => ({
      ...r,
      override: null,
      effectiveValue: r.platformDefault,
    }));
    try {
      await FeatureFlagsService.deleteTenantOverride(createClientApiClient(), tenantId, row.key);
      toast.success(tDetail("toast.cleared", { key: row.label }));
    } catch (err) {
      applyRow(row.key, () => previous);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? tDetail("toast.error"))
          : tDetail("toast.error");
      toast.error(message);
    } finally {
      setBusyKey(null);
    }
  };

  if (rows.length === 0) {
    return <p className="text-sm text-on-surface-variant">{tDetail("empty")}</p>;
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="font-heading text-lg text-on-surface">{tDetail("title")}</h2>
        <p className="text-sm text-on-surface-variant">{tDetail("subtitle")}</p>
      </header>
      <ul className="space-y-3">
        {rows.map((row) => (
          <TenantFeatureFlagRow
            key={row.key}
            row={row}
            busy={busyKey === row.key}
            onSetOverride={(value) => void handleSetOverride(row, value)}
            onClearOverride={() => void handleClearOverride(row)}
          />
        ))}
      </ul>
    </div>
  );
}

interface TenantFeatureFlagRowProps {
  row: TenantFlagViewRow;
  busy: boolean;
  onSetOverride: (value: boolean) => void;
  onClearOverride: () => void;
}

function TenantFeatureFlagRow({
  row,
  busy,
  onSetOverride,
  onClearOverride,
}: TenantFeatureFlagRowProps) {
  const t = useTranslations("admin.featureFlags");
  const tDetail = useTranslations("admin.featureFlags.tenantDetail");
  const tStatus = useTranslations("admin.featureFlags.status");

  const isPlatform = row.scope === "platform";
  const hasOverride = row.override !== null;
  const platformDefaultLabel = row.platformDefault ? tStatus("enabled") : tStatus("disabled");
  const effectiveLabel = row.effectiveValue ? tStatus("enabled") : tStatus("disabled");
  const toggleLabel = row.effectiveValue
    ? tDetail("actions.disableForTenant")
    : tDetail("actions.enableForTenant");

  return (
    <li className="rounded-2xl border border-outline-variant bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-on-surface">{row.label}</h3>
            <Badge variant={row.effectiveValue ? "success" : "neutral"} shape="square">
              {effectiveLabel}
            </Badge>
            <Badge variant="neutral" shape="square">
              {t(`scope.${row.scope}`)}
            </Badge>
            {hasOverride ? (
              <Badge variant="warning" shape="square">
                {tDetail("source.override")}
              </Badge>
            ) : (
              <span className="text-xs italic text-on-surface-variant">
                {tDetail("source.default")}
              </span>
            )}
          </div>
          <p className="text-sm text-on-surface-variant">{row.description}</p>
          <div className="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
            <span>
              {tDetail("columns.platformDefault")}:{" "}
              <PlatformDefaultBadge value={row.platformDefault} label={platformDefaultLabel} />
            </span>
            <span aria-hidden="true">·</span>
            <code className="font-mono">{row.key}</code>
          </div>
          {isPlatform ? (
            <p className="text-xs italic text-on-surface-variant">
              {tDetail("platformLockedHint")}
            </p>
          ) : null}
        </div>
        {!isPlatform ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={row.effectiveValue ? "secondary" : "primary"}
              size="sm"
              disabled={busy}
              onClick={() => onSetOverride(!row.effectiveValue)}
            >
              {busy ? tDetail("actions.saving") : toggleLabel}
            </Button>
            {hasOverride ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onClearOverride}
              >
                {tDetail("actions.clearOverride")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
