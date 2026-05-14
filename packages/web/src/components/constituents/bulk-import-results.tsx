"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BulkImportQueryScope,
  type BulkImportResultRow,
  useBulkImportResults,
} from "@/hooks/use-bulk-import";

interface BulkImportResultsProps {
  jobId: string;
}

export function BulkImportResults(props: BulkImportResultsProps) {
  return (
    <BulkImportQueryScope>
      <BulkImportResultsBody {...props} />
    </BulkImportQueryScope>
  );
}

type TabId = "all" | "created" | "duplicate" | "failed";

function BulkImportResultsBody({ jobId }: BulkImportResultsProps) {
  const t = useTranslations("constituents.bulkImport.results");
  const tStatus = useTranslations("constituents.bulkImport.status");
  const tTabs = useTranslations("constituents.bulkImport.results.tabs");
  const [tab, setTab] = useState<TabId>("all");

  const query = useBulkImportResults(jobId);

  const rows = query.data ?? [];

  const filtered = useMemo(() => {
    if (tab === "all") return rows;
    if (tab === "duplicate") return rows.filter((row) => row.status === "duplicate");
    if (tab === "created") return rows.filter((row) => row.status === "created");
    return rows.filter((row) => row.status === "failed");
  }, [rows, tab]);

  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-error">
        {t("loadError")}
      </p>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
      <TabsList>
        <TabsTrigger value="all">{tTabs("all")}</TabsTrigger>
        <TabsTrigger value="created">{tTabs("created")}</TabsTrigger>
        <TabsTrigger value="duplicate">{tTabs("duplicates")}</TabsTrigger>
        <TabsTrigger value="failed">{tTabs("failed")}</TabsTrigger>
      </TabsList>
      <TabsContent value={tab}>
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-on-surface-variant">{t("empty")}</p>
        ) : (
          <div className="rounded-2xl bg-surface-container-lowest shadow-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">{t("columns.row")}</TableHead>
                  <TableHead className="w-28">{t("columns.status")}</TableHead>
                  <TableHead>{t("columns.firstName")}</TableHead>
                  <TableHead>{t("columns.lastName")}</TableHead>
                  <TableHead>{t("columns.email")}</TableHead>
                  <TableHead>{t("columns.error")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <ResultRow key={row.id} row={row} statusLabel={statusLabel(row, tStatus)} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function ResultRow({ row, statusLabel }: { row: BulkImportResultRow; statusLabel: string }) {
  const variant: "success" | "warning" | "error" =
    row.status === "created" ? "success" : row.status === "duplicate" ? "warning" : "error";

  // Pretty-render the known constituent fields from the row snapshot — never
  // JSON.stringify the whole payload into the table cell.
  const fields = extractKnownFields(row.rowData);

  return (
    <TableRow>
      <TableCell className="font-mono text-xs text-on-surface-variant">{row.rowNumber}</TableCell>
      <TableCell>
        <Badge variant={variant}>{statusLabel}</Badge>
      </TableCell>
      <TableCell className="text-sm text-on-surface">{fields.firstName ?? "—"}</TableCell>
      <TableCell className="text-sm text-on-surface">{fields.lastName ?? "—"}</TableCell>
      <TableCell className="text-sm text-on-surface-variant">{fields.email ?? "—"}</TableCell>
      <TableCell className="text-sm text-error">
        {row.status === "failed" && row.errorMessage ? (
          <span>
            {row.errorCode ? <span className="font-mono text-xs">[{row.errorCode}] </span> : null}
            {row.errorMessage}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
    </TableRow>
  );
}

function statusLabel(
  row: BulkImportResultRow,
  tStatus: (key: "pending" | "processing" | "completed" | "partial" | "failed") => string,
): string {
  if (row.status === "created") return tStatus("completed");
  if (row.status === "failed") return tStatus("failed");
  // duplicate falls back to a localized literal — there's no `duplicate`
  // key on `status` (it's a result-row status, not a job status).
  return tStatus("partial");
}

interface KnownFields {
  firstName?: string;
  lastName?: string;
  email?: string;
}

function extractKnownFields(rowData: Record<string, unknown>): KnownFields {
  const result: KnownFields = {};
  const firstName = pickString(rowData, [
    "firstName",
    "first_name",
    "First Name",
    "Prénom",
    "Prenom",
  ]);
  if (firstName) result.firstName = firstName;
  const lastName = pickString(rowData, ["lastName", "last_name", "Last Name", "Nom"]);
  if (lastName) result.lastName = lastName;
  const email = pickString(rowData, ["email", "Email", "Email Address"]);
  if (email) result.email = email;
  return result;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
