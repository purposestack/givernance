/**
 * Per-domain feature-flag wiring for the customization engine
 * (Epic #539). Every custom-field surface is gated by the flag of the
 * domain it touches; the catalog routes are reachable when ANY of the
 * three domain flags is on, with results filtered to the enabled
 * domains. Domain modules (constituents / donations / campaigns) import
 * `isCustomFieldDomainEnabled` for their value read/write paths.
 */

import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from "@givernance/shared/constants";
import type { CustomFieldDomain } from "@givernance/shared/custom-fields";
import { CUSTOM_FIELD_DOMAIN_VALUES } from "@givernance/shared/custom-fields";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  flagService as defaultFlagService,
  type FlagService,
} from "../../../lib/flags/flag-service.js";
import { problemDetail } from "../../../lib/schemas.js";

/** Domain → kill-switch flag key. */
export const CUSTOM_FIELD_DOMAIN_FLAGS: Record<CustomFieldDomain, FeatureFlagKey> = {
  constituent: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
  donation: FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
  campaign: FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
};

function resolveFlagService(request: FastifyRequest): FlagService {
  return request.flagService ?? defaultFlagService;
}

/** Evaluates one domain's kill-switch for the requesting tenant. */
export async function isCustomFieldDomainEnabled(
  request: FastifyRequest,
  domain: CustomFieldDomain,
): Promise<boolean> {
  return resolveFlagService(request).isEnabled(CUSTOM_FIELD_DOMAIN_FLAGS[domain], {
    orgId: request.auth?.orgId ?? null,
  });
}

/** The subset of domains whose kill-switch is on for this tenant. */
export async function getEnabledCustomFieldDomains(
  request: FastifyRequest,
): Promise<Set<CustomFieldDomain>> {
  const enabled = new Set<CustomFieldDomain>();
  for (const domain of CUSTOM_FIELD_DOMAIN_VALUES) {
    if (await isCustomFieldDomainEnabled(request, domain)) {
      enabled.add(domain);
    }
  }
  return enabled;
}

/**
 * preHandler mirroring `requireFlag` semantics over the three domain
 * flags: 404 (never 403) unless at least one is enabled. Always FIRST
 * in the chain, before any role guard, so scanners can't enumerate
 * role requirements of a dark feature.
 */
export async function requireAnyCustomFieldsFlag(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  for (const domain of CUSTOM_FIELD_DOMAIN_VALUES) {
    if (await isCustomFieldDomainEnabled(request, domain)) {
      return;
    }
  }
  request.log.info(
    {
      event: "flag.route_gated",
      flagKey: Object.values(CUSTOM_FIELD_DOMAIN_FLAGS).join(","),
      path: request.routeOptions.url ?? request.url,
      method: request.method,
    },
    "Route gated off — feature flag disabled",
  );
  return reply.status(404).send(problemDetail(404, "Not Found", "Route not found"));
}
