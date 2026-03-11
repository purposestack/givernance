/** BullMQ job type definitions */

/** Generate a tax receipt PDF for a donation */
export interface GenerateReceiptJob {
  name: 'generate-receipt'
  data: {
    donationId: string
    orgId: string
    fiscalYear: number
    locale: string
  }
}

/** Send bulk email to a segment of constituents */
export interface SendBulkEmailJob {
  name: 'send-bulk-email'
  data: {
    orgId: string
    templateId: string
    segmentFilter: Record<string, unknown>
    scheduledAt?: string
  }
}

/** Export data to CSV/XLSX */
export interface ExportDataJob {
  name: 'export-data'
  data: {
    orgId: string
    userId: string
    entityType: 'constituents' | 'donations' | 'campaigns'
    format: 'csv' | 'xlsx'
    filters: Record<string, unknown>
  }
}

/** GDPR erasure — anonymize or delete constituent data */
export interface GdprErasureJob {
  name: 'gdpr-erasure'
  data: {
    orgId: string
    constituentId: string
    requestedBy: string
    requestedAt: string
  }
}

/** Union of all job types */
export type JobDefinition =
  | GenerateReceiptJob
  | SendBulkEmailJob
  | ExportDataJob
  | GdprErasureJob

/** Queue names */
export const QUEUE_NAMES = {
  RECEIPTS: 'receipts',
  EMAILS: 'emails',
  EXPORTS: 'exports',
  GDPR: 'gdpr',
} as const
