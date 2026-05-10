import { Globe2, Users } from "lucide-react";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { InitialLetterAvatar } from "@/components/branding/initial-letter-avatar";
import { PublicDonationForm } from "@/components/campaigns/public-donation-form";
import { Badge } from "@/components/ui/badge";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { getReadableTextColor } from "@/lib/color";
import { formatCurrency } from "@/lib/format";
import { isUuid } from "@/lib/utils";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";

interface PublicCampaignPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const DEFAULT_THEME_COLOR = "#096447";

/**
 * Postal QR token shape: nanoid base64url, 10–32 chars (matches the
 * server-side validator in `packages/api/src/modules/public/routes.ts`).
 * Anything else is silently dropped so a tampered URL doesn't reach the
 * donate endpoint as a 400 — the form still works for organic visits.
 */
const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{10,32}$/;

function extractQrCode(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && QR_TOKEN_PATTERN.test(raw) ? raw : undefined;
}

/**
 * Issue #200 progress-display helper. Decides whether to show the progress
 * bar (goal + donations both present) vs. the static metric tiles, and
 * computes the progress percentage clamped to 100. Pulled out of
 * `PublicCampaignPage` to keep that function under the cognitive-complexity
 * threshold; pure-by-construction (no I/O, deterministic on inputs).
 */
function computeProgressDisplay(
  goalAmountCents: number | null,
  raisedCents: number,
): { hasGoal: boolean; showProgress: boolean; goalCents: number; progressPercent: number } {
  const hasGoal = goalAmountCents !== null && goalAmountCents > 0;
  const showProgress = hasGoal && raisedCents > 0;
  const goalCents = goalAmountCents ?? 0;
  const progressPercent =
    hasGoal && goalCents > 0 ? Math.min(100, Math.round((raisedCents / goalCents) * 100)) : 0;
  return { hasGoal, showProgress, goalCents, progressPercent };
}

export default async function PublicCampaignPage({
  params,
  searchParams,
}: PublicCampaignPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const qrCode = extractQrCode(sp.qr);
  if (!isUuid(id)) {
    notFound();
  }

  const client = await createServerApiClient();
  const locale = await getLocale();
  const t = await getTranslations("publicDonationPage");

  // Epic #274 — record the postal-letter scan as soon as the donor lands on
  // this page, not only when they convert to a donation. The resolver is
  // idempotent server-side (`scanned_at` is set only on first contact, so
  // refreshes don't double-count), and returns `null` for unknown tokens —
  // we never block the render on it. Fire-and-forget pattern (no `await`)
  // would skip the SSR cycle entirely and stay clean from the user's POV;
  // we await briefly here so the QR-tracking widget on the admin page picks
  // up the scan immediately if the operator is watching it during testing.
  if (qrCode) {
    await CampaignPublicPageService.resolvePostalQrToken(client, qrCode);
  }

  try {
    const page = await CampaignPublicPageService.getPublishedCampaignPublicPage(client, id);
    const colorPrimary = page.colorPrimary ?? DEFAULT_THEME_COLOR;
    const onPrimary = getReadableTextColor(colorPrimary);
    const { hasGoal, showProgress, goalCents, progressPercent } = computeProgressDisplay(
      page.goalAmountCents,
      page.raisedCents,
    );

    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(9,100,71,0.14),_transparent_42%),linear-gradient(180deg,_var(--color-surface-container-lowest)_0%,_var(--color-surface)_100%)]">
        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-4 sm:px-8 sm:py-6 lg:px-10 lg:py-10">
          <div className="flex justify-end">
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
                {/*
                 * Org logo (Epic #286) — top-left, NOT centered. The
                 * `public-hero` variant is content-addressed in object
                 * storage and served `Cache-Control: immutable`, so we
                 * skip the Next image optimiser (`unoptimized`) — donor
                 * traffic mustn't pay for proxying an already-sized asset.
                 * Falls back to the initial-letter avatar when the tenant
                 * hasn't uploaded a logo yet, keeping the hero balanced
                 * even on greenfield campaigns.
                 */}
                {page.organisationName ? (
                  <OrgLogoBlock
                    organisationName={page.organisationName}
                    organisationId={page.organisationId}
                    organisationLogoUrl={page.organisationLogoUrl}
                  />
                ) : null}
                {/*
                 * Eyebrow line shows the operator's organisation name when
                 * available — turns the page from "generic donation form"
                 * into "I am giving to <Org X>" (Epic #274 follow-up). The
                 * UPPERCASE + tracking convention keeps the org subordinate
                 * to the campaign title (which stays the visual hero) so
                 * donors still parse what they're funding first, who's
                 * raising it second.
                 */}
                <p className="text-xs font-medium uppercase tracking-[0.18em] opacity-80">
                  {page.organisationName ?? t("eyebrow")}
                </p>
                <h1 className="mt-4 max-w-3xl font-heading text-4xl leading-tight sm:text-5xl">
                  {page.title}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 opacity-90 sm:text-lg">
                  {page.description || t("descriptionFallback")}
                </p>
                {/*
                 * Mission line — only rendered when the org has filled it.
                 * Sits under the description as a subtle attribution so
                 * donors see what the organisation actually does, not just
                 * its name. Italic to distinguish from the campaign copy.
                 */}
                {page.organisationMission ? (
                  <p className="mt-3 max-w-2xl text-sm italic leading-6 opacity-80">
                    {page.organisationMission}
                  </p>
                ) : null}
              </div>

              {showProgress ? (
                <Progress
                  raisedCents={page.raisedCents}
                  goalCents={goalCents}
                  donorCount={page.donorCount}
                  progressPercent={progressPercent}
                  colorPrimary={colorPrimary}
                  locale={locale}
                  raisedLabel={t("metrics.raised")}
                  goalSuffix={t("metrics.goalSuffix")}
                  donorsLabel={t("metrics.donors", { count: page.donorCount })}
                />
              ) : (
                <div
                  className={`grid gap-4 border-t border-outline-variant px-5 py-5 sm:px-8 sm:py-6 lg:px-10 lg:py-8 ${hasGoal ? "sm:grid-cols-2" : ""}`}
                >
                  {hasGoal ? (
                    <Metric label={t("metrics.goal")} value={formatCurrency(goalCents, locale)} />
                  ) : null}
                  <Metric label={t("metrics.trust")} value={t("metrics.trustValue")} />
                </div>
              )}
            </section>

            <PublicDonationForm
              campaignId={id}
              colorPrimary={colorPrimary}
              locale={locale}
              goalAmountCents={page.goalAmountCents}
              defaultCurrency={page.defaultCurrency}
              publishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
              tenantStripeAccountId={page.stripeAccountId}
              qrCode={qrCode}
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

