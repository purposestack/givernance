/**
 * Donation advanced-filter service (flag `donations.advanced_filters`).
 *
 * Reuses the constituents engine's generic validation (complexity caps,
 * operator-per-field checks, numeric-value checks, SQL-injection
 * heuristics + hashed logging) by delegating to a `FilterService`
 * constructed with the DONATION registry — that method is registry-driven
 * and touches no constituent tables. On top of it, donation-specific
 * pre-flight checks reject what the generic layer cannot know about:
 *   - patterns (constituent-grain concept — none exist for donations);
 *   - out-of-set values on Postgres-enum fields (would 22P02 → 500);
 *   - non-uuid values on campaign/fund id fields (same failure mode).
 *
 * Execution (preview + the `?filters=` lane in `listDonations`) always
 * carries the explicit `eq(donations.orgId, orgId)` beside RLS (issue
 * #430), and LEFT JOINs constituents with the org predicate IN THE JOIN
 * CLAUSE so the `donor.*` fields resolve safely.
 */

import { CUSTOM_FIELD_KEY_PATTERN } from "@givernance/shared/custom-fields";
import { campaigns, constituents, donations, funds } from "@givernance/shared/schema";
import { and, asc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { withTenantContext } from "../../../lib/db.js";
import { FilterService } from "../../constituents/filters/filter.service.js";
import type {
  FieldMetadata,
  FilterCondition,
  FilterQuery,
} from "../../constituents/filters/types.js";
import type { DonationFieldMetadata, DonationFieldRegistryBundle } from "./field-registry.js";
import { DONATION_FIELD_REGISTRY } from "./field-registry.js";
import { DonationFilterQueryBuilder } from "./query-builder.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Operators that take exactly ONE scalar value. Only `between` (tuple of 2)
 * and `in` (set) legitimately carry arrays — an array anywhere else either
 * throws at SQL execution (`status = $1` with an array param on an enum
 * column → 500) or makes a virtual lane's builder return undefined and
 * silently drop the condition.
 */
const SCALAR_OPERATORS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
]);

/**
 * Donation-specific value-shape gates for one leaf condition. The generic
 * layer doesn't know about them: an out-of-set enum / non-uuid value would
 * 22P02 → 500 at the enum/uuid cast, and a wrong-typed value on a virtual
 * lane would make the builder return undefined and SILENTLY drop the
 * condition (an operator would see unfiltered data believed filtered).
 */
function validateConditionValueShape(
  meta: DonationFieldMetadata,
  condition: FilterCondition,
): string | null {
  // Array where a single value belongs: reject before the shapes below can
  // half-accept it (an enum check iterating array MEMBERS would pass
  // `eq ["cleared"]` and let it 500 / silently drop downstream).
  if (SCALAR_OPERATORS.has(condition.operator) && Array.isArray(condition.value)) {
    return `Operator '${condition.operator}' on field '${condition.field}' requires a single value, not an array`;
  }
  // `in []` is a meaningless shape: the fund EXISTS lane would compile it to
  // undefined (condition silently dropped → unfiltered list believed
  // filtered) while plain columns compile it to FALSE (matches nothing) —
  // reject instead of picking either failure direction.
  if (
    condition.operator === "in" &&
    Array.isArray(condition.value) &&
    condition.value.length === 0
  ) {
    return `Operator 'in' on field '${condition.field}' requires a non-empty array`;
  }
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  if (meta.enumOptions) {
    const allowed = new Set<unknown>(meta.enumOptions);
    if (!values.every((v) => allowed.has(v))) {
      return `Field '${condition.field}' only accepts: ${meta.enumOptions.join(", ")}`;
    }
  }
  if (
    meta.valueFormat === "uuid" &&
    !values.every((v) => typeof v === "string" && UUID_RE.test(v))
  ) {
    return `Field '${condition.field}' requires UUID values`;
  }
  if (meta.type === "boolean" && typeof condition.value !== "boolean") {
    return `Field '${condition.field}' requires a boolean value`;
  }
  // Empty string would make the donor-name lane return undefined → silent
  // drop; require actual text (matches the FE builder, which never applies
  // an empty input).
  if (
    meta.virtual === "donorName" &&
    (typeof condition.value !== "string" || condition.value === "")
  ) {
    return `Field '${condition.field}' requires a non-empty text value`;
  }
  return null;
}

