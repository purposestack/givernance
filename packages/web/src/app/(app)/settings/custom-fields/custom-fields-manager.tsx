"use client";

import { ArchiveRestore, GripVertical, Plus, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";

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
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { cn } from "@/lib/utils";
import type {
  ArchivedCustomFieldDefinition,
  CustomFieldCatalog,
  CustomFieldDefinition,
  CustomFieldDomain,
  CustomFieldUsageRow,
} from "@/models/custom-field";
import { CustomFieldsService } from "@/services/CustomFieldsService";

import { CustomFieldDialog } from "./custom-field-dialog";

interface DomainTab {
  domain: CustomFieldDomain;
  count: number;
}

interface CustomFieldsManagerProps {
  domain: CustomFieldDomain;
  /** Flag-enabled domains only — a disabled domain has no tab at all. */
  domainTabs: DomainTab[];
  catalog: CustomFieldCatalog;
  usage: CustomFieldUsageRow[];
  canManage: boolean;
}

type DialogState = { mode: "create" } | { mode: "edit"; definition: CustomFieldDefinition } | null;

export function CustomFieldsManager({
  domain,
  domainTabs,
  catalog,
  usage,
  canManage,
}: CustomFieldsManagerProps) {
  const router = useRouter();
  const t = useTranslations("settings.customFields");

  // Local row order for optimistic drag-to-reorder; server truth arrives
  // back through the RSC refresh (the parent re-keys this component per
  // domain + catalog version).
  const [rows, setRows] = useState<CustomFieldDefinition[]>(catalog.definitions);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [archiveTarget, setArchiveTarget] = useState<CustomFieldDefinition | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const orderBeforeDrag = useRef<CustomFieldDefinition[] | null>(null);

  const usageByDefinition = useMemo(() => {
    const map = new Map<string, CustomFieldUsageRow>();
    for (const row of usage) map.set(row.definitionId, row);
    return map;
  }, [usage]);

  const showOnRelatedCount = useMemo(() => rows.filter((d) => d.showOnRelated).length, [rows]);

  const problemMessage = useCallback(
    (error: unknown, fallback: string) =>
      error instanceof ApiProblem ? (error.detail ?? error.title ?? fallback) : fallback,
    [],
  );

  const persistOrder = useCallback(
    async (ordered: CustomFieldDefinition[], previous: CustomFieldDefinition[]) => {
      try {
        await CustomFieldsService.reorderFields(
          createClientApiClient(),
          domain,
          ordered.map((d) => d.id),
        );
        toast.success(t("success.reordered"));
        router.refresh();
      } catch (error) {
        setRows(previous);
        toast.error(problemMessage(error, t("errors.reorder")));
      }
    },
    [domain, problemMessage, router, t],
  );

  const handleDragStart = useCallback((index: number) => {
    dragIndex.current = index;
    orderBeforeDrag.current = null;
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent, index: number) => {
    event.preventDefault();
    const from = dragIndex.current;
    if (from === null || from === index) return;
    setRows((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return current;
      if (orderBeforeDrag.current === null) orderBeforeDrag.current = current;
      next.splice(index, 0, moved);
      return next;
    });
    dragIndex.current = index;
  }, []);

  const handleDragEnd = useCallback(() => {
    dragIndex.current = null;
    const previous = orderBeforeDrag.current;
    orderBeforeDrag.current = null;
    if (previous === null) return;
    setRows((current) => {
      void persistOrder(current, previous);
      return current;
    });
  }, [persistOrder]);

  const moveRow = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return;
      const next = [...rows];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return;
      next.splice(target, 0, moved);
      setRows(next);
      void persistOrder(next, rows);
    },
    [persistOrder, rows],
  );

  const confirmArchive = useCallback(async () => {
    if (!archiveTarget) return;
    setIsArchiving(true);
    try {
      await CustomFieldsService.archiveField(createClientApiClient(), archiveTarget.id);
      toast.success(t("success.archived", { label: archiveTarget.label }));
      setArchiveTarget(null);
      router.refresh();
    } catch (error) {
      toast.error(problemMessage(error, t("errors.archive")));
    } finally {
      setIsArchiving(false);
    }
  }, [archiveTarget, problemMessage, router, t]);

  const restoreField = useCallback(
    async (definition: ArchivedCustomFieldDefinition) => {
      setRestoringId(definition.id);
      try {
        await CustomFieldsService.restoreField(createClientApiClient(), definition.id);
        toast.success(t("success.restored", { label: definition.label }));
        router.refresh();
      } catch (error) {
        toast.error(problemMessage(error, t("errors.restore")));
      } finally {
        setRestoringId(null);
      }
    },
    [problemMessage, router, t],
  );

  const fieldLimit = catalog.quotas?.fieldsPerDomain ?? null;
  const hasFields = rows.length > 0;

  return (
    <div className="space-y-6">
      {/* Domain tabs — links so the RSC page refetches the tab's catalog.
          Static shell (ADR-035 A1): tabs never animate. */}
      <nav aria-label={t("domainTabsLabel")} className="border-b border-border-brand">
        <div className="flex gap-1 overflow-x-auto">
          {domainTabs.map((tab) => {
            const isActive = tab.domain === domain;
            return (
              <Link
                key={tab.domain}
                href={`/settings/custom-fields?domain=${tab.domain}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-on-surface-variant hover:text-on-surface",
                )}
              >
                {t(`domains.${tab.domain}`)}
                <span className="rounded-full bg-surface-container px-2 text-xs text-on-surface-variant">
                  {tab.count}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Quota meter — always visible (scarcity as UX); archived fields
          don't count. Cascade slot 0. */}
      <section
        aria-label={t("quota.label")}
        className="reveal-item flex flex-wrap items-center gap-5 rounded-2xl border border-border-brand bg-surface-container-lowest px-5 py-4"
      >
        <span className="whitespace-nowrap font-heading text-xl text-on-surface">
          {fieldLimit !== null ? `${rows.length} / ${fieldLimit}` : rows.length}{" "}
          <span className="text-sm font-normal text-on-surface-variant">{t("quota.unit")}</span>
        </span>
        {fieldLimit !== null ? (
          <Progress value={rows.length} max={fieldLimit} className="h-2 min-w-45 flex-1" />
        ) : (
          <span className="flex-1" />
        )}
        {canManage ? (
          <Button variant="primary" size="sm" onClick={() => setDialog({ mode: "create" })}>
            <Plus size={16} aria-hidden="true" />
            {t("actions.new")}
          </Button>
        ) : null}
        <p className="basis-full text-xs text-on-surface-variant">
          {fieldLimit !== null ? t("quota.hint", { limit: fieldLimit }) : t("quota.hintNoLimit")}
        </p>
      </section>

      {/* Field list — drag handles reorder; ordering propagates to forms,
          detail pages, columns and export. Cascade slot 1. */}
      {hasFields ? (
        <div
          className="reveal-item overflow-hidden rounded-2xl border border-border-brand bg-surface-container-lowest"
          style={{ "--cascade-i": 1 } as React.CSSProperties}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t("table.caption")}</caption>
              <thead>
                <tr className="bg-surface-container-low text-left text-xs uppercase tracking-wide text-on-surface-variant">
                  <th scope="col" className="w-8 px-3 py-3">
                    <span className="sr-only">{t("table.reorder")}</span>
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("table.field")}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("table.type")}
                  </th>
                  <th scope="col" className="min-w-36 px-3 py-3 font-medium">
                    {t("table.usage")}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("table.options")}
                  </th>
                  <th scope="col" className="px-3 py-3">
                    <span className="sr-only">{t("table.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((definition, index) => (
                  <FieldRow
                    key={definition.id}
                    definition={definition}
                    usage={usageByDefinition.get(definition.id)}
                    canManage={canManage}
                    isFirst={index === 0}
                    isLast={index === rows.length - 1}
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={(event) => handleDragOver(event, index)}
                    onDragEnd={handleDragEnd}
                    onMoveUp={() => moveRow(index, -1)}
                    onMoveDown={() => moveRow(index, 1)}
                    onEdit={() => setDialog({ mode: "edit", definition })}
                    onArchive={() => setArchiveTarget(definition)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div
          className="reveal-item rounded-2xl border border-border-brand bg-surface-container-lowest"
          style={{ "--cascade-i": 1 } as React.CSSProperties}
        >
          <EmptyState
            icon={SlidersHorizontal}
            title={t("empty.title")}
            description={t("empty.description")}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setDialog({ mode: "create" })}>
                  <Plus size={16} aria-hidden="true" />
                  {t("actions.new")}
                </Button>
              ) : undefined
            }
          />
        </div>
      )}

      {/* Archived fields — values are kept; restore is always possible.
          Cascade slot 2. */}
      {catalog.archived.length > 0 ? (
        <section
          aria-label={t("archived.label")}
          className="reveal-item space-y-3"
          style={{ "--cascade-i": 2 } as React.CSSProperties}
        >
          <h2 className="font-heading text-sm uppercase tracking-wide text-on-surface-variant">
            {t("archived.title", { count: catalog.archived.length })}
          </h2>
          {catalog.archived.map((definition) => (
            <div
              key={definition.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-border-brand bg-surface-container-low px-5 py-4"
            >
              <div className="min-w-0">
                <span className="font-medium text-on-surface">{definition.label}</span>
                <Badge variant="neutral" className="ml-2">
                  {t(`types.${definition.type}`)}
                </Badge>
                <div className="font-mono text-xs text-on-surface-variant">{definition.key}</div>
                <p className="mt-1 text-xs text-on-surface-variant">{t("archived.valuesKept")}</p>
              </div>
              {canManage ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={restoringId === definition.id}
                  onClick={() => void restoreField(definition)}
                >
                  <ArchiveRestore size={16} aria-hidden="true" />
                  {restoringId === definition.id ? t("actions.restoring") : t("actions.restore")}
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {dialog !== null ? (
        <CustomFieldDialog
          domain={domain}
          mode={dialog.mode}
          definition={dialog.mode === "edit" ? dialog.definition : undefined}
          quotas={catalog.quotas}
          showOnRelatedCount={showOnRelatedCount}
          onClose={(changed) => {
            setDialog(null);
            if (changed) router.refresh();
          }}
        />
      ) : null}

      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("archiveDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {archiveTarget
                ? t("archiveDialog.description", { label: archiveTarget.label })
                : t("archiveDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isArchiving}>
                {t("archiveDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmArchive()}
              disabled={isArchiving}
            >
              {isArchiving ? t("archiveDialog.archiving") : t("archiveDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface FieldRowProps {
  definition: CustomFieldDefinition;
  usage: CustomFieldUsageRow | undefined;
  canManage: boolean;
  isFirst: boolean;
  isLast: boolean;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onArchive: () => void;
}

function FieldRow({
  definition,
  usage,
  canManage,
  isFirst,
  isLast,
  onDragStart,
  onDragOver,
  onDragEnd,
  onMoveUp,
  onMoveDown,
  onEdit,
  onArchive,
}: FieldRowProps) {
  const t = useTranslations("settings.customFields");
  const hasOptions = definition.type === "picklist" || definition.type === "multi_picklist";

  return (
    <tr
      draggable={canManage}
      onDragStart={canManage ? onDragStart : undefined}
      onDragOver={canManage ? onDragOver : undefined}
      onDragEnd={canManage ? onDragEnd : undefined}
      className="border-t border-border-brand align-middle"
    >
      <td className="px-3 py-3">
        {canManage ? (
          <span className="inline-flex flex-col items-center">
            <span className="cursor-grab text-on-surface-variant opacity-60" aria-hidden="true">
              <GripVertical size={16} />
            </span>
            {/* Keyboard-accessible fallback for the pointer-only drag. */}
            <span className="sr-only">
              <button type="button" onClick={onMoveUp} disabled={isFirst}>
                {t("actions.moveUp", { label: definition.label })}
              </button>
              <button type="button" onClick={onMoveDown} disabled={isLast}>
                {t("actions.moveDown", { label: definition.label })}
              </button>
            </span>
          </span>
        ) : null}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Operator-authored label — rendered literally, never through i18n. */}
          <span className="font-medium text-on-surface">{definition.label}</span>
          {definition.required ? <Badge variant="warning">{t("badges.required")}</Badge> : null}
          {definition.sensitive ? <Badge variant="error">{t("badges.sensitive")}</Badge> : null}
          {definition.showOnRelated ? <Badge variant="info">{t("badges.projected")}</Badge> : null}
        </div>
        <div className="font-mono text-xs text-on-surface-variant">{definition.key}</div>
      </td>
      <td className="px-3 py-3">
        <Badge variant="neutral">{t(`types.${definition.type}`)}</Badge>
      </td>
      <td className="px-3 py-3">
        <UsageCell usage={usage} />
      </td>
      <td className="px-3 py-3 font-mono tabular-nums text-on-surface-variant">
        {hasOptions ? definition.options.filter((o) => o.active).length : "—"}
      </td>
      <td className="px-3 py-3 text-right">
        {canManage ? (
          <span className="inline-flex gap-1 whitespace-nowrap">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              {t("actions.edit")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onArchive}>
              {t("actions.archive")}
            </Button>
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function UsageCell({ usage }: { usage: CustomFieldUsageRow | undefined }) {
  const t = useTranslations("settings.customFields");

  if (!usage) {
    return <span className="text-on-surface-variant opacity-60">—</span>;
  }
  // k-anonymity: counts under 5 arrive masked from the server.
  if (usage.filledCount === null || usage.fillRate === null) {
    return (
      <span className="font-mono text-xs italic text-on-surface-variant">{t("usage.masked")}</span>
    );
  }
  const percent = Math.round(usage.fillRate * 100);
  return (
    <span className="flex items-center gap-2">
      <Progress value={percent} max={100} className="h-2 w-18" />
      <span className="font-mono text-xs tabular-nums text-on-surface-variant">
        {percent}&nbsp;%
      </span>
    </span>
  );
}
