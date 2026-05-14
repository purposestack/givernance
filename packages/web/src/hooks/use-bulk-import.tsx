"use client";

import {
  type QueryClient,
  QueryClientProvider,
  QueryClient as TanstackQueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { ApiClient } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";

export type BulkImportStatus = "pending" | "processing" | "completed" | "partial" | "failed";

const TERMINAL: ReadonlySet<BulkImportStatus> = new Set(["completed", "partial", "failed"]);

export function isTerminal(status: BulkImportStatus | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

export interface BulkImportJob {
  id: string;
  status: BulkImportStatus;
  fileName: string;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  completeAddressCount: number;
  emailCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BulkImportResultRow {
  id: string;
  rowNumber: number;
  status: "created" | "duplicate" | "failed";
  rowData: Record<string, unknown>;
  constituentId: string | null;
  duplicateOfId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface UploadParams {
  file: File;
  force: boolean;
}

interface UploadResponse {
  data: BulkImportJob;
}

interface JobResponse {
  data: BulkImportJob;
}

interface ListResponse {
  data: BulkImportJob[];
}

interface ResultsResponse {
  data: BulkImportResultRow[];
}

const BASE = "/v1/constituents/bulk-import";

export const bulkImportKeys = {
  all: ["bulk-import"] as const,
  list: () => [...bulkImportKeys.all, "list"] as const,
  job: (id: string) => [...bulkImportKeys.all, "job", id] as const,
  results: (id: string) => [...bulkImportKeys.all, "results", id] as const,
};

export async function downloadTemplate(api: ApiClient = createClientApiClient()): Promise<void> {
  const url = api.resolveBrowserUrl(`${BASE}/template`);
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Template download failed (${response.status})`);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "constituents-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

export function useUploadBulkImport() {
  const queryClient = useQueryClient();
  const api = createClientApiClient();

  return useMutation<BulkImportJob, Error, UploadParams>({
    mutationFn: async ({ file, force }) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await api.post<UploadResponse>(
        `${BASE}${force ? "?force=true" : ""}`,
        formData,
      );
      return response.data;
    },
    onSuccess: (job) => {
      queryClient.setQueryData(bulkImportKeys.job(job.id), { data: job });
      void queryClient.invalidateQueries({ queryKey: bulkImportKeys.list() });
    },
  });
}

export function useBulkImportJob(jobId: string | null) {
  const api = createClientApiClient();
  return useQuery<BulkImportJob>({
    queryKey: jobId ? bulkImportKeys.job(jobId) : ["bulk-import", "job", "none"],
    queryFn: async () => {
      if (!jobId) throw new Error("missing jobId");
      const response = await api.get<JobResponse>(`${BASE}/${jobId}`);
      return response.data;
    },
    enabled: Boolean(jobId),
    refetchInterval: (query) => (isTerminal(query.state.data?.status) ? false : 2000),
    refetchIntervalInBackground: false,
  });
}

export function useBulkImportHistory(enabled = true) {
  const api = createClientApiClient();
  return useQuery<BulkImportJob[]>({
    queryKey: bulkImportKeys.list(),
    queryFn: async () => {
      const response = await api.get<ListResponse>(BASE);
      return response.data;
    },
    enabled,
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (!rows) return false;
      return rows.some((row) => !isTerminal(row.status)) ? 2000 : false;
    },
  });
}

export function useBulkImportResults(jobId: string | null) {
  const api = createClientApiClient();
  return useQuery<BulkImportResultRow[]>({
    queryKey: jobId ? bulkImportKeys.results(jobId) : ["bulk-import", "results", "none"],
    queryFn: async () => {
      if (!jobId) throw new Error("missing jobId");
      const response = await api.get<ResultsResponse>(`${BASE}/${jobId}/results`);
      return response.data;
    },
    enabled: Boolean(jobId),
  });
}

export function downloadOriginalFile(jobId: string, api: ApiClient = createClientApiClient()) {
  const url = api.resolveBrowserUrl(`${BASE}/${jobId}/download`);
  // Same-tab navigation to a signed-redirect / streamed download keeps cookies
  // attached and avoids a popup-blocker fight.
  window.location.assign(url);
}

/**
 * Local QueryClient scope — root layout doesn't wrap the app in a
 * QueryClientProvider yet, so bulk-import components instantiate their
 * own client. Mounted via `BulkImportQueryScope` at the dialog/page root.
 */
export function BulkImportQueryScope({ children }: { children: ReactNode }) {
  const [client] = useState<QueryClient>(
    () =>
      new TanstackQueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 0 },
        },
      }),
  );

  // Cancel in-flight queries on unmount so a closed dialog doesn't keep
  // polling forever.
  useEffect(() => {
    return () => {
      client.cancelQueries();
    };
  }, [client]);

  const memoized = useMemo(() => client, [client]);
  return <QueryClientProvider client={memoized}>{children}</QueryClientProvider>;
}
