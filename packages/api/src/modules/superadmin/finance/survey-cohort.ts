// #437 — shared cohort resolver for the survey launch route.
//
// Mirrors the worker's `resolveCohort` (packages/worker/src/processors/
// finance-survey-send.ts) but reads through `systemDb` because the API
// layer doesn't have BullMQ's `db` (which is the owner pool there).
// Cohort resolution is CROSS-TENANT by design — a PMF/NPS sweep spans
// every tenant matching the rule. The downstream INSERTs into
// `survey_invitations` still carry an explicit `eq(orgId, …)` per
// CLAUDE.md.

import { tenants, users } from "@givernance/shared/schema";
import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { systemDb } from "../../../lib/db.js";

export interface CohortRule {
  roles?: ("org_admin" | "user" | "viewer")[];
  orgIds?: string[];
  excludeUserIds?: string[];
}

export interface CohortMember {
  userId: string;
  orgId: string;
  email: string;
}

export async function resolveCohort(rule: CohortRule): Promise<CohortMember[]> {
  const predicates = [isNull(users.deletedAt)];

  if (rule.roles && rule.roles.length > 0) {
    predicates.push(inArray(users.role, rule.roles));
  }
  if (rule.orgIds && rule.orgIds.length > 0) {
    predicates.push(inArray(users.orgId, rule.orgIds));
  } else {
    predicates.push(sql`${tenants.status} NOT IN ('archived', 'suspended')`);
  }
  if (rule.excludeUserIds && rule.excludeUserIds.length > 0) {
    predicates.push(not(inArray(users.id, rule.excludeUserIds)));
  }

  return systemDb
    .select({ userId: users.id, orgId: users.orgId, email: users.email })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.orgId))
    .where(and(...predicates));
}
