"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type BulkImportJob,
  BulkImportQueryScope,
  type BulkImportStatus,
  downloadOriginalFile,
  useBulkImportHistory,
} from "@/hooks/use-bulk-import";
import { formatDate } from "@/lib/format";

export function BulkImportHistory() {
  return (
    <BulkImportQueryScope>
      <BulkImportHistoryBody />
    </BulkImportQueryScope>
  );
}

function BulkImportHistoryBody() {
  const t = useTranslations("constituents.bulkImport.history");
  const tStatus = useTranslations("constituents.bulkImport.status");
  const locale = useLocale();

  const query = useBulkImportHistory();

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-error">
        {t("loadError")}
      </p>
    );
  }

  const jobs = query.data ?? [];

  if (jobs.length === 0) {
    return <p className="py-6 text-sm text-on-surface-variant">{t("empty")}</p>;
  }

  return (
    <div className="rounded-2xl bg-surface-container-lowest border border-border-brand">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.createdAt")}</TableHead>
            <TableHead>{t("columns.fileName")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead>{t("columns.rows")}</TableHead>
            <TableHead>{t("columns.results")}</TableHead>
            <TableHead className="text-right">{t("columns.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <HistoryRow
              key={job.id}
              job={job}
              statusLabel={tStatus(job.status)}
              locale={locale}
              labels={{
                results: t("results", {
                  created: job.createdCount,
                  duplicates: job.duplicateCount,
                  failed: job.failedCount,
                }),
                download: t("downloadOriginal"),
                view: t("viewResults"),
              }}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface HistoryRowProps {
  job: BulkImportJob;
  statusLabel: string;
  locale: string;
  labels: { results: string; download: string; view: string };
}

function HistoryRow({ job, statusLabel, locale, labels }: HistoryRowProps) {
  const variant = statusVariant(job.status);

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-on-surface-variant">
        {formatDate(job.createdAt, locale, "short")}
      </TableCell>
      <TableCell className="text-on-surface">{job.fileName}</TableCell>
      <TableCell>
        <Badge variant={variant}>{statusLabel}</Badge>
      </TableCell>
      <TableCell className="font-mono text-sm text-on-surface-variant">
        {job.processedRows}/{job.totalRows}
      </TableCell>
      <TableCell className="text-sm text-on-surface-variant">{labels.results}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => downloadOriginalFile(job.id)}
          >
            <Download size={14} aria-hidden="true" />
            {labels.download}
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link href={`/constituents/bulk-import/${job.id}`}>{labels.view}</Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function statusVariant(status: BulkImportStatus): "success" | "warning" | "error" | "info" {
  if (status === "completed") return "success";
  if (status === "partial") return "warning";
  if (status === "failed") return "error";
  return "info";
}
