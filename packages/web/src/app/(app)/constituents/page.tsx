import { Users } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { ConstituentListResponse } from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";

import { ConstituentsTable } from "./constituents-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

interface ConstituentsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export default async function ConstituentsPage({ searchParams }: ConstituentsPageProps) {
  await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("constituents");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const searchValue = Array.isArray(params.search) ? params.search[0] : params.search;

  const client = await createServerApiClient();

  let result: ConstituentListResponse;
  try {
    result = await ConstituentService.listConstituents(client, {
      page,
      perPage,
      search: searchValue,
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
      />

      {hasAny ? (
        <ConstituentsTable constituents={result.data} pagination={result.pagination} />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest shadow-card">
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.seedHint")} />
        </div>
      )}
    </>
  );
}
