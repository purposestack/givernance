/**
 * Donations advanced-filter catalog (flag `donations.advanced_filters`).
 *
 * The UI components are the shared builder stack from
 * `@/components/constituents/filters` (FilterBuilder / FilterCondition /
 * FilterChip / FilterPreview are catalog-driven and namespace/endpoint
 * parameterised) — this module only supplies the donation-domain data:
 * static field catalog, server-catalog fetch/merge, and the endpoints /
 * namespace constants the shared components are pointed at.
 *
 * @module donations/filters
 */

export {
  DONATION_FILTER_ENDPOINTS,
  DONATION_FILTERS_NAMESPACE,
  fetchDonationFilterFields,
  mapDonationCatalogField,
  mergeDonationFilterCatalog,
  type RawDonationCatalogField,
} from "./donation-filter-catalog";
export { donationFilterFields } from "./donation-filter-fields";
export { useDonationFilterCatalog } from "./use-donation-filter-catalog";