/** Fields the suggestions endpoint serves (org-scoped DISTINCT reads). */
const SUGGESTIBLE_FIELDS = new Set(["donation.paymentMethod", "donation.currency"]);

export interface DonationFilterValidation {
  valid: boolean;
  errors: string[];
  /**
   * `custom.<key>` conditions referencing ARCHIVED donation-domain
   * definitions (Epic #539) — routes surface these as the named
   * `custom_field_archived` 400, same contract as the constituents engine.
   */
  archivedFields: string[];
}

export class DonationFilterService {
  private orgId: string;
  private registry: Record<string, DonationFieldMetadata>;
  private queryBuilder: DonationFilterQueryBuilder;
  /** Generic validation delegate (constituents engine, donation registry). */
  private genericValidator: FilterService;

  constructor(orgId: string, logger?: FastifyBaseLogger, bundle?: DonationFieldRegistryBundle) {
    this.orgId = orgId;
    this.registry = bundle?.registry ?? DONATION_FIELD_REGISTRY;
    this.queryBuilder = new DonationFilterQueryBuilder(orgId, this.registry);
    this.genericValidator = new FilterService(orgId, logger, {
      // The donation registry satisfies the constituents FieldMetadata
      // shape (it extends it) — the generic validator only reads the
      // shared keys (type/operators/…).
      registry: this.registry as Record<string, FieldMetadata>,
      archivedDslNames: bundle?.archivedDslNames ?? new Set(),
    });
  }

  /**
   * Validate a donation filter query. Generic checks first (complexity,
   * operators, values, injection heuristics), then the donation-specific
   * value-shape gates.
   */
  validateQuery(query: FilterQuery): DonationFilterValidation {
    const base = this.genericValidator.validateQuery(query);
    const errors = [...base.errors];

    // No patterns on the donation grain — anywhere in the tree.
    this.collectPatternErrors(query, errors);

    // Enum-membership + uuid-shape gates (prevent 22P02 → 500).
    const conditionsArray = Array.isArray(query.conditions) ? query.conditions : [];
    this.collectValueShapeErrors(conditionsArray, errors);

    // Archived donation-domain custom fields (Epic #539): the generic
    // layer already walked the tree against the bundle's archivedDslNames.
    return { valid: errors.length === 0, errors, archivedFields: base.archivedFields };
  }

  private collectPatternErrors(query: FilterQuery, errors: string[]): void {
    if (Array.isArray(query.patterns) && query.patterns.length > 0) {
      errors.push("Patterns are not supported on donation filters");
    }
    const conditionsArray = Array.isArray(query.conditions) ? query.conditions : [];
    for (const condition of conditionsArray) {
      if (condition.subConditions) this.collectPatternErrors(condition.subConditions, errors);
    }
  }

  private collectValueShapeErrors(conditions: FilterCondition[], errors: string[]): void {
    for (const condition of conditions) {
      if (condition.subConditions) {
        const nested = condition.subConditions.conditions;
        this.collectValueShapeErrors(Array.isArray(nested) ? nested : [], errors);
        continue;
      }
      const meta = this.registry[condition.field];
      // Unknown fields (at ANY depth) are already a 400 from the generic
      // layer — its per-condition validation recurses into subConditions.
      if (!meta) continue;
      if (condition.operator === "isNull" || condition.operator === "isNotNull") continue;
      const error = validateConditionValueShape(meta, condition);
      if (error) errors.push(error);
    }
  }

  /**
   * Compile a VALIDATED query to its WHERE clause. Public: the
   * `?filters=` lane in `listDonations` ANDs this into its own predicate
   * set. Callers referencing `donor.*` fields MUST have the constituents
   * LEFT JOIN in place (with the org predicate in the join clause).
   */
  buildWhereClause(query: FilterQuery): SQL | undefined {
    return this.queryBuilder.buildWhereClause(query);
  }

