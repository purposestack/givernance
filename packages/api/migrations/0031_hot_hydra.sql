CREATE TABLE "tenant_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"claimer_email" varchar(255) NOT NULL,
	"claimer_first_name" varchar(255),
	"claimer_last_name" varchar(255),
	"reason" varchar(2000),
	"state" varchar(32) DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_disputes" ADD CONSTRAINT "tenant_disputes_org_id_tenants_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_disputes" ADD CONSTRAINT "tenant_disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_disputes_org_id_idx" ON "tenant_disputes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tenant_disputes_state_idx" ON "tenant_disputes" USING btree ("state");