/**
 * Org logo block — shows the uploaded logo (Epic #286) or a fallback
 * initial-letter avatar. Pulled out of `PublicCampaignPage` so the
 * parent stays under the cognitive-complexity threshold; behaviour
 * unchanged from the inline JSX.
 */
function OrgLogoBlock({
  organisationName,
  organisationId,
  organisationLogoUrl,
}: {
  organisationName: string;
  organisationId: string | undefined;
  organisationLogoUrl: string | null | undefined;
}) {
  return (
    <div className="mb-6 flex">
      {organisationLogoUrl ? (
        <div className="relative h-14 w-14 overflow-hidden rounded-xl bg-white/10 backdrop-blur-sm">
          <Image
            src={organisationLogoUrl}
            alt={organisationName}
            fill
            sizes="56px"
            unoptimized
            className="object-contain"
            priority
          />
        </div>
      ) : (
        <InitialLetterAvatar
          orgName={organisationName}
          tenantId={organisationId}
          size="lg"
          ariaLabel={organisationName}
        />
      )}
    </div>
  );
}

function Progress({
  raisedCents,
  goalCents,
  donorCount,
  progressPercent,
  colorPrimary,
  locale,
  raisedLabel,
  goalSuffix,
  donorsLabel,
}: {
  raisedCents: number;
  goalCents: number;
  donorCount: number;
  progressPercent: number;
  colorPrimary: string;
  locale: string;
  raisedLabel: string;
  goalSuffix: string;
  donorsLabel: string;
}) {
  return (
    <div className="border-t border-outline-variant px-5 py-5 sm:px-8 sm:py-6 lg:px-10 lg:py-8">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-on-surface-variant">
          {raisedLabel}
        </p>
        <p className="font-mono text-xs text-on-surface-variant">
          {donorCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Users size={12} aria-hidden="true" />
              {donorsLabel}
            </span>
          ) : null}
        </p>
      </div>
      <p className="mt-2 font-heading text-2xl text-on-surface sm:text-3xl">
        <span className="font-semibold">{formatCurrency(raisedCents, locale)}</span>
        <span className="ml-1 text-sm font-normal text-on-surface-variant">
          {goalSuffix} {formatCurrency(goalCents, locale)}
        </span>
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-label={raisedLabel}
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-container"
      >
        <div
          className="h-full rounded-full transition-[width] duration-slow"
          style={{ width: `${progressPercent}%`, backgroundColor: colorPrimary }}
        />
      </div>
    </div>
  );
}