  /** Count-only preview for the FilterBuilder. */
  async previewFilter(query: FilterQuery): Promise<{ count: number; estimatedTime?: number }> {
    const startTime = Date.now();
    const whereClause = this.buildWhereClause(query);

    return withTenantContext(this.orgId, async (db) => {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(donations)
        // 1:1 by PK — never multiplies rows; org predicate in the join
        // clause (issue #430) so donor.* fields never match cross-tenant.
        .leftJoin(
          constituents,
          and(eq(donations.constituentId, constituents.id), eq(constituents.orgId, this.orgId)),
        )
        .where(and(eq(donations.orgId, this.orgId), whereClause))
        .execute();

      return {
        count: Number(countResult[0]?.count || 0),
        estimatedTime: Date.now() - startTime,
      };
    });
  }

  /**
   * Autocomplete suggestions — free-text payment methods, currencies, and
   * custom TEXT fields (donation-domain, Epic #539). Custom picklists
   * answer from their catalog `options` client-side ([] here); every other
   * custom type has no meaningful suggestion set; SENSITIVE (Art. 9)
   * custom fields never suggest — `SELECT DISTINCT` over their stored
   * values would let any authenticated user enumerate the full value set
   * without record-level access (docs/35 §6, same fence as constituents).
   */
  async getFieldSuggestions(field: string, search?: string, limit = 10): Promise<string[]> {
    const customMeta = this.registry[field];
    if (customMeta?.source === "custom") {
      if (customMeta.customType !== "text" || customMeta.sensitive) return [];
      return this.getCustomFieldSuggestions(customMeta, search, limit);
    }

    if (!SUGGESTIBLE_FIELDS.has(field)) return [];
    const column =
      field === "donation.paymentMethod" ? donations.paymentMethod : donations.currency;

    return withTenantContext(this.orgId, async (db) => {
      const rows = await db
        .selectDistinct({ value: column })
        .from(donations)
        .where(
          and(
            eq(donations.orgId, this.orgId),
            isNotNull(column),
            search
              ? sql`${column} ILIKE ${`%${String(search).replace(/[\\_%]/g, "\\$&")}%`}`
              : undefined,
          ),
        )
        .orderBy(asc(column))
        .limit(limit)
        .execute();
      return rows.map((r) => r.value).filter((v): v is string => v !== null && v !== "");
    });
  }

  /**
   * `SELECT DISTINCT custom->>'<key>'` for one donation-domain custom TEXT
   * field. The key is registry-resolved and regex-checked, never client
   * input; `eq(org_id)` stays explicit beside RLS (issue #430). Donations
   * have no soft-delete column, so no `deleted_at` predicate to mirror.
   */
  private async getCustomFieldSuggestions(
    meta: DonationFieldMetadata,
    search: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const key = meta.jsonKey;
    if (!key || meta.sensitive || !CUSTOM_FIELD_KEY_PATTERN.test(key)) return [];

    return withTenantContext(this.orgId, async (db) => {
      const result = await db.execute(sql`
        SELECT DISTINCT ${donations.custom} ->> ${key} AS value
        FROM ${donations}
        WHERE org_id = ${this.orgId}
          AND jsonb_exists(custom, ${key})
          ${search ? sql`AND ${donations.custom} ->> ${key} ILIKE ${`%${String(search).replace(/[\\_%]/g, "\\$&")}%`}` : sql``}
        ORDER BY value
        LIMIT ${limit}
      `);
      return result.rows
        .map((row) => row.value as string | null)
        .filter((v): v is string => v !== null && v !== "");
    });
  }

  /**
   * Per-org id+name option lists for the `/filter/fields` catalog
   * (campaign + fund pickers). Capped and name-ordered; explicit
   * `eq(orgId)` beside RLS (issue #430).
   */
  async getEntityOptions(): Promise<{
    campaigns: Array<{ id: string; label: string; active: boolean }>;
    funds: Array<{ id: string; label: string; active: boolean }>;
  }> {
    return withTenantContext(this.orgId, async (db) => {
      const [campaignRows, fundRows] = await Promise.all([
        db
          .select({ id: campaigns.id, label: campaigns.name })
          .from(campaigns)
          .where(eq(campaigns.orgId, this.orgId))
          .orderBy(asc(campaigns.name))
          .limit(200),
        db
          .select({ id: funds.id, label: funds.name })
          .from(funds)
          .where(eq(funds.orgId, this.orgId))
          .orderBy(asc(funds.name))
          .limit(200),
      ]);
      return {
        campaigns: campaignRows.map((row) => ({ ...row, active: true })),
        funds: fundRows.map((row) => ({ ...row, active: true })),
      };
    });
  }
}
