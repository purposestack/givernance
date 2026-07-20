import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Gift, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import {
  fetchCustomFieldDefinitionsOrEmpty,
  projectableDefinitions,
} from "@/components/shared/custom-fields";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import type { DonationListResponse, DonationSortField, DonationSortOrder } from "@/models/donation";
import { DonationService } from "@/services/DonationService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

import { DonationsTable } from "./donations-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Mirror of `DONATION_SORT_FIELDS` from the API
 * (`packages/api/src/modules/donations/routes.ts`). The API rejects unknown
 * `sort` values with 400 RFC 9457 — this set is the same whitelist applied
 * client-side so we never even send a value the server doesn't accept.
 */
const DONATION_SORT_FIELDS = new Set<DonationSortField>([
  "donatedAt",
  "amountCents",
  "paymentMethod",
  "donor",
  "campaign",
  "createdAt",
]);
const DEFAULT_SORT: DonationSortField = "donatedAt";
const DEFAULT_ORDER: DonationSortOrder = "desc";

function parseSortField(value: string | string[] | undefined): DonationSortField {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && DONATION_SORT_FIELDS.has(raw as DonationSortField)
    ? (raw as DonationSortField)
    : DEFAULT_SORT;
}

function parseSortOrder(value: string | string[] | undefined): DonationSortOrder {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" ? "asc" : DEFAULT_ORDER;
}

interface DonationsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const parsed = val ? Number.parseInt(val, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function parseIsoDate(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !ISO_DATE_RE.test(raw)) return undefined;
  return raw;
}

function parseUuid(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}

export default async function DonationsPage({ searchParams }: DonationsPageProps) {
  const auth = await requireAuth();
  const canWrite = hasPermission(auth, "write");
  const canDelete = hasPermission(auth, "admin");
  const params = await searchParams;
  const t = await getTranslations("donations");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const searchValue = Array.isArray(params.search) ? params.search[0] : params.search;
  const dateFrom = parseIsoDate(params.dateFrom);
  const dateTo = parseIsoDate(params.dateTo);
  const campaignId = parseUuid(params.campaignId);
  const constituentId = parseUuid(params.constituentId);
  const rawReceipt = Array.isArray(params.receiptStatus)
    ? params.receiptStatus[0]
    : params.receiptStatus;
  const receiptStatusValue =
    rawReceipt === "pending" || rawReceipt === "generated" || rawReceipt === "failed"
      ? rawReceipt
      : undefined;
  const sort = parseSortField(params.sort);
  const order = parseSortOrder(params.order);

  const client = await createServerApiClient();

  // Epic #539 — donation-domain custom columns (`row.custom`) + the donor
  // projection columns (`row.donorCustom`, §6). Flag off / fetch failure ⇒
  // no defs ⇒ both column sets completely absent.
  let donationCustomEnabled = false;
  let constituentCustomEnabled = false;
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    donationCustomEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS);
    constituentCustomEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS);
  } catch {
    donationCustomEnabled = false;
    constituentCustomEnabled = false;
  }
  const [donationDefs, constituentDefs] = await Promise.all([
    fetchCustomFieldDefinitionsOrEmpty(client, "donation", donationCustomEnabled),
    fetchCustomFieldDefinitionsOrEmpty(client, "constituent", constituentCustomEnabled),
  ]);
  const donorDefs = projectableDefinitions(constituentDefs);

  let result: DonationListResponse;
  try {
    result = await DonationService.listDonations(client, {
      page,
      perPage,
      search: searchValue,
      dateFrom,
      dateTo,
      campaignId,
      constituentId,
      receiptStatus: receiptStatusValue,
      sort,
      order,
    });
  } catch (err) {
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 403)) {
      result = {
        data: [],
        pagination: { page, perPage, total: 0, totalPages: 0 },
      };
    } else {
      throw err;
    }
  }

  const hasAny = result.pagination.total > 0;
  // The date-range filter now lives INSIDE the table's search row (the
  // constituents grammar). Keep the table mounted whenever any filter is
  // active, even with zero results — otherwise an over-restrictive filter
  // would swap in the page-level empty state and take the only way to
  // clear the filter with it.
  const filtersActive = Boolean(
    searchValue || dateFrom || dateTo || receiptStatusValue || campaignId || constituentId,
  );

  // ADR-035 rule A1 — the page header and the search row inside
  // DonationsTable (search + receipt select + "More filters" button) are
  // static shell: no entrance animation, instantly interactive. Only
  // content cascades — the table container (or empty state) is slot 0,
  // rows follow from slot 1 inside DonationsTable (rules A2/A3).
  return (
    <>
      <PageHeader
        title={t("title")}
        description={
          hasAny ? t("subtitleWithCount", { count: result.pagination.total }) : t("subtitleEmpty")
        }
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
        actions={
          canWrite ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/donations/new">
                <Plus size={16} aria-hidden="true" />
                {t("actions.new")}
              </Link>
            </Button>
          ) : null
        }
      />

      {/* Static spacing wrapper (no animation — its search-row child is a
          filter bar, rule A1): the inner `space-y-*` mirrors the app-shell
          content flow so the table's search row keeps its spacing. */}
      <div className="space-y-6 sm:space-y-8">
        {hasAny || filtersActive ? (
          <DonationsTable
            donations={result.data}
            pagination={result.pagination}
            canWrite={canWrite}
            canDelete={canDelete}
            sort={sort}
            order={order}
            dateFrom={dateFrom ?? ""}
            dateTo={dateTo ?? ""}
            customFieldDefs={donationDefs}
            donorCustomDefs={donorDefs}
          />
        ) : (
          <div className="reveal-item rounded-2xl bg-surface-container-lowest border border-border-brand">
            <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.seedHint")} />
          </div>
        )}
      </div>
    </>
  );
}
