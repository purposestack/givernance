"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { CustomFieldOption } from "@/models/custom-field";
import { CustomFieldsService } from "@/services/CustomFieldsService";

interface OptionMergeDialogProps {
  definitionId: string;
  sourceOption: CustomFieldOption;
  /** Active options the source can merge into (source itself excluded). */
  targetOptions: CustomFieldOption[];
  onClose: (merged: boolean, result?: { mergeId: string | null; targetOptionId: string }) => void;
}

/**
 * Option merge with a dry-run preview (Epic #539): every target change
 * re-runs `?dryRun=true` for the affected-row count; the real call answers
 * 202 and the rewrite runs as an idempotent audited backfill job with a
 * 30-day undo window. The merged option is deactivated, never deleted.
 */
export function OptionMergeDialog({
  definitionId,
  sourceOption,
  targetOptions,
  onClose,
}: OptionMergeDialogProps) {
  const t = useTranslations("settings.customFields.mergeDialog");

  const [targetId, setTargetId] = useState<string | undefined>(targetOptions[0]?.id);
  const [affectedCount, setAffectedCount] = useState<number | null>(null);
  const [isCounting, setIsCounting] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [dryRunFailed, setDryRunFailed] = useState(false);

  useEffect(() => {
    if (targetId === undefined) return;
    let cancelled = false;
    setIsCounting(true);
    setDryRunFailed(false);
    setAffectedCount(null);
    CustomFieldsService.mergeOptionDryRun(
      createClientApiClient(),
      definitionId,
      sourceOption.id,
      targetId,
    )
      .then((result) => {
        if (!cancelled) setAffectedCount(result.affectedCount);
      })
      .catch(() => {
        if (!cancelled) setDryRunFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsCounting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId, sourceOption.id, targetId]);

  const confirm = useCallback(async () => {
    if (targetId === undefined) return;
    setIsMerging(true);
    try {
      const result = await CustomFieldsService.mergeOption(
        createClientApiClient(),
        definitionId,
        sourceOption.id,
        targetId,
      );
      toast.success(t("success"));
      onClose(true, { mergeId: result.mergeId, targetOptionId: targetId });
    } catch (error) {
      const message =
        error instanceof ApiProblem
          ? (error.detail ?? error.title ?? t("errors.generic"))
          : t("errors.generic");
      toast.error(message);
      setIsMerging(false);
    }
  }, [definitionId, onClose, sourceOption.id, t, targetId]);

  const targetLabel = targetOptions.find((o) => o.id === targetId)?.label ?? "";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { source: sourceOption.label })}</DialogTitle>
          <DialogDescription>
            {targetId !== undefined
              ? t("description", { source: sourceOption.label, target: targetLabel })
              : t("descriptionNoTarget")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="merge-target">{t("target")}</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="merge-target">
                <SelectValue placeholder={t("targetPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            aria-live="polite"
            className="rounded-md border-l-4 border-primary bg-primary-fixed/30 px-4 py-3 text-sm text-on-surface"
          >
            {isCounting
              ? t("counting")
              : dryRunFailed
                ? t("countUnavailable")
                : affectedCount !== null
                  ? t("preview", { count: affectedCount })
                  : t("countUnavailable")}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={isMerging}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void confirm()}
            disabled={isMerging || targetId === undefined || isCounting}
          >
            {isMerging ? t("merging") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
