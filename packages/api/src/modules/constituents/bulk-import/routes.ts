import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createBulkImportJob, getBulkImportJob, listBulkImportJobs, getBulkImportResults, getTemplateCsv } from './service';
import { getBulkImportObject } from '../../../lib/s3';
import { Readable } from 'stream';
import { BadRequestError } from '../../../errors';

export async function registerBulkImportRoutes(app: FastifyInstance) {
  
  // POST /v1/constituents/bulk-import
  app.post('/v1/constituents/bulk-import', async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await req.file(); // multipart
    if (!data) throw new BadRequestError('No file uploaded');

    const fileBuffer = await data.toBuffer();
    const filename = data.filename;
    const mimeType = data.mimetype;

    const { jobId, fileId } = await createBulkImportJob(
      req.orgId, // Assuming orgId is set by middleware
      req.userId, // Assuming userId is set by middleware
      fileBuffer,
      filename,
      mimeType
    );

    reply.code(202).send({ data: { jobId, status: 'pending', fileId } });
  });

  // GET /v1/constituents/bulk-import/:id
  app.get('/v1/constituents/bulk-import/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const job = await getBulkImportJob(req.params.id, req.orgId);
    if (!job) throw new BadRequestError('Job not found');
    reply.send({ data: job });
  });

  // GET /v1/constituents/bulk-import
  app.get('/v1/constituents/bulk-import', async (req: FastifyRequest<{ Querystring: { page?: string; perPage?: string } }>, reply: FastifyReply) => {
    const page = parseInt(req.query.page || '1');
    const perPage = parseInt(req.query.perPage || '20');
    const jobs = await listBulkImportJobs(req.orgId, page, perPage);
    reply.send({ data: jobs, pagination: { page, perPage, total: jobs.length } }); // Simplified
  });

  // GET /v1/constituents/bulk-import/:id/results
  app.get('/v1/constituents/bulk-import/:id/results', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const results = await getBulkImportResults(req.params.id, req.orgId);
    reply.send({ data: results });
  });

  // GET /v1/constituents/bulk-import/:id/download
  app.get('/v1/constituents/bulk-import/:id/download', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    // Fetch file metadata from DB first to get filename
    const { body, contentLength } = await getBulkImportObject(`{req.orgId}/bulk-imports/{req.params.id}/template.csv`); // Simplified key
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', 'attachment; filename="import.csv"');
    if (contentLength) reply.header('Content-Length', contentLength);
    return reply.send(body);
  });

  // GET /v1/constituents/bulk-import/template
  app.get('/v1/constituents/bulk-import/template', async (req: FastifyRequest, reply: FastifyReply) => {
    const { csv, filename } = await getTemplateCsv();
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);
  });
}
