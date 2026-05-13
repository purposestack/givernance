"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import {
  type FeatureFlagRow,
  FeatureFlagsService,
  type FlagTenantRow,
} from "@/services/FeatureFlagsService";

/**
 * Per-flag tenant management — drives `/admin/feature-flags/[key]`.
 * Added on PR #366 follow-up after the reviewer noted that managing
 * "5 enabled across 45 tenants" via the per-tenant detail page was
 * impractical.
 *
 * UX shape:
 *   - Header carries the flag's label + plain-language description +
 *     platform-default badge (so the operator never loses context
 *     while flipping per-tenant rows).
 *   - Search input filters by organisation name (case-insensitive).
 *   - Filter chips narrow to: all | enabled | disabled | overridden |
 *     using-default. Drives the "find me the 5 tenants where this is
 *     overridden ON" question.
 *   - Per-row toggle (enable / disable / use default) for single
 *     edits.
 *   - Bulk selection with `Select all (filtered)` + bulk actions
 *     (enable / disable / use default for selected). Sequential PUTs
 *     so we get partial-success granularity — a 422 on one tenant
 *     doesn't bring down the whole batch.
 *
 * Platform-scoped flags render the same table but with row actions
 * disabled + a banner explaining that overrides won't be honoured.
 * Surfacing the data without the controls keeps the operator from
 * having to hand-write SQL to inspect a historical platform-scope
 * override they want to clean up.
 */
type FilterValue = "all" | "enabled" | "disabled" | "overridden" | "default";

interface PerFlagTenantsProps {
  flag: FeatureFlagRow;
  initialTenants: FlagTenantRow[];
}

