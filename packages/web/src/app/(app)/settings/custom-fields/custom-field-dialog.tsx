"use client";

import {
  CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH,
  CUSTOM_FIELD_KEY_PATTERN,
  CUSTOM_FIELD_LABEL_MAX_LENGTH,
  CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH,
  CUSTOM_FIELD_PURPOSE_MAX_LENGTH,
  CUSTOM_FIELD_TYPE_VALUES,
  generateOptionId,
  isReservedKey,
} from "@givernance/shared/custom-fields";
import { ArrowDown, ArrowUp, Merge, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type {
  CustomFieldDefinition,
  CustomFieldDomain,
  CustomFieldOption,
  CustomFieldQuotaInfo,
  CustomFieldType,
} from "@/models/custom-field";
import { CustomFieldsService } from "@/services/CustomFieldsService";

import { OptionMergeDialog } from "./option-merge-dialog";

interface CustomFieldDialogProps {
  domain: CustomFieldDomain;
  mode: "create" | "edit";
  definition?: CustomFieldDefinition;
  quotas: CustomFieldQuotaInfo | null;
  /** Active `showOnRelated` definitions in this domain (cap enforcement UX). */
  showOnRelatedCount: number;
  onClose: (changed: boolean) => void;
}

/**
 * Derive the immutable technical key from the operator's label: lowercase,
 * accents stripped, non-alphanumerics collapsed to `_`, clamped to the
 * `^[a-z][a-z0-9_]{1,62}$` DB pattern, reserved keys suffixed. Shown once
 * at creation — never editable, never re-shown in edit.
 */
export function deriveKeyFromLabel(label: string): string {
  let key = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (!/^[a-z]/.test(key)) key = key ? `f_${key}` : "";
  key = key.slice(0, 63);
  if (key && isReservedKey(key)) key = `${key.slice(0, 61)}_f`;
  return CUSTOM_FIELD_KEY_PATTERN.test(key) ? key : "";
}

const PICKLIST_TYPES: ReadonlySet<CustomFieldType> = new Set(["picklist", "multi_picklist"]);

export function CustomFieldDialog({
  domain,
  mode,
  definition,
  quotas,
  showOnRelatedCount,
  onClose,
}: CustomFieldDialogProps) {
  const t = useTranslations("settings.customFields");

  const [label, setLabel] = useState(definition?.label ?? "");
  const [description, setDescription] = useState(definition?.description ?? "");
  const [type, setType] = useState<CustomFieldType>(definition?.type ?? "text");
  const [options, setOptions] = useState<CustomFieldOption[]>(definition?.options ?? []);
  const [required, setRequired] = useState(definition?.required ?? false);
  const [filterable, setFilterable] = useState(definition?.filterable ?? true);
  const [exportable, setExportable] = useState(definition?.exportable ?? true);
  const [showOnRelated, setShowOnRelated] = useState(definition?.showOnRelated ?? false);
  const [sensitive, setSensitive] = useState(definition?.sensitive ?? false);
  const [purposeText, setPurposeText] = useState(definition?.purposeText ?? "");
  const [rootError, setRootError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mergeSource, setMergeSource] = useState<CustomFieldOption | null>(null);
  // Tracks edit-mode option mutations that already hit the API, so closing
  // without saving still refreshes the parent list.
  const changedRef = useRef(false);

  const isEdit = mode === "edit" && definition !== undefined;
  const derivedKey = useMemo(() => deriveKeyFromLabel(label), [label]);
  const hasOptions = PICKLIST_TYPES.has(type);
  const activeOptions = useMemo(() => options.filter((o) => o.active), [options]);
  const optionLimit = quotas?.optionsPerPicklist ?? null;
  const optionLimitReached = optionLimit !== null && options.length >= optionLimit;

  // Projection: constituent domain only, sensitive fields structurally
  // ineligible, hard cap enforced server-side — mirrored here for UX.
  const projectionCap = quotas?.showOnRelatedFields ?? null;
  const projectionCapReached =
    projectionCap !== null &&
    showOnRelatedCount - (isEdit && definition.showOnRelated ? 1 : 0) >= projectionCap;
  const projectionAvailable = domain === "constituent" && !sensitive;

  const problemMessage = useCallback(
    (error: unknown) =>
      error instanceof ApiProblem
        ? (error.detail ?? error.title ?? t("errors.generic"))
        : t("errors.generic"),
    [t],
  );

  const close = useCallback(() => onClose(changedRef.current), [onClose]);

  // ── Option operations ────────────────────────────────────────────────
  // Create mode: options live locally until the field is POSTed.
  // Edit mode: each operation is an immediate audited API call.

  const addOption = useCallback(async () => {
    const option: CustomFieldOption = {
      id: generateOptionId(),
      label: "",
      active: true,
      sortOrder: options.length,
    };
    setOptions((current) => [...current, option]);
  }, [options.length]);

  const renameOption = useCallback(async (optionId: string, nextLabel: string) => {
    setOptions((current) =>
      current.map((o) => (o.id === optionId ? { ...o, label: nextLabel } : o)),
    );
  }, []);

  const commitOptionRename = useCallback(
    async (option: CustomFieldOption) => {
      if (!isEdit) return;
      const original = definition.options.find((o) => o.id === option.id);
      const trimmed = option.label.trim();
      if (trimmed === "" || original?.label === trimmed) return;
      try {
        const updated = await CustomFieldsService.updateOption(
          createClientApiClient(),
          definition.id,
          option.id,
          { label: trimmed },
        );
        changedRef.current = true;
        setOptions(updated.options);
        toast.success(t("success.optionRenamed"));
      } catch (error) {
        setOptions(definition.options);
        toast.error(problemMessage(error));
      }
    },
    [definition, isEdit, problemMessage, t],
  );

  const persistNewOption = useCallback(
    async (option: CustomFieldOption) => {
      if (!isEdit) return;
      const trimmed = option.label.trim();
      if (trimmed === "") {
        setOptions((current) => current.filter((o) => o.id !== option.id));
        return;
      }
      try {
        const updated = await CustomFieldsService.addOption(
          createClientApiClient(),
          definition.id,
          {
            id: option.id,
            label: trimmed,
          },
        );
        changedRef.current = true;
        setOptions(updated.options);
        toast.success(t("success.optionAdded"));
      } catch (error) {
        setOptions((current) => current.filter((o) => o.id !== option.id));
        toast.error(problemMessage(error));
      }
    },
    [definition, isEdit, problemMessage, t],
  );

  const setOptionActive = useCallback(
    async (option: CustomFieldOption, active: boolean) => {
      if (!isEdit) {
        setOptions((current) => current.map((o) => (o.id === option.id ? { ...o, active } : o)));
        return;
      }
      try {
        const updated = await CustomFieldsService.updateOption(
          createClientApiClient(),
          definition.id,
          option.id,
          { active },
        );
        changedRef.current = true;
        setOptions(updated.options);
      } catch (error) {
        toast.error(problemMessage(error));
      }
    },
    [definition, isEdit, problemMessage],
  );

  const moveOption = useCallback(
    async (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= options.length) return;
      const next = [...options];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return;
      next.splice(target, 0, moved);
      const renumbered = next.map((o, i) => ({ ...o, sortOrder: i }));
      setOptions(renumbered);
      if (!isEdit) return;
      try {
        const updated = await CustomFieldsService.updateOption(
          createClientApiClient(),
          definition.id,
          moved.id,
          { sortOrder: target },
        );
        changedRef.current = true;
        setOptions(updated.options);
      } catch (error) {
        setOptions(options);
        toast.error(problemMessage(error));
      }
    },
    [definition, isEdit, options, problemMessage],
  );

  const removeDraftOption = useCallback((optionId: string) => {
    setOptions((current) => current.filter((o) => o.id !== optionId));
  }, []);

  const onMergeClosed = useCallback(
    (merged: boolean, result?: { mergeId: string | null; targetOptionId: string }) => {
      const source = mergeSource;
      setMergeSource(null);
      if (merged && source) {
        changedRef.current = true;
        // The backfill runs async; reflect the immediate effect (source
        // deactivated, undo handle attached) without waiting for refresh.
        setOptions((current) =>
          current.map((o) =>
            o.id === source.id
              ? {
                  ...o,
                  active: false,
                  ...(result
                    ? {
                        mergedInto: result.targetOptionId,
                        ...(result.mergeId !== null ? { mergeId: result.mergeId } : {}),
                        mergedAt: new Date().toISOString(),
                      }
                    : {}),
                }
              : o,
          ),
        );
      }
    },
    [mergeSource],
  );

  const undoMerge = useCallback(
    async (option: CustomFieldOption) => {
      if (!isEdit || !option.mergeId) return;
      try {
        await CustomFieldsService.undoMergeOption(
          createClientApiClient(),
          definition.id,
          option.id,
          option.mergeId,
        );
        changedRef.current = true;
        // The value restore runs async; the option itself is active again.
        setOptions((current) =>
          current.map((o) =>
            o.id === option.id
              ? {
                  ...o,
                  active: true,
                  mergedInto: undefined,
                  mergeId: undefined,
                  mergedAt: undefined,
                }
              : o,
          ),
        );
        toast.success(t("success.mergeUndone"));
      } catch (error) {
        toast.error(problemMessage(error));
      }
    },
    [definition, isEdit, problemMessage, t],
  );

  // ── Submit ───────────────────────────────────────────────────────────

  const validate = useCallback((): string | null => {
    if (label.trim() === "") return t("form.errors.labelRequired");
    if (mode === "create" && derivedKey === "") return t("form.errors.keyUnderivable");
    if (
      hasOptions &&
      mode === "create" &&
      activeOptions.filter((o) => o.label.trim() !== "").length === 0
    ) {
      return t("form.errors.optionRequired");
    }
    if (sensitive && purposeText.trim() === "") return t("form.errors.purposeRequired");
    return null;
  }, [activeOptions, derivedKey, hasOptions, label, mode, purposeText, sensitive, t]);

  const submit = useCallback(async () => {
    const validationError = validate();
    if (validationError !== null) {
      setRootError(validationError);
      return;
    }
    setRootError(null);
    setIsSubmitting(true);
    const client = createClientApiClient();
    try {
      if (isEdit) {
        await CustomFieldsService.updateField(client, definition.id, {
          label: label.trim(),
          description: description.trim() || null,
          required,
          filterable,
          exportable,
          showOnRelated: projectionAvailable ? showOnRelated : false,
          sensitive,
          purposeText: sensitive ? purposeText.trim() : null,
        });
        toast.success(t("success.updated"));
      } else {
        await CustomFieldsService.createField(client, {
          domain,
          key: derivedKey,
          label: label.trim(),
          description: description.trim() || null,
          type,
          options: hasOptions
            ? options
                .filter((o) => o.label.trim() !== "")
                .map((o, index) => ({ ...o, label: o.label.trim(), sortOrder: index }))
            : undefined,
          required,
          filterable,
          exportable,
          showOnRelated: projectionAvailable ? showOnRelated : false,
          sensitive,
          purposeText: sensitive ? purposeText.trim() : null,
        });
        toast.success(t("success.created"));
      }
      changedRef.current = true;
      close();
    } catch (error) {
      setRootError(problemMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    close,
    definition,
    derivedKey,
    description,
    domain,
    exportable,
    filterable,
    hasOptions,
    isEdit,
    label,
    options,
    problemMessage,
    projectionAvailable,
    purposeText,
    required,
    sensitive,
    showOnRelated,
    t,
    type,
    validate,
  ]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("form.editTitle", { label: definition.label })
              : t("form.createTitle", { domain: t(`domains.${domain}`) })}
          </DialogTitle>
          <DialogDescription>{t("form.typeImmutableHint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="cf-label">{t("form.label")}</Label>
            <Input
              id="cf-label"
              value={label}
              maxLength={CUSTOM_FIELD_LABEL_MAX_LENGTH}
              placeholder={t("form.labelPlaceholder")}
              onChange={(event) => setLabel(event.target.value)}
            />
            {mode === "create" ? (
              <p className="rounded-md bg-surface-container px-3 py-2 font-mono text-xs text-on-surface-variant">
                {t("form.keyPreview")}{" "}
                <strong className="text-on-surface">{derivedKey || "—"}</strong>
                {" — "}
                {t("form.keyPreviewHint")}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-type">{t("form.type")}</Label>
              <Select
                value={type}
                onValueChange={(value) => setType(value as CustomFieldType)}
                disabled={isEdit}
              >
                <SelectTrigger id="cf-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_FIELD_TYPE_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`types.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-on-surface-variant">{t("form.typeHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-description">{t("form.description")}</Label>
              <Input
                id="cf-description"
                value={description}
                maxLength={CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH}
                placeholder={t("form.descriptionPlaceholder")}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>

          {hasOptions ? (
            <div className="space-y-2">
              <span className="text-sm font-medium text-on-surface">{t("form.options")}</span>
              <ul className="divide-y divide-border-brand rounded-md border border-border-brand">
                {options.map((option, index) => (
                  <li key={option.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="inline-flex flex-col">
                      <button
                        type="button"
                        className="text-on-surface-variant opacity-60 hover:opacity-100 disabled:opacity-20"
                        onClick={() => void moveOption(index, -1)}
                        disabled={index === 0}
                        aria-label={t("form.optionMoveUp", { label: option.label })}
                      >
                        <ArrowUp size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="text-on-surface-variant opacity-60 hover:opacity-100 disabled:opacity-20"
                        onClick={() => void moveOption(index, 1)}
                        disabled={index === options.length - 1}
                        aria-label={t("form.optionMoveDown", { label: option.label })}
                      >
                        <ArrowDown size={12} aria-hidden="true" />
                      </button>
                    </span>
                    <Input
                      value={option.label}
                      maxLength={CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH}
                      aria-label={t("form.optionRename", { label: option.label })}
                      placeholder={t("form.optionPlaceholder")}
                      className={
                        option.active ? "h-8 flex-1" : "h-8 flex-1 line-through opacity-60"
                      }
                      onChange={(event) => void renameOption(option.id, event.target.value)}
                      onBlur={() => {
                        const isPersisted = definition?.options.some((o) => o.id === option.id);
                        if (isPersisted) {
                          void commitOptionRename({ ...option });
                        } else if (isEdit) {
                          void persistNewOption({ ...option });
                        }
                      }}
                    />
                    <span className="font-mono text-[10px] text-on-surface-variant">
                      {option.id}
                    </span>
                    {option.active ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void setOptionActive(option, false)}
                        >
                          {t("form.optionDeactivate")}
                        </Button>
                        {isEdit && activeOptions.length > 1 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setMergeSource(option)}
                            aria-label={t("form.optionMerge", { label: option.label })}
                          >
                            <Merge size={14} aria-hidden="true" />
                            {t("form.optionMergeShort")}
                          </Button>
                        ) : null}
                        {!isEdit ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeDraftOption(option.id)}
                            aria-label={t("form.optionRemove", { label: option.label })}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <Badge variant="neutral">
                          {option.mergedInto ? t("form.optionMerged") : t("form.optionInactive")}
                        </Badge>
                        {option.mergedInto ? (
                          option.mergeId ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void undoMerge(option)}
                            >
                              {t("form.optionUndoMerge")}
                            </Button>
                          ) : null
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void setOptionActive(option, true)}
                          >
                            {t("form.optionReactivate")}
                          </Button>
                        )}
                      </>
                    )}
                  </li>
                ))}
                {options.length === 0 ? (
                  <li className="px-3 py-3 text-sm text-on-surface-variant">
                    {t("form.optionsEmpty")}
                  </li>
                ) : null}
              </ul>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void addOption()}
                disabled={optionLimitReached}
              >
                <Plus size={14} aria-hidden="true" />
                {t("form.optionAdd")}
              </Button>
              <p className="text-xs text-on-surface-variant">
                {optionLimitReached && optionLimit !== null
                  ? t("form.optionQuotaReached", { limit: optionLimit })
                  : t("form.optionsHint")}
              </p>
            </div>
          ) : null}

          <div className="space-y-3">
            <ToggleRow
              id="cf-required"
              checked={required}
              onCheckedChange={setRequired}
              title={t("form.required")}
              hint={t("form.requiredHint")}
            />
            <ToggleRow
              id="cf-filterable"
              checked={filterable}
              onCheckedChange={setFilterable}
              title={t("form.filterable")}
              hint={t("form.filterableHint")}
            />
            <ToggleRow
              id="cf-exportable"
              checked={exportable}
              onCheckedChange={setExportable}
              title={t("form.exportable")}
              hint={t("form.exportableHint")}
            />
            {domain === "constituent" ? (
              <ToggleRow
                id="cf-projected"
                checked={projectionAvailable && showOnRelated}
                onCheckedChange={setShowOnRelated}
                disabled={!projectionAvailable || (projectionCapReached && !showOnRelated)}
                title={t("form.projected")}
                hint={
                  sensitive
                    ? t("form.projectedSensitiveHint")
                    : projectionCapReached && !showOnRelated && projectionCap !== null
                      ? t("form.projectedCapHint", { cap: projectionCap })
                      : t("form.projectedHint")
                }
              />
            ) : null}
            <ToggleRow
              id="cf-sensitive"
              checked={sensitive}
              onCheckedChange={(checked) => {
                setSensitive(checked);
                if (checked) setShowOnRelated(false);
              }}
              title={t("form.sensitive")}
              hint={t("form.sensitiveHint")}
            />
            {sensitive ? (
              <div className="space-y-2">
                <div className="rounded-md border-l-4 border-tertiary bg-tertiary-fixed/40 px-4 py-3 text-xs text-on-surface-variant">
                  <strong className="text-on-surface">{t("form.art9Title")}</strong>{" "}
                  {t("form.art9Body")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-purpose">{t("form.purpose")}</Label>
                  <Textarea
                    id="cf-purpose"
                    rows={2}
                    value={purposeText}
                    maxLength={CUSTOM_FIELD_PURPOSE_MAX_LENGTH}
                    placeholder={t("form.purposePlaceholder")}
                    onChange={(event) => setPurposeText(event.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {rootError !== null ? (
            <p role="alert" className="text-sm text-error">
              {rootError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={isSubmitting}>
            {t("form.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={isSubmitting}>
            {isSubmitting ? t("form.saving") : isEdit ? t("form.save") : t("form.create")}
          </Button>
        </DialogFooter>
      </DialogContent>

      {isEdit && mergeSource !== null ? (
        <OptionMergeDialog
          definitionId={definition.id}
          sourceOption={mergeSource}
          targetOptions={activeOptions.filter((o) => o.id !== mergeSource.id)}
          onClose={onMergeClosed}
        />
      ) : null}
    </Dialog>
  );
}

interface ToggleRowProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  title: string;
  hint: string;
}

function ToggleRow({ id, checked, onCheckedChange, disabled, title, hint }: ToggleRowProps) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(state) => onCheckedChange(state === true)}
        className="mt-0.5"
      />
      <label htmlFor={id} className="cursor-pointer">
        <span className="block text-sm font-medium text-on-surface">{title}</span>
        <span className="text-xs text-on-surface-variant">{hint}</span>
      </label>
    </div>
  );
}
