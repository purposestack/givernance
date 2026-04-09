/** Extractor — read Salesforce CSV exports from S3 */

import type { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { parse } from "csv-parse";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
});

/** List CSV files in an S3 prefix */
export async function listCsvFiles(bucket: string, prefix: string): Promise<string[]> {
  const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));

  return (response.Contents ?? [])
    .map((obj) => obj.Key)
    .filter((key): key is string => key != null && key.endsWith(".csv"));
}

/** Stream and parse a CSV file from S3 */
export async function readCsvFromS3(
  bucket: string,
  key: string,
): Promise<Record<string, string>[]> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  if (!response.Body) {
    throw new Error(`Empty response for s3://${bucket}/${key}`);
  }

  const stream = response.Body as Readable;
  const records: Record<string, string>[] = [];

  const parser = stream.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));

  for await (const record of parser) {
    records.push(record as Record<string, string>);
  }

  return records;
}
