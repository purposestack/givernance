// Mobilisation Score — per-tenant aggregator (Epic #434, issue #438).
//
// Thin shim (issue #443): the implementation now lives in the shared
// `@givernance/shared/finance/reporting` module so the API and the
// worker share one copy. The two functions are dependency-injected
// with a `db` handle in shared; here we pre-bind the API's `systemDb`
// (owner pool — the platform aggregate is cross-tenant by design) so
// every existing call site keeps its current signature.

import {
  type ComputePerTenantOptions,
  type MobilisationPeriod,
  type MobilisationPlatformAggregate,
  computeMobilisationPlatformAggregate as sharedAggregate,
  computeMobilisationPerTenant as sharedPerTenant,
  type TenantMobilisationRow,
} from "@givernance/shared/finance/reporting";
import { systemDb } from "../../../lib/db.js";

export function computeMobilisationPerTenant(
  period: MobilisationPeriod,
  opts: ComputePerTenantOptions = {},
): Promise<TenantMobilisationRow[]> {
  return sharedPerTenant(systemDb, period, opts);
}

export function computeMobilisationPlatformAggregate(
  period: MobilisationPeriod,
): Promise<MobilisationPlatformAggregate> {
  return sharedAggregate(systemDb, period);
}

export type {
  ComputePerTenantOptions,
  MobilisationPeriod,
  MobilisationPlatformAggregate,
  TenantMobilisationRow,
} from "@givernance/shared/finance/reporting";