export function PerFlagTenants({ flag, initialTenants }: PerFlagTenantsProps) {
  const t = useTranslations("admin.featureFlags.perFlagTenants");
  const tStatus = useTranslations("admin.featureFlags.status");
  const tScope = useTranslations("admin.featureFlags.scope");

  const [tenants, setTenants] = useState<FlagTenantRow[]>(initialTenants);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const isPlatform = flag.scope === "platform";

  const visibleTenants = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tenants.filter((tenant) => {
      if (term && !tenant.tenantName.toLowerCase().includes(term)) return false;
      switch (filter) {
        case "all":
          return true;
        case "enabled":
          return tenant.effectiveValue === true;
        case "disabled":
          return tenant.effectiveValue === false;
        case "overridden":
          return tenant.override !== null;
        case "default":
          return tenant.override === null;
        default:
          return true;
      }
    });
  }, [tenants, search, filter]);

  const toggleSelection = (tenantId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(visibleTenants.map((t) => t.tenantId)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const updateRowLocal = (tenantId: string, mutator: (row: FlagTenantRow) => FlagTenantRow) => {
    setTenants((prev) => prev.map((row) => (row.tenantId === tenantId ? mutator(row) : row)));
  };

  const handleSetOverride = async (row: FlagTenantRow, value: boolean) => {
    setBusyId(row.tenantId);
    const previous = row;
    updateRowLocal(row.tenantId, (r) => ({
      ...r,
      override: {
        tenantId: r.tenantId,
        flagKey: flag.key,
        value,
        reason: r.override?.reason ?? null,
        setBy: null,
        setAt: new Date().toISOString(),
      },
      effectiveValue: value,
    }));
    try {
      const updated = await FeatureFlagsService.setTenantOverride(
        createClientApiClient(),
        row.tenantId,
        flag.key,
        { value },
      );
      updateRowLocal(row.tenantId, (r) => ({
        ...r,
        override: updated,
        effectiveValue: value,
      }));
    } catch (err) {
      updateRowLocal(row.tenantId, () => previous);
      toastApiError(err);
    } finally {
      setBusyId(null);
    }
  };

  const handleClearOverride = async (row: FlagTenantRow) => {
    setBusyId(row.tenantId);
    const previous = row;
    updateRowLocal(row.tenantId, (r) => ({
      ...r,
      override: null,
      effectiveValue: flag.enabled,
    }));
    try {
      await FeatureFlagsService.deleteTenantOverride(
        createClientApiClient(),
        row.tenantId,
        flag.key,
      );
    } catch (err) {
      updateRowLocal(row.tenantId, () => previous);
      toastApiError(err);
    } finally {
      setBusyId(null);
    }
  };

  function toastApiError(err: unknown) {
    const message =
      err instanceof ApiProblem ? (err.detail ?? err.title ?? t("fetchFailed")) : t("fetchFailed");
    toast.error(message);
  }

  /**
   * Bulk-apply across the current selection. Sequential PUTs (or
   * DELETEs) so a single 422 on a misbehaving row doesn't abort the
   * batch — the operator gets a partial-success toast at the end. The
   * progress counter renders on the bulk-action bar while the batch
   * runs so the UI never freezes silently on 45-tenant fan-outs.
   */
  const handleBulkSet = async (mode: "enable" | "disable" | "clear") => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkProgress({ done: 0, total: ids.length });
    let success = 0;
    let failed = 0;
    const client = createClientApiClient();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const row = tenants.find((t) => t.tenantId === id);
      if (!row) {
        failed += 1;
        continue;
      }
      try {
        if (mode === "clear") {
          await FeatureFlagsService.deleteTenantOverride(client, id, flag.key);
          updateRowLocal(id, (r) => ({
            ...r,
            override: null,
            effectiveValue: flag.enabled,
          }));
        } else {
          const value = mode === "enable";
          const updated = await FeatureFlagsService.setTenantOverride(client, id, flag.key, {
            value,
          });
          updateRowLocal(id, (r) => ({
            ...r,
            override: updated,
            effectiveValue: value,
          }));
        }
        success += 1;
      } catch {
        failed += 1;
      }
      setBulkProgress({ done: i + 1, total: ids.length });
    }
    setBulkProgress(null);
    setSelectedIds(new Set());
    if (failed === 0) {
      toast.success(t("bulk.successAll", { count: success }));
    } else {
      toast.error(t("bulk.partial", { success, failed, total: ids.length }));
    }
  };

  const platformDefaultStateLabel = flag.enabled ? tStatus("enabled") : tStatus("disabled");

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl text-on-surface">
          {t("title", { label: flag.label })}
        </h1>
        <p className="text-sm text-on-surface-variant">{flag.description}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="neutral" shape="square">
            {tScope(flag.scope)}
          </Badge>
          <Badge variant={flag.enabled ? "success" : "neutral"} shape="square">
            {t("platformDefaultBadge", { state: platformDefaultStateLabel })}
          </Badge>
          <code className="font-mono text-on-surface-variant" aria-hidden="true">
            {flag.key}
          </code>
        </div>
      </header>

      {isPlatform ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-2xl border border-warning bg-warning-container p-4 text-on-warning-container"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
          <p className="text-sm">{t("platformLocked")}</p>
        </div>
      ) : null}

      <PerFlagFilters
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        searchPlaceholder={t("searchPlaceholder")}
        filters={{
          all: t("filters.all"),
          enabled: t("filters.enabled"),
          disabled: t("filters.disabled"),
          overridden: t("filters.overridden"),
          default: t("filters.default"),
        }}
      />

      {!isPlatform ? (
        <BulkActions
          selectedCount={selectedIds.size}
          visibleCount={visibleTenants.length}
          onSelectAll={selectAllVisible}
          onClearSelection={clearSelection}
          onBulkSet={handleBulkSet}
          progress={bulkProgress}
          labels={{
            selectionLabel: t("bulk.selectionLabel", { count: selectedIds.size }),
            enable: t("bulk.enable"),
            disable: t("bulk.disable"),
            clear: t("bulk.clear"),
            selectAll: t("bulk.selectAll"),
            clearSelection: t("bulk.clearSelection"),
            saving: t("bulk.saving"),
            progress: t("bulk.progress", {
              done: bulkProgress?.done ?? 0,
              total: bulkProgress?.total ?? 0,
            }),
          }}
        />
      ) : null}

      {visibleTenants.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {visibleTenants.map((row) => (
            <PerFlagTenantRow
              key={row.tenantId}
              row={row}
              isPlatform={isPlatform}
              busy={busyId === row.tenantId}
              selected={selectedIds.has(row.tenantId)}
              onToggleSelection={() => toggleSelection(row.tenantId)}
              onSetOverride={(value) => void handleSetOverride(row, value)}
              onClearOverride={() => void handleClearOverride(row)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface PerFlagFiltersProps {
  search: string;
  onSearchChange: (next: string) => void;
  filter: FilterValue;
  onFilterChange: (next: FilterValue) => void;
  searchPlaceholder: string;
  filters: Record<FilterValue, string>;
}

function PerFlagFilters({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  searchPlaceholder,
  filters,
}: PerFlagFiltersProps) {
  return (
    <div className="space-y-3">
      <input
        type="search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={searchPlaceholder}
        className="block w-full max-w-md rounded-xl border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label={searchPlaceholder}
      />
      <div className="flex flex-wrap gap-2">
        {(Object.keys(filters) as FilterValue[]).map((value) => {
          const active = filter === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(value)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "border-primary bg-primary-container text-on-primary-container"
                  : "border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container"
              }`}
            >
              {filters[value]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface BulkActionsProps {
  selectedCount: number;
  visibleCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkSet: (mode: "enable" | "disable" | "clear") => void;
  progress: { done: number; total: number } | null;
  labels: {
    selectionLabel: string;
    enable: string;
    disable: string;
    clear: string;
    selectAll: string;
    clearSelection: string;
    saving: string;
    progress: string;
  };
}

function BulkActions({
  selectedCount,
  visibleCount,
  onSelectAll,
  onClearSelection,
  onBulkSet,
  progress,
  labels,
}: BulkActionsProps) {
  const busy = progress !== null;
  const hasSelection = selectedCount > 0;
  return (
    <div
      aria-busy={busy}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-outline-variant bg-surface-container p-3"
    >
      <p className="text-sm text-on-surface" aria-live="polite">
        {busy ? `${labels.saving} ${labels.progress}` : labels.selectionLabel}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onSelectAll}
          disabled={busy || visibleCount === 0}
        >
          {labels.selectAll}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          disabled={busy || !hasSelection}
        >
          {labels.clearSelection}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => onBulkSet("enable")}
          disabled={busy || !hasSelection}
        >
          {labels.enable}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onBulkSet("disable")}
          disabled={busy || !hasSelection}
        >
          {labels.disable}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onBulkSet("clear")}
          disabled={busy || !hasSelection}
        >
          {labels.clear}
        </Button>
      </div>
    </div>
  );
}

interface PerFlagTenantRowProps {
  row: FlagTenantRow;
  isPlatform: boolean;
  busy: boolean;
  selected: boolean;
  onToggleSelection: () => void;
  onSetOverride: (value: boolean) => void;
  onClearOverride: () => void;
}

function PerFlagTenantRow({
  row,
  isPlatform,
  busy,
  selected,
  onToggleSelection,
  onSetOverride,
  onClearOverride,
}: PerFlagTenantRowProps) {
  const t = useTranslations("admin.featureFlags.perFlagTenants");
  const tStatus = useTranslations("admin.featureFlags.status");
  const hasOverride = row.override !== null;
  const overrideOn = hasOverride && row.override?.value === true;

  const sourceLabel = !hasOverride
    ? t("source.default")
    : overrideOn
      ? t("source.overrideOn")
      : t("source.overrideOff");

  return (
    <li
      aria-busy={busy}
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-outline-variant bg-surface p-3"
    >
      <div className="flex flex-1 items-center gap-3">
        {!isPlatform ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelection}
            aria-label={row.tenantName}
            className="size-4 rounded border-outline-variant text-primary focus:ring-primary"
          />
        ) : null}
        <div className="flex-1">
          <p className="font-medium text-on-surface">{row.tenantName}</p>
          <p className="text-xs text-on-surface-variant">{row.tenantSlug}</p>
        </div>
        <Badge variant={row.effectiveValue ? "success" : "neutral"} shape="square">
          {row.effectiveValue ? tStatus("enabled") : tStatus("disabled")}
        </Badge>
        <Badge variant={hasOverride ? "warning" : "neutral"} shape="square">
          {sourceLabel}
        </Badge>
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
              onClick={onClearOverride}
            >
              {t("actions.clearOverride")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
