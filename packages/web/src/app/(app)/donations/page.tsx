import { Gift, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { DonationListResponse } from "@/models/donation";
import { DonationService } from "@/services/DonationService";

import { DonationsFilters } from "./donations-filters";
import { DonationsTable } from "./donations-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("donations");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const dateFrom = parseIsoDate(params.dateFrom);
  const dateTo = parseIsoDate(params.dateTo);
  const campaignId = parseUuid(params.campaignId);
  const constituentId = parseUuid(params.constituentId);

  const client = await createServerApiClient();

  let result: DonationListResponse;
  try {
    result = await DonationService.listDonations(client, {
      page,
      perPage,
      dateFrom,
      dateTo,
      campaignId,
      constituentId,
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

  return (
    <>
      <PageHeader
        title={t("title")}
        description={
          hasAny ? t("subtitleWithCount", { count: result.pagination.total }) : t("subtitleEmpty")
        }
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
        actions={
          <Button asChild variant="primary" size="sm">
            <Link href="/donations/new">
              <Plus size={16} aria-hidden="true" />
              {t("actions.new")}
            </Link>
          </Button>
        }
      />

      <DonationsFilters dateFrom={dateFrom ?? ""} dateTo={dateTo ?? ""} />

      {hasAny ? (
        <DonationsTable donations={result.data} pagination={result.pagination} />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest shadow-card">
          <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.seedHint")} />
        </div>
      )}
    </>
  );
}
