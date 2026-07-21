/**
 * Donation filter WHERE-clause builder.
 *
 * Thin orchestration over the constituents `FilterQueryBuilder`: logical
 * composition (AND/OR, nested groups) and the donation-specific virtual
 * lanes live here; every plain-column leaf condition is delegated to the
 * generic builder as a single-condition query, so the shared operator
 * switch, `normalizeValue` (EUR→cents ×100, end-of-day date bounds),
 * ILIKE escaping, and snake→Drizzle column resolution are reused verbatim
 * — the constituents engine itself is untouched.
 *
 * Tenant scoping (issue #430): every EXISTS subquery carries an explicit
 * `org_id = :orgId` predicate beside the correlation, in addition to RLS.
 * The `donorName` lane references the LEFT-JOINed `constituents` table —
 * every query embedding a clause from this builder MUST join constituents
 * with `eq(constituents.orgId, orgId)` in the join clause (as
 * `listDonations` already does).
 */

import {
  constituents,
  donationAllocations,
  donations,
  pledgeInstallments,
  receipts,
} from "@givernance/shared/schema";
import { and, or, type SQL, sql } from "drizzle-orm";
import { FilterQueryBuilder } from "../../constituents/filters/query-builder.js";
import type {
  FilterCondition,
  FilterOperator,
  FilterQuery,
} from "../../constituents/filters/types.js";
import type { DonationFieldMetadata, DonationVirtualLane } from "./field-registry.js";
import { DONATION_FIELD_REGISTRY } from "./field-registry.js";

/** Escape ILIKE wildcards — same treatment as the shared builder. */
function escapeLike(value: unknown): string {
  return String(value).replace(/[\\_%]/g, "\\$&");
}

export class DonationFilterQueryBuilder {
  private orgId: string;
  private registry: Record<string, DonationFieldMetadata>;
  /** Generic column-lane delegate (shared operator + normalization code). */
  private inner: FilterQueryBuilder;

  constructor(
    orgId: string,
    registry: Record<string, DonationFieldMetadata> = DONATION_FIELD_REGISTRY,
  ) {
    this.orgId = orgId;
    this.registry = registry;
    // `donations.custom` routes the shared custom-JSONB lanes (guarded
    // casts, GIN containment, presence checks — Epic #539) at the
    // donation-domain blob; plain-column delegation is unchanged.
    this.inner = new FilterQueryBuilder(orgId, registry, donations.custom);
  }

  /** Build the WHERE clause for a validated donation FilterQuery. */
  buildWhereClause(query: FilterQuery): SQL | undefined {
    const conditionsArray = Array.isArray(query.conditions) ? query.conditions : [];
    const parts = conditionsArray
      .map((condition) => this.buildCondition(condition))
      .filter((c): c is SQL => c !== undefined);

    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    return query.operator === "OR" ? or(...parts) : and(...parts);
  }

  private buildCondition(condition: FilterCondition): SQL | undefined {
    // Nested groups recurse HERE so virtual lanes inside a group still
    // resolve through this builder (the inner builder knows nothing of
    // them). Donation queries have no patterns — validation rejects them.
    if (condition.subConditions) {
      return this.buildWhereClause(condition.subConditions);
    }

    const meta = this.registry[condition.field];
    if (!meta) return undefined; // validateQuery already 400s unknown fields

    if (meta.virtual) {
      return this.buildVirtualCondition(meta.virtual, condition.operator, condition.value);
    }

    // Plain-column AND custom-JSONB lanes: delegate the single condition to
    // the shared builder (operator switch + normalizeValue + escaping, plus
    // the Epic #539 guarded-cast / containment custom lanes compiled
    // against `donations.custom` — see the constructor).
    return this.inner.buildWhereClause({ operator: "AND", conditions: [condition] });
  }

