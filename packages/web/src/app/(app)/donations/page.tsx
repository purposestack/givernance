import { Gift, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { CSSProperties } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import type { DonationListResponse, DonationSortField, DonationSortOrder } from "@/models/donation";
import { DonationService } from "@/services/DonationService";

import { DonationsFilters } from "./donations-filters";
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

  // ADR-035 rule A2 — entrance cascade in reading order: header (0) →
  // filter bar (1) → table container (2). Classes live on server-rendered
  // markup only; filter/sort/page changes re-render this RSC in place
  // (React reconciles the same wrappers, DOM nodes persist), so the
  // cascade runs once per navigation and never replays on a filter
  // round-trip (rules B9/B12).
  return (
    <>
      <PageHeader
        className="reveal-item"
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

      <DonationsFilters dateFrom={dateFrom ?? ""} dateTo={dateTo ?? ""} />

      {/* The inner `space-y-*` mirrors the app-shell content flow so the
          table's search row keeps its pre-wrapper spacing — the wrapper
          animates opacity/transform only, zero layout shift (rule A6). */}
      <div
        className="reveal-item space-y-6 sm:space-y-8"
        style={{ "--cascade-i": 2 } as CSSProperties}
      >
        {hasAny ? (
          <DonationsTable
            donations={result.data}
            pagination={result.pagination}
            canWrite={canWrite}
            canDelete={canDelete}
            sort={sort}
            order={order}
          />
        ) : (
          <div className="rounded-2xl bg-surface-container-lowest border border-border-brand">
            <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.seedHint")} />
          </div>
        )}
      </div>
    </>
  );
}
