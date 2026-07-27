-- Migration: 0092_receipt_envelope_encryption
--
-- Envelope encryption for tax-receipt PDFs (issue #228).
--
-- All six columns are NULLABLE: `encryption_scheme IS NULL` marks a
-- legacy object (plaintext PDF in the bucket, SSE-S3 at rest only);
-- 'dek-aes256gcm.v1' marks an object that is pure AES-256-GCM
-- ciphertext whose per-receipt DEK is wrapped (`dek_wrapped`) by the
-- KEK version named in `kek_version_id`. IV + auth tag live HERE, not
-- in the S3 object — a leaked bucket alone yields nothing decryptable.
-- `plaintext_length` feeds the download route's Content-Length header.
--
-- The CHECK keeps a half-written row impossible: a non-null scheme
-- requires the full crypto tuple.
--
-- Table-level GRANTs to `givernance_app` cover new columns
-- automatically; RLS policies are row-scoped and unaffected.

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS encryption_scheme text;--> statement-breakpoint
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS dek_wrapped text;--> statement-breakpoint
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS kek_version_id text;--> statement-breakpoint
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS encryption_iv text;--> statement-breakpoint
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS encryption_auth_tag text;--> statement-breakpoint
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS plaintext_length integer;--> statement-breakpoint
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_encryption_fields_check;--> statement-breakpoint
ALTER TABLE receipts ADD CONSTRAINT receipts_encryption_fields_check CHECK (
  encryption_scheme IS NULL
  OR (
    dek_wrapped IS NOT NULL
    AND kek_version_id IS NOT NULL
    AND encryption_iv IS NOT NULL
    AND encryption_auth_tag IS NOT NULL
  )
);--> statement-breakpoint
-- Partial index feeding the KEK-rotation re-wrap sweep
-- (`WHERE encryption_scheme IS NOT NULL AND kek_version_id != $active`).
CREATE INDEX IF NOT EXISTS receipts_kek_version_idx
  ON receipts (kek_version_id)
  WHERE encryption_scheme IS NOT NULL;
