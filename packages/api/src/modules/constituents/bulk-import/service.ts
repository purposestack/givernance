import { FastifyInstance } from 'fastify';
import { bulk_import_jobs, bulk_import_files, bulk_import_results, NewBulkImportJob, NewBulkImportFile } from '../../../db/types';
import { db } from '../../../db';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { putBulkImportObject, getBulkImportObject } from '../../../lib/s3';
import { parseFile, ParsedRow } from './parser';
import { validateRows, ValidationError } from './validation';

// ─── Service Functions ─────────────────────────────────────────────────

export async function createBulkImportJob(
  orgId: string,
  userId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ jobId: string; fileId: string }> {
  
  // 1. Upload to S3
  const fileId = nanoid();
  const s3Key = `${orgId}/bulk-imports/${fileId}/${filename}`;
  
  await putBulkImportObject(s3Key, fileBuffer, mimeType);

  // 2. Insert file record
  const [fileRecord] = await db.insert(bulk_import_files).values({
    id: fileId,
    orgId,
    s3Key,
    s3Bucket: 'givernance-bulk-imports', // TODO: get from env
    fileName: filename,
    fileSize: fileBuffer.length,
    mimeType: mimeType,
  } as NewBulkImportFile).returning();

  // 3. Parse file to get total rows
  const rows = await parseFile(fileBuffer, filename, mimeType);
  
  // 4. Insert job record
  const jobId = nanoid();
  await db.insert(bulk_import_jobs).values({
    id: jobId,
    orgId,
    status: 'pending',
    totalRows: rows.length,
    fileId: fileRecord.id,
    requestedBy: userId,
  } as NewBulkImportJob);

  // 5. Start processing (simulate or queue)
  // In a real impl, we would add to BullMQ here
  processImport(jobId, orgId, rows).catch(console.error);

  return { jobId, fileId: fileRecord.id };
}

async function processImport(jobId: string, orgId: string, rows: ParsedRow[]) {
  // Update status to processing
  await db.update(bulk_import_jobs).set({ status: 'processing' }).where(eq(bulk_import_jobs.id, jobId));

  const { valid, errors } = validateRows(rows);
  let createdCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  let completeAddressCount = 0;
  let emailCount = 0;

  for (const row of valid) {
    try {
      // Check for duplicates (simplified)
      // Insert logic here...
      
      // Example metrics update
      if (row.data.email) emailCount++;
      if (row.data.addressLine1 && row.data.postalCode && row.data.city && row.data.countryCode) {
        completeAddressCount++;
      }

      createdCount++;
    } catch (err) {
      failedCount++;
      await db.insert(bulk_import_results).values({
        orgId,
        jobId,
        rowNumber: row.rowNumber,
        rowData: row.data,
        status: 'failed',
        errorCode: 'DATABASE_ERROR',
        errorMessage: String(err),
      });
    }
  }

  // Update job as completed
  await db.update(bulk_import_jobs).set({
    status: failedCount > 0 ? 'partial' : 'completed',
    processedRows: rows.length,
    createdCount,
    duplicateCount,
    failedCount,
    completeAddressCount, // Note: adding this field to the table schema is required
    emailCount, // Note: adding this field to the table schema is required
    completedAt: new Date(),
  }).where(eq(bulk_import_jobs.id, jobId));
}

export async function getBulkImportJob(jobId: string, orgId: string) {
  const [job] = await db.select().from(bulk_import_jobs)
    .where(and(eq(bulk_import_jobs.id, jobId), eq(bulk_import_jobs.orgId, orgId)));
  return job;
}

export async function listBulkImportJobs(orgId: string, page = 1, perPage = 20) {
  const offset = (page - 1) * perPage;
  const jobs = await db.select().from(bulk_import_jobs)
    .where(eq(bulk_import_jobs.orgId, orgId))
    .orderBy(desc(bulk_import_jobs.createdAt))
    .limit(perPage)
    .offset(offset);
  
  return jobs;
}

export async function getBulkImportResults(jobId: string, orgId: string) {
  const results = await db.select().from(bulk_import_results)
    .where(and(eq(bulk_import_results.jobId, jobId), eq(bulk_import_results.orgId, orgId)));
  return results;
}

export async function getTemplateCsv(): Promise<{ csv: string; filename: string }> {
  const header = 'firstName,lastName,email,phone,addressLine1,addressLine2,postalCode,city,countryCode,type,tags';
  const examples = [
    'John,Doe,john@example.com,+33123456789,123 Main St,Apt 4,75001,Paris,FR,donor,"volunteer,newsletter"',
    'Jane,Smith,jane@example.com,,,456 Oak Ave,,75002,Paris,FR,volunteer,',
    'Alice,Johnson,a.johnson@example.com,+33612345678,10 Rue de la Paix,,1204,Geneva,CH,donor,',
    'Bob,Builder,bob@example.com,,789 High St,,1000,Brussels,BE,member,',
    'Charlie,Day,charlie@example.com,+3221234567,5 Grand Place,,1000,Brussels,BE,partner,"donor,volunteer"',
    'Diana,Prince,diana@example.com,,,50 Rue de la Loi,,1000,Brussels,BE,beneficiary,',
    'Eve,Adams,eve@example.com,+4123456789,1 Bahnhofstrasse,,8001,Zurich,CH,donor,',
    'Frank,Wright,frank@example.com,,,20 Oxford St,,SW1A 1AA,London,GB,volunteer,',
    'Grace,Lee,grace@example.com,+821012345678,88 Gangnam-daero,,06059,Seoul,KR,donor,',
    'Hank,Williams,hank@example.com,,,456 Music Row,,37203,Nashville,US,artist,'
  ];
  
  const csvContent = [header, ...examples].join('\n');
  return { csv: csvContent, filename: 'givernance-import-template.csv' };
}