  private buildVirtualCondition(
    lane: DonationVirtualLane,
    operator: FilterOperator,
    value: unknown,
  ): SQL | undefined {
    switch (lane) {
      case "fund":
        return this.buildFundCondition(operator, value);
      case "receiptStatus":
        return this.buildReceiptStatusCondition(operator, value);
      case "pledgeInstallment":
        return this.buildPledgeInstallmentCondition(operator, value);
      case "donorName":
        return this.buildDonorNameCondition(operator, value);
      default:
        return undefined;
    }
  }

  /**
   * Fund attribution via `donation_allocations` EXISTS (1:N — a join
   * would multiply donation rows). `in` ≡ "allocated to any of";
   * isNull ≡ "unallocated". Values are uuid-validated upstream and bound
   * as parameters here.
   */
  private buildFundCondition(operator: FilterOperator, value: unknown): SQL | undefined {
    const allocationExists = (fundPredicate?: SQL) => sql`
      EXISTS (
        SELECT 1 FROM ${donationAllocations} da
        WHERE da.donation_id = ${donations.id}
          AND da.org_id = ${this.orgId}
          ${fundPredicate ?? sql``}
      )
    `;

    if (operator === "isNull") return sql`NOT ${allocationExists()}`;
    if (operator === "isNotNull") return allocationExists();

    const ids = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === "string" && v !== "",
    );
    if (ids.length === 0) return undefined;
    if (operator === "eq" || operator === "in") {
      const list = sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
      return allocationExists(sql`AND da.fund_id IN (${list})`);
    }
    return undefined;
  }

  /**
   * Receipt state via `receipts` EXISTS. eq ≡ "has a receipt with this
   * status" (same semantics as the legacy `receiptStatus` list param);
   * isNull ≡ "no receipt at all" — the unreceipted filter.
   */
  private buildReceiptStatusCondition(operator: FilterOperator, value: unknown): SQL | undefined {
    const receiptExists = (statusPredicate?: SQL) => sql`
      EXISTS (
        SELECT 1 FROM ${receipts} r
        WHERE r.donation_id = ${donations.id}
          AND r.org_id = ${this.orgId}
          ${statusPredicate ?? sql``}
      )
    `;

    if (operator === "isNull") return sql`NOT ${receiptExists()}`;
    if (operator === "isNotNull") return receiptExists();
    if (operator === "eq" && typeof value === "string" && value !== "") {
      // Value is enum-validated upstream; cast the BOUND PARAM, never text.
      return receiptExists(sql`AND r.status = ${value}::receipt_status`);
    }
    return undefined;
  }

  /** `eq true` ≡ settles a pledge installment; `eq false` ≡ one-off gift. */
  private buildPledgeInstallmentCondition(
    operator: FilterOperator,
    value: unknown,
  ): SQL | undefined {
    if (operator !== "eq" || typeof value !== "boolean") return undefined;
    const installmentExists = sql`
      EXISTS (
        SELECT 1 FROM ${pledgeInstallments} pi
        WHERE pi.donation_id = ${donations.id}
          AND pi.org_id = ${this.orgId}
      )
    `;
    return value ? installmentExists : sql`NOT ${installmentExists}`;
  }

  /**
   * Virtual donor-name expression over the LEFT-JOINed constituents row
   * (`first_name || ' ' || last_name` — mirrors the list's search
   * subquery UX and the "First Last" display cell). A donation whose
   * donor row is missing/soft-join-failed yields SQL NULL → never
   * matches. `eq` is deliberately case-insensitive (exact-but-forgiving
   * name match); contains/startsWith use the shared escaping rules.
   */
  private buildDonorNameCondition(operator: FilterOperator, value: unknown): SQL | undefined {
    if (typeof value !== "string" || value === "") return undefined;
    const expr = sql`(${constituents.firstName} || ' ' || ${constituents.lastName})`;
    switch (operator) {
      case "eq":
        return sql`${expr} ILIKE ${escapeLike(value)}`;
      case "contains":
        return sql`${expr} ILIKE ${`%${escapeLike(value)}%`}`;
      case "startsWith":
        return sql`${expr} ILIKE ${`${escapeLike(value)}%`}`;
      default:
        return undefined;
    }
  }
}
