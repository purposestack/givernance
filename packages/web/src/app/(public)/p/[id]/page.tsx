import { ArrowLeft, Globe2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { PublicDonationForm } from "@/components/campaigns/public-donation-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { formatCurrency } from "@/lib/format";
import { isUuid } from "@/lib/utils";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";

interface PublicCampaignPageProps {
  params: Promise<{ id: string }>;
}

const DEFAULT_THEME_COLOR = "#096447";

export default async function PublicCampaignPage({ params }: PublicCampaignPageProps) {
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }

  const client = await createServerApiClient();
  const locale = await getLocale();
  const t = await getTranslations("publicDonationPage");

  try {
    const page = await CampaignPublicPageService.getPublishedCampaignPublicPage(client, id);
    const colorPrimary = page.colorPrimary ?? DEFAULT_THEME_COLOR;
    const onPrimary = getReadableTextColor(colorPrimary);
    const hasGoal = page.goalAmountCents !== null && page.goalAmountCents > 0;

    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(9,100,71,0.14),_transparent_42%),linear-gradient(180deg,_var(--color-surface-container-lowest)_0%,_var(--color-surface)_100%)]">
        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-4 sm:px-8 sm:py-6 lg:px-10 lg:py-10">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                <ArrowLeft size={16} aria-hidden="true" />
                {t("backHome")}
              </Link>
            </Button>
            <Badge variant="info">
              <Globe2 size={12} aria-hidden="true" />
              {t("badge")}
            </Badge>
          </div>

          <div className="mt-6 grid flex-1 gap-6 lg:mt-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,420px)] lg:items-start">
            <section className="overflow-hidden rounded-[32px] border border-outline-variant bg-surface-container-lowest shadow-card">
              <div
                className="px-5 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12"
                style={{
                  background: `linear-gradient(135deg, ${colorPrimary}, color-mix(in srgb, ${colorPrimary} 60%, #0B1220))`,
                  color: onPrimary,
                }}
              >
                <p className="text-xs font-medium uppercase tracking-[0.18em] opacity-80">
                  {t("eyebrow")}
                </p>
                <h1 className="mt-4 max-w-3xl font-heading text-4xl leading-tight sm:text-5xl">
                  {page.title}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 opacity-90 sm:text-lg">
                  {page.description || t("descriptionFallback")}
                </p>
              </div>

              <div
                className={`grid gap-4 border-t border-outline-variant px-5 py-5 sm:px-8 sm:py-6 lg:px-10 lg:py-8 ${hasGoal ? "sm:grid-cols-2" : ""}`}
              >
                {hasGoal ? (
                  <Metric
                    label={t("metrics.goal")}
                    value={formatCurrency(page.goalAmountCents, locale)}
                  />
                ) : null}
                <Metric label={t("metrics.trust")} value={t("metrics.trustValue")} />
              </div>
            </section>

            <PublicDonationForm
              campaignId={id}
              colorPrimary={colorPrimary}
              locale={locale}
              goalAmountCents={page.goalAmountCents}
              defaultCurrency={page.defaultCurrency}
            />
          </div>
        </div>
      </main>
    );
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 404) {
      notFound();
    }
    throw error;
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface px-4 py-4">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-on-surface-variant">
        {label}
      </p>
      <p className="mt-2 text-base font-semibold text-on-surface sm:text-lg">{value}</p>
    </div>
  );
}

function getReadableTextColor(hex: string): "#FFFFFF" | "#111827" {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#FFFFFF";
}
