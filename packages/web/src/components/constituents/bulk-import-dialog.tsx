"use client";

import { Check, Download, Upload, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ChangeEvent, type DragEvent, useEffect, useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  BulkImportQueryScope,
  type BulkImportStatus,
  downloadTemplate,
  isTerminal,
  useBulkImportJob,
  useUploadBulkImport,
} from "@/hooks/use-bulk-import";
import { cn } from "@/lib/utils";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = [".csv", ".xlsx", ".xls"];
const ACCEPTED_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

type Step = "template" | "upload" | "progress";

interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional callback for the parent to refresh its row count after import. */
  onCompleted?: () => void;
}

export function BulkImportDialog({ open, onOpenChange, onCompleted }: BulkImportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <BulkImportQueryScope>
          <BulkImportDialogBody
            open={open}
            onClose={() => onOpenChange(false)}
            onCompleted={onCompleted}
          />
        </BulkImportQueryScope>
      </DialogContent>
    </Dialog>
  );
}

interface BodyProps {
  open: boolean;
  onClose: () => void;
  onCompleted?: () => void;
}

function BulkImportDialogBody({ open, onClose, onCompleted }: BodyProps) {
  const t = useTranslations("constituents.bulkImport");
  const [step, setStep] = useState<Step>("template");
  const [file, setFile] = useState<File | null>(null);
  const [force, setForce] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const uploadMutation = useUploadBulkImport();
  const jobQuery = useBulkImportJob(jobId);

  // Reset everything when the dialog closes — keeps consecutive opens clean.
  useEffect(() => {
    if (!open) {
      setStep("template");
      setFile(null);
      setForce(false);
      setJobId(null);
      uploadMutation.reset();
    }
  }, [open, uploadMutation]);

  // Fire `onCompleted` exactly once when the job lands in a terminal state.
  const lastNotified = useRef<string | null>(null);
  useEffect(() => {
    const status = jobQuery.data?.status;
    if (!jobId || !status) return;
    if (!isTerminal(status)) return;
    if (lastNotified.current === jobId) return;
    lastNotified.current = jobId;
    onCompleted?.();
  }, [jobId, jobQuery.data?.status, onCompleted]);

  function handleDownloadTemplate() {
    downloadTemplate().catch(() => {
      toast.error(t("template.downloadError"));
    });
  }

  function handleFileChosen(next: File | null) {
    if (!next) {
      setFile(null);
      return;
    }
    if (next.size > MAX_FILE_SIZE_BYTES) {
      toast.error(t("upload.errors.tooLarge"));
      return;
    }
    if (!isAcceptedFile(next)) {
      toast.error(t("upload.errors.badType"));
      return;
    }
    setFile(next);
  }

  function handleSubmitUpload() {
    if (!file) return;
    uploadMutation.mutate(
      { file, force },
      {
        onSuccess: (job) => {
          setJobId(job.id);
          setStep("progress");
        },
        onError: () => {
          toast.error(t("upload.errors.generic"));
        },
      },
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <Stepper current={step} />

      {step === "template" ? (
        <TemplateStep
          onDownload={handleDownloadTemplate}
          onNext={() => setStep("upload")}
          onCancel={onClose}
        />
      ) : null}

      {step === "upload" ? (
        <UploadStep
          file={file}
          force={force}
          submitting={uploadMutation.isPending}
          onFileChosen={handleFileChosen}
          onForceChange={setForce}
          onBack={() => setStep("template")}
          onSubmit={handleSubmitUpload}
        />
      ) : null}

      {step === "progress" ? (
        <ProgressStep job={jobQuery.data ?? null} loading={jobQuery.isLoading} onClose={onClose} />
      ) : null}
    </>
  );
}

function Stepper({ current }: { current: Step }) {
  const t = useTranslations("constituents.bulkImport.steps");
  const steps: Array<{ id: Step; label: string }> = [
    { id: "template", label: t("template") },
    { id: "upload", label: t("upload") },
    { id: "progress", label: t("progress") },
  ];
  const currentIndex = steps.findIndex((s) => s.id === current);

  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Progress">
      {steps.map((s, index) => {
        const completed = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={s.id} className="flex flex-1 items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                completed
                  ? "bg-primary text-on-primary"
                  : active
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-highest text-on-surface-variant",
              )}
            >
              {completed ? <Check size={14} aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={cn(
                "text-xs font-medium",
                active ? "text-on-surface" : "text-on-surface-variant",
              )}
            >
              {s.label}
            </span>
            {index < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px flex-1",
                  index < currentIndex ? "bg-primary" : "bg-outline-variant",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

interface TemplateStepProps {
  onDownload: () => void;
  onNext: () => void;
  onCancel: () => void;
}

function TemplateStep({ onDownload, onNext, onCancel }: TemplateStepProps) {
  const t = useTranslations("constituents.bulkImport.template");
  const tUpload = useTranslations("constituents.bulkImport.upload");
  return (
    <>
      <div className="space-y-4">
        <h3 className="font-heading text-lg text-on-surface">{t("title")}</h3>
        <p className="text-sm text-on-surface-variant">{t("body")}</p>
        <Button type="button" variant="secondary" onClick={onDownload}>
          <Download size={16} aria-hidden="true" />
          {t("download")}
        </Button>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {tUpload("back")}
        </Button>
        <Button variant="primary" onClick={onNext}>
          {t("next")}
        </Button>
      </DialogFooter>
    </>
  );
}

interface UploadStepProps {
  file: File | null;
  force: boolean;
  submitting: boolean;
  onFileChosen: (file: File | null) => void;
  onForceChange: (next: boolean) => void;
  onBack: () => void;
  onSubmit: () => void;
}

function UploadStep({
  file,
  force,
  submitting,
  onFileChosen,
  onForceChange,
  onBack,
  onSubmit,
}: UploadStepProps) {
  const t = useTranslations("constituents.bulkImport.upload");
  const inputId = useId();
  const [dragOver, setDragOver] = useState(false);

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    onFileChosen(next);
    // Reset so re-selecting the same file fires `change` again.
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const next = event.dataTransfer.files?.[0] ?? null;
    onFileChosen(next);
  }

  return (
    <>
      <div className="space-y-4">
        <h3 className="font-heading text-lg text-on-surface">{t("title")}</h3>

        {file ? (
          <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-primary/30 bg-primary-fixed/40 px-4 py-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary text-xs font-bold text-on-primary"
            >
              CSV
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-on-surface">{file.name}</p>
              <p className="text-xs text-on-surface-variant">{formatFileSize(file.size)}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("remove")}
              onClick={() => onFileChosen(null)}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is the visual affordance — the inner <input type="file"> + <label> below provides the accessible keyboard path
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              "rounded-[var(--radius-lg)] border-2 border-dashed bg-surface-container-low p-10 text-center transition-colors",
              "focus-within:border-primary focus-within:bg-primary-fixed/30",
              dragOver ? "border-primary bg-primary-fixed/30" : "border-outline-variant",
            )}
          >
            <Upload size={40} aria-hidden="true" className="mx-auto mb-3 text-on-surface-variant" />
            <p className="font-heading text-base text-on-surface">{t("dropzone")}</p>
            <p className="mt-1 text-xs text-on-surface-variant">{t("hint")}</p>
            <label
              htmlFor={inputId}
              className={cn(
                "mt-4 inline-flex h-[var(--btn-height-sm)] cursor-pointer items-center justify-center gap-2",
                "rounded-[var(--radius-button)] bg-primary px-4 text-xs font-medium text-on-primary",
                "hover:bg-primary-hover focus-within:shadow-ring",
              )}
            >
              {t("browse")}
            </label>
            <input
              id={inputId}
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              onChange={onInputChange}
              className="sr-only"
            />
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={force}
            onChange={(event) => onForceChange(event.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{t("force")}</span>
            <span className="block text-xs text-on-surface-variant">{t("forceHint")}</span>
          </span>
        </label>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          {t("back")}
        </Button>
        <Button variant="primary" onClick={onSubmit} disabled={!file || submitting}>
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </DialogFooter>
    </>
  );
}

interface ProgressStepProps {
  job: {
    id: string;
    status: BulkImportStatus;
    totalRows: number;
    processedRows: number;
    createdCount: number;
    duplicateCount: number;
    failedCount: number;
    completeAddressCount: number;
    emailCount: number;
    error: string | null;
  } | null;
  loading: boolean;
  onClose: () => void;
}

function ProgressStep({ job, loading, onClose }: ProgressStepProps) {
  const t = useTranslations("constituents.bulkImport.progress");
  const tStatus = useTranslations("constituents.bulkImport.status");
  const tKpi = useTranslations("constituents.bulkImport.progress.kpis");

  if (loading || !job) {
    return (
      <div className="space-y-3 py-4 text-sm text-on-surface-variant">
        <p>{t("subtitle")}</p>
      </div>
    );
  }

  const percent =
    job.totalRows > 0 ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100)) : 0;

  const variant: "success" | "warning" | "error" | "info" =
    job.status === "completed"
      ? "success"
      : job.status === "partial"
        ? "warning"
        : job.status === "failed"
          ? "error"
          : "info";

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-heading text-lg text-on-surface">{t("title")}</h3>
          <Badge variant={variant} shape="square">
            {tStatus(job.status)}
          </Badge>
        </div>
        <p className="text-sm text-on-surface-variant">{t("subtitle")}</p>

        <div>
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("title")}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-container-highest"
          >
            <div
              className="h-full bg-primary transition-all duration-normal ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-on-surface-variant">
            {t("rows", { processed: job.processedRows, total: job.totalRows })}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <KpiCard label={tKpi("created")} value={job.createdCount} tone="success" />
          <KpiCard label={tKpi("duplicates")} value={job.duplicateCount} tone="warning" />
          <KpiCard label={tKpi("failed")} value={job.failedCount} tone="error" />
          <KpiCard label={tKpi("addresses")} value={job.completeAddressCount} tone="info" />
          <KpiCard label={tKpi("emails")} value={job.emailCount} tone="info" />
        </div>

        {job.error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            {job.error}
          </p>
        ) : null}

        {isTerminal(job.status) ? (
          <Link
            href={`/constituents/bulk-import/${job.id}`}
            className="inline-flex text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("viewResults")}
          </Link>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          {t("close")}
        </Button>
      </DialogFooter>
    </>
  );
}

type KpiTone = "success" | "warning" | "error" | "info";

function KpiCard({ label, value, tone }: { label: string; value: number; tone: KpiTone }) {
  const toneClass: Record<KpiTone, string> = {
    success: "bg-primary-fixed text-on-primary-fixed-variant",
    warning: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
    error: "bg-error-container text-on-error-container",
    info: "bg-secondary-fixed text-on-secondary-fixed-variant",
  };
  return (
    <div className={cn("rounded-[var(--radius-md)] px-3 py-3 text-center", toneClass[tone])}>
      <div className="font-mono text-xl font-bold leading-tight">{value}</div>
      <div className="mt-1 text-xs font-medium">{label}</div>
    </div>
  );
}

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  return ACCEPTED_MIME_TYPES.has(file.type);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
