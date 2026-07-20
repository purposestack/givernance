import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Plus, Users } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { BulkImportTrigger } from "@/components/constituents/bulk-import-trigger";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import type {
  ConstituentListResponse,
  ConstituentSortField,
  ConstituentSortOrder,
  ConstituentType,
} from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

import { ConstituentsTable } from "./constituents-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
/**
 * Mirror of `CONSTITUENT_SORT_FIELDS` from the API
 * (`packages/api/src/modules/constituents/routes.ts`). Keeping the
 * whitelist on the client too means we never round-trip a value the API
 * will reject with 400.
 */
const CONSTITUENT_SORT_FIELDS = new Set<ConstituentSortField>([
  "name",
  "type",
  "email",
  "lastDonation",
  "createdAt",
]);
const DEFAULT_SORT: ConstituentSortField = "createdAt";
const DEFAULT_ORDER: ConstituentSortOrder = "desc";

function parseSortField(value: string | string[] | undefined): ConstituentSortField {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && CONSTITUENT_SORT_FIELDS.has(raw as ConstituentSortField)
    ? (raw as ConstituentSortField)
    : DEFAULT_SORT;
}

function parseSortOrder(value: string | string[] | undefined): ConstituentSortOrder {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" ? "asc" : DEFAULT_ORDER;
}

interface ConstituentsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const parsed = val ? Number.parseInt(val, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export default async function ConstituentsPage({ searchParams }: ConstituentsPageProps) {
  const auth = await requireAuth();
  const canManageAdminActions = auth.roles.includes("org_admin");
  const canWrite = hasPermission(auth, "write");
  const params = await searchParams;
  const t = await getTranslations("constituents");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const searchValue = Array.isArray(params.search) ? params.search[0] : params.search;
  const rawType = Array.isArray(params.type) ? params.type[0] : params.type;
  const ALLOWED_TYPES: readonly ConstituentType[] = [
    "donor",
    "volunteer",
    "member",
    "beneficiary",
    "partner",
  ];
  const typeValue = ALLOWED_TYPES.find((t) => t === rawType);
  // Multi-value type filter (issue #465). Normalise `?types=` to an array of
  // whitelisted values (repeatable param OR single string), de-duplicated.
  const rawTypes = Array.isArray(params.types) ? params.types : params.types ? [params.types] : [];
  const typeValues = Array.from(
    new Set(ALLOWED_TYPES.filter((t) => rawTypes.includes(t))),
  ) as ConstituentType[];
  const sort = parseSortField(params.sort);
  const order = parseSortOrder(params.order);

  // Epic #418 — advanced-filter DSL from the shareable `?filters=` URL param.
  // Pre-parse defensively: a hand-mangled URL with unparseable JSON is treated
  // as "no filter" here AND in the table (both sides run the same JSON.parse
  // guard), so server and client agree the filter is absent.
  const rawFilters = Array.isArray(params.filters) ? params.filters[0] : params.filters;
  let filtersParam: string | undefined;
  if (rawFilters) {
    try {
      JSON.parse(rawFilters);
      filtersParam = rawFilters;
    } catch {
      filtersParam = undefined;
    }
  }

  const client = await createServerApiClient();

  // SSR fetch of the global feature flags — used here to hide the
  // bulk-email surfaces (Email selection button + Recent emails
  // panel) when the `communication.bulk_email` flag is off. PR #352
  // / issue #326. A network failure here defaults the flag to OFF
  // (safest posture — if we can't confirm the feature is on, don't
  // render it).
  let bulkEmailEnabled = false;
  let bulkImportEnabled = false;
  // Issue #465 — when off, the multi-value type affordances are completely
  // absent (single-badge cell + single-value quick filter), behaviour
  // identical to the legacy single picklist.
  let multiTypeEnabled = false;
  // Epic #418 — with the flag off, the FilterBuilder entry point, the chip
  // strip and the `?filters=` passthrough are all absent; the page behaves
  // byte-for-byte like today (basic "More filters" dialog only).
  let advancedFiltersEnabled = false;
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    bulkEmailEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL);
    bulkImportEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT);
    multiTypeEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE);
    advancedFiltersEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.ADVANCED_FILTERS);
  } catch {
    bulkEmailEnabled = false;
    bulkImportEnabled = false;
    multiTypeEnabled = false;
    advancedFiltersEnabled = false;
  }

  // Only forward the DSL when the flag is on — the API 404s the param
  // otherwise. A shared filter URL opened by a flag-off tenant degrades to
  // the unfiltered list with no filter affordances (surface fully absent).
  const effectiveFilters = advancedFiltersEnabled ? filtersParam : undefined;

  const listQuery = {
    page,
    perPage,
    search: searchValue,
    // Flag on → multi-value `?types=` filter; flag off → legacy single
    // `?type=` so the off-state query is byte-for-byte what it is today.
    type: multiTypeEnabled ? undefined : typeValue,
    types: multiTypeEnabled && typeValues.length > 0 ? typeValues : undefined,
    sort,
    order,
    filters: effectiveFilters,
  };

  let result: ConstituentListResponse;
  // True when the API rejected a syntactically-valid-JSON `?filters=` value
  // (unknown field, bad operator — a hand-edited or stale shared link). The
  // page falls back to the unfiltered list and the table shows an inline
  // notice instead of silently pretending the filter applied.
  let advancedFilterInvalid = false;
  try {
    result = await ConstituentService.listConstituents(client, listQuery);
  } catch (err) {
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 403)) {
      result = {
        data: [],
        pagination: { page, perPage, total: 0, totalPages: 0 },
      };
    } else if (effectiveFilters && err instanceof ApiProblem && err.status === 400) {
      advancedFilterInvalid = true;
      result = await ConstituentService.listConstituents(client, {
        ...listQuery,
        filters: undefined,
      });
    } else {
      throw err;
    }
  }

  const hasAny = result.pagination.total > 0;
  // A zero-result view REACHED THROUGH filtering must keep the table shell
  // (search box, filter strip) mounted so the operator can clear the filter —
  // the page-level "seed your first constituents" empty state is only for a
  // genuinely empty, unfiltered base.
  const hasActiveQueryContext = Boolean(
    searchValue ||
      typeValue ||
      typeValues.length > 0 ||
      effectiveFilters ||
      params.lastDonationFrom ||
      params.lastDonationTo ||
      params.minLifetimeAmountCents,
  );

  return (
    <>
      {/* ADR-035 rule A1 — the page header and filter bar are static shell
          (no entrance animation). Only content cascades: the table
          container (or empty state) is slot 0, rows follow — both live
          inside ConstituentsTable. */}
      <PageHeader
        title={t("title")}
        description={
          hasAny ? t("subtitleWithCount", { count: result.pagination.total }) : t("subtitleEmpty")
        }
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
        actions={
          canWrite ? (
            <>
              {bulkImportEnabled ? <BulkImportTrigger /> : null}
              <Button asChild variant="primary" size="sm">
                <Link href="/constituents/new">
                  <Plus size={16} aria-hidden="true" />
                  {t("actions.new")}
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      {hasAny || hasActiveQueryContext ? (
        <ConstituentsTable
          constituents={result.data}
          pagination={result.pagination}
          canManageAdminActions={canManageAdminActions}
          canWrite={canWrite}
          bulkEmailEnabled={bulkEmailEnabled}
          multiTypeEnabled={multiTypeEnabled}
          advancedFiltersEnabled={advancedFiltersEnabled}
          advancedFilterInvalid={advancedFilterInvalid}
          sort={sort}
          order={order}
        />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest border border-border-brand reveal-item">
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.seedHint")} />
        </div>
      )}
    </>
  );
}
