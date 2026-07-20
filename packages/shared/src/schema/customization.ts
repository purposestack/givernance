/**
 * Customization engine — schema (Epic #539, docs/35).
 *
 * One registry table per org (`custom_field_definitions`), values in a
 * `custom` JSONB column on each domain table (declared in `index.ts` —
 * never per-tenant DDL), plus two supporting tables: governed quota
 * overrides and the TTL'd merge-undo store.
 *
 * All tenant tables here: RLS ENABLE + FORCE with the standard
 * `org_id = app_current_organization_id()` policy (migrations 0086/0087)
 * AND explicit `eq(orgId, …)` in every query — RLS is the safety net,
 * never the contract (issue #430).
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { CustomFieldOption } from "../custom-fields/types.js";
import { CUSTOM_FIELD_DOMAIN_VALUES, CUSTOM_FIELD_TYPE_VALUES } from "../custom-fields/types.js";
import { tenants, users } from "./index.js";

export const customFieldDomainEnum = pgEnum("custom_field_domain", [...CUSTOM_FIELD_DOMAIN_VALUES]);

export const customFieldTypeEnum = pgEnum("custom_field_type", [...CUSTOM_FIELD_TYPE_VALUES]);

/**
 * Per-org custom-field registry. One row per definition; picklist
 * options are embedded (stable `opt_*` ids — values store ids, never
 * labels, so rename-in-place never rewrites data).
 */
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: customFieldDomainEnum("domain").notNull(),
    /**
     * Immutable machine key (`^[a-z][a-z0-9_]{1,62}$`, DB CHECK in
     * migration 0086). Rejected at creation when in `RESERVED_KEYS`.
     * Renaming a field = changing `label`; the key never changes.
     */
    key: varchar("key", { length: 63 }).notNull(),
    /** Operator-authored tenant data — rendered literally, never an i18n key. */
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    /** Immutable — a type change is archive + recreate. */
    type: customFieldTypeEnum("type").notNull(),
    /** Picklist/multi only; `[]` for scalar types. */
    options: jsonb("options").notNull().default([]).$type<CustomFieldOption[]>(),
    /** Admin ordering — propagates to forms, detail pages, columns, export. */
    sortOrder: integer("sort_order").notNull().default(0),
    /** Enforced on new writes only — never retro-blocking. */
    required: boolean("required").notNull().default(false),
    filterable: boolean("filterable").notNull().default(true),
    /** Export is never plan-gated; this is a per-field visibility toggle. */
    exportable: boolean("exportable").notNull().default(true),
    /**
     * Cross-domain projection opt-in. Constituent domain only, and
     * structurally ineligible when `sensitive` (DB CHECK, migration
     * 0086). Eligibility is recomputed per request — never baked into
     * caches or SSR props.
     */
    showOnRelated: boolean("show_on_related").notNull().default(false),
    /** GDPR Art. 9 marker — excluded from projection and AI context. */
    sensitive: boolean("sensitive").notNull().default(false),
    /** Mandatory (422 + DB CHECK) when `sensitive` — Art. 30 record support. */
    purposeText: varchar("purpose_text", { length: 500 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Soft-archive: hidden from forms/filters/columns, values retained
     * (read-only on detail + exports). The partial unique
     * `(org_id, domain, key) WHERE archived_at IS NULL` lives in
     * migration 0086 — Drizzle doesn't model partial indexes; the
     * migration is the source of truth.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Catalog read path — the partial WHERE lives in the migration. */
    index("custom_field_definitions_org_domain_idx").on(table.orgId, table.domain),
  ],
);

export type CustomFieldDefinitionRow = typeof customFieldDefinitions.$inferSelect;
export type NewCustomFieldDefinitionRow = typeof customFieldDefinitions.$inferInsert;

/**
 * Governed sales-exception path for quota raises (Epic #539 §10):
 * recorded, reasoned, super-admin-only — never a smuggled toggle.
 * Phases 1–2 write path: operator-run owner-role SQL per
 * `docs/runbooks/customization-quota-override.md` (the governed
 * super-admin endpoint is a fast-follow); read by the tenant-side
 * quota check (SELECT-only grant for `givernance_app`).
 */
export const customizationQuotaOverrides = pgTable(
  "customization_quota_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** NULL = applies to every domain; set = domain-scoped raise. */
    domain: customFieldDomainEnum("domain"),
    /** One of `CUSTOM_FIELD_QUOTA_KEYS` (DB CHECK, migration 0087). */
    quotaKey: varchar("quota_key", { length: 63 }).notNull(),
    value: integer("value").notNull(),
    /** Mandatory paper trail — why sales/CSM granted the raise. */
    reason: text("reason").notNull(),
    /** Keycloak sub of the platform admin who set the override. */
    setBy: varchar("set_by", { length: 255 }).notNull(),
    /** NULL = permanent until revoked. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("customization_quota_overrides_org_idx").on(table.orgId)],
);

export type CustomizationQuotaOverrideRow = typeof customizationQuotaOverrides.$inferSelect;
export type NewCustomizationQuotaOverrideRow = typeof customizationQuotaOverrides.$inferInsert;

/**
 * Bounded, TTL'd (30-day) reversal store for option merges: one row per
 * rewritten entity, carrying ONLY the pre-merge value of the touched
 * key. Undo lives here, never as per-row value snapshots in
 * long-retention `audit_logs` (Epic #539 anti-goal #7 — audit rows
 * carry counts + ids only). Purged by the worker cron past `expires_at`.
 */
export const customFieldMergeUndo = pgTable(
  "custom_field_merge_undo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
    /** Groups every row of one merge operation — the undo unit. */
    mergeId: uuid("merge_id").notNull(),
    sourceOptionId: varchar("source_option_id", { length: 20 }).notNull(),
    targetOptionId: varchar("target_option_id", { length: 20 }).notNull(),
    /** PK of the rewritten row in the definition's domain table. */
    entityId: uuid("entity_id").notNull(),
    /**
     * Pre-merge value of the touched key only (e.g. `"opt_abc12345"` or
     * `["opt_a", "opt_b"]`) — never the whole `custom` blob.
     */
    previousValue: jsonb("previous_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** `created_at + CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS` — purge cron key. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("custom_field_merge_undo_org_merge_idx").on(table.orgId, table.mergeId),
    index("custom_field_merge_undo_expiry_idx").on(table.expiresAt),
  ],
);

export type CustomFieldMergeUndoRow = typeof customFieldMergeUndo.$inferSelect;
export type NewCustomFieldMergeUndoRow = typeof customFieldMergeUndo.$inferInsert;
