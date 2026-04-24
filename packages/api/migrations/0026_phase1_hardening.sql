-- Migration: 0026_phase1_hardening
-- Follow-up hardening from PR #49 aggregated review (issue #56).
--   • Security: opaque QR codes (tenant-scoped), audit actorId double-attribution,
--     merge_history snapshot (GDPR Art. 5(2)).
--   • Data: cross-tenant FK on donations.campaign_id, UNIQUE(org_id,name) on funds,
--     UNIQUE(org_id,code) on campaign_qr_codes (was globally unique — leaked tenant
--     existence via collision), SEPA mandate fields on pledges, per-installment
--     amount_cents + fund_id, audit timestamps on donation_allocations, pg_trgm on
--     constituents.email.
--   • Observability: outbox_events.metadata for W3C traceparent propagation.

CREATE TABLE "merge_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"merged_by_user_id" varchar(255) NOT NULL,
	"merged_by_actor_id" varchar(255),
	"survivor_before" jsonb NOT NULL,
	"merged_before" jsonb NOT NULL,
	"survivor_after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Migration 0010 created the UNIQUE inline, so Postgres auto-named the
-- constraint `campaign_qr_codes_code_key` rather than the drizzle-style
-- `_unique` suffix. Cover both names so this migration is idempotent across
-- environments that may have already diverged.
ALTER TABLE "campaign_qr_codes" DROP CONSTRAINT IF EXISTS "campaign_qr_codes_code_unique";--> statement-breakpoint
ALTER TABLE "campaign_qr_codes" DROP CONSTRAINT IF EXISTS "campaign_qr_codes_code_key";--> statement-breakpoint
-- QR codes were deterministic concatenations of `${orgId}-${campaignId}-${constituentId}`
-- that overflow the new varchar(32). Rotate existing rows to opaque base64url
-- tokens derived from md5(random()::text) — sufficient for the small volume of
-- Phase 1 pre-customer QR codes; any printed materials stop resolving (documented
-- in issue #56). We avoid `gen_random_bytes` so we don't need to enable pgcrypto
-- just to rewrite a table we'd happily truncate in dev.
UPDATE "campaign_qr_codes"
  SET "code" = substr(replace(encode(md5(random()::text || id::text)::bytea, 'base64'), '/', '_'), 1, 22);
--> statement-breakpoint
ALTER TABLE "campaign_qr_codes" ALTER COLUMN "code" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_id" varchar(255);--> statement-breakpoint
ALTER TABLE "donation_allocations" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "donation_allocations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
-- pledge_installments.amount_cents backfill: legacy rows inherit the pledge's
-- amount so the NOT NULL constraint can be applied in a single migration.
ALTER TABLE "pledge_installments" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
UPDATE "pledge_installments" pi
  SET "amount_cents" = p."amount_cents"
  FROM "pledges" p
  WHERE pi."pledge_id" = p."id" AND pi."amount_cents" IS NULL;
--> statement-breakpoint
ALTER TABLE "pledge_installments" ALTER COLUMN "amount_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pledge_installments" ADD COLUMN "fund_id" uuid;--> statement-breakpoint
ALTER TABLE "pledges" ADD COLUMN "stripe_mandate_id" varchar(255);--> statement-breakpoint
ALTER TABLE "pledges" ADD COLUMN "mandate_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pledges" ADD COLUMN "mandate_ip_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "merge_history" ADD CONSTRAINT "merge_history_org_id_tenants_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merge_history_org_id_idx" ON "merge_history" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "merge_history_survivor_id_idx" ON "merge_history" USING btree ("survivor_id");--> statement-breakpoint
CREATE INDEX "merge_history_merged_id_idx" ON "merge_history" USING btree ("merged_id");--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pledge_installments" ADD CONSTRAINT "pledge_installments_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "donations_campaign_id_idx" ON "donations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "pledge_installments_fund_id_idx" ON "pledge_installments" USING btree ("fund_id");--> statement-breakpoint
ALTER TABLE "campaign_qr_codes" ADD CONSTRAINT "campaign_qr_codes_org_code_uniq" UNIQUE("org_id","code");--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_org_name_uniq" UNIQUE("org_id","name");--> statement-breakpoint

-- ─── pg_trgm GIN index on constituents.email (dedup workflows) ───────────────
-- Extension already enabled in migration 0007; this adds email to the set of
-- fields available for fuzzy-match duplicate detection.
CREATE INDEX IF NOT EXISTS "constituents_email_trgm_idx"
  ON "constituents" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint

-- ─── RLS for merge_history (matches existing tenant isolation pattern) ───────
ALTER TABLE "merge_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merge_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "merge_history"
  USING (org_id = app_current_organization_id())
  WITH CHECK (org_id = app_current_organization_id());