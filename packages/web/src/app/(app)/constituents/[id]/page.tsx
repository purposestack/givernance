import { Download, FileText, GitMerge, Mail, Pencil, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate } from "@/lib/format";
import { type Constituent, fullName, initials } from "@/models/constituent";
import type { Donation, DonationListResponse } from "@/models/donation";
import { ConstituentService } from "@/services/ConstituentService";
import { DonationService } from "@/services/DonationService";

import { DetailTabs } from "./detail-tabs";
import { DonationsTable } from "./donations-table";

const DEFAULT_DONATIONS_PER_PAGE = 10;
const MAX_DONATIONS_PER_PAGE = 100;

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const TYPE_VARIANTS: Record<string, BadgeVariant> = {
  donor: "success",
  volunteer: "info",
  member: "warning",
  beneficiary: "warning",
  partner: "neutral",
};

const KNOWN_TYPES = new Set(["donor", "volunteer", "member", "beneficiary", "partner"]);
type KnownConstituentType = "donor" | "volunteer" | "member" | "beneficiary" | "partner";

interface DetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

async function fetchConstituentOrNotFound(id: string): Promise<Constituent> {
  const client = await createServerApiClient();
  try {
    return await ConstituentService.getConstituent(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }
    throw err;
  }
}

async function fetchDonationsOrEmpty(
  id: string,
  page: number,
  perPage: number,
): Promise<DonationListResponse> {
  const client = await createServerApiClient();
  try {
    return await DonationService.listDonations(client, {
      constituentId: id,
      page,
      perPage,
    });
  } catch (err) {
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 403)) {
      return {
        data: [],
        pagination: { page, perPage, total: 0, totalPages: 0 },
      };
    }
    throw err;
  }
}

export default async function ConstituentDetailPage({ params, searchParams }: DetailPageProps) {
  const auth = await requireAuth();
  const canManageAdminActions = auth.roles.includes("org_admin");
  const { id } = await params;
  const sp = await searchParams;

  const donationsPage = parsePositiveInt(sp.donationsPage, 1);
  const donationsPerPage = parsePositiveInt(
    sp.donationsPerPage,
    DEFAULT_DONATIONS_PER_PAGE,
    MAX_DONATIONS_PER_PAGE,
  );

  const [constituent, donationsResult] = await Promise.all([
    fetchConstituentOrNotFound(id),
    fetchDonationsOrEmpty(id, donationsPage, donationsPerPage),
  ]);

  const t = await getTranslations("constituentDetail");
  const tType = await getTranslations("constituents.types");
  const locale = await getLocale();

  const totalDonatedCents = donationsResult.data.reduce(
    (sum: number, d: Donation) => sum + d.amountCents,
    0,
  );
  const lastDonation = donationsResult.data[0];

  return (
    <>
      <DetailBreadcrumbs
        constituentName={fullName(constituent)}
        labels={{
          root: t("breadcrumbRoot"),
          constituents: t("breadcrumbConstituents"),
        }}
      />
      <ProfileCard
        constituent={constituent}
        locale={locale}
        memberSinceLabel={t("profile.memberSince", {
          date: formatDate(constituent.createdAt, locale, "long"),
        })}
        typeLabel={resolveTypeLabel(constituent.type, tType)}
        typeVariant={TYPE_VARIANTS[String(constituent.type)] ?? "neutral"}
        canManageAdminActions={canManageAdminActions}
        labels={{
          ariaLabel: t("profile.ariaLabel"),
          email: t("profile.email"),
          phone: t("profile.phone"),
          edit: t("actions.edit"),
          merge: t("actions.merge"),
          exportGdpr: t("actions.exportGdpr"),
          delete: t("actions.delete"),
        }}
      />
      <AiSuggestionCard
        labels={{
          ariaLabel: t("aiSuggestion.ariaLabel"),
          label: t("aiSuggestion.label"),
          body: t("aiSuggestion.body"),
          apply: t("aiSuggestion.apply"),
          ignore: t("aiSuggestion.ignore"),
        }}
      />
      <DetailTabs
        overview={
          <OverviewTab
            totalDonatedCents={totalDonatedCents}
            donationCount={donationsResult.pagination.total}
            lastDonationAt={lastDonation?.donatedAt}
            locale={locale}
            labels={{
              ariaLabel: t("overview.ariaLabel"),
              title: t("overview.title"),
              noActivity: t("overview.noActivity"),
              totalDonated: t("overview.stats.totalDonated"),
              pledgeCount: t("overview.stats.pledgeCount"),
              lastActivity: t("overview.stats.lastActivity"),
            }}
          />
        }
        donations={
          <DonationsTable
            donations={donationsResult.data}
            pagination={donationsResult.pagination}
          />
        }
        timeline={
          <TimelineTab
            constituent={constituent}
            lastDonation={lastDonation}
            locale={locale}
            labels={{
              ariaLabel: t("timeline.ariaLabel"),
              title: t("timeline.title"),
              stubHint: t("timeline.stubHint"),
              profileCreated: t("timeline.items.profileCreated"),
              lastDonation: (amount: string) => t("timeline.items.lastDonation", { amount }),
            }}
          />
        }
      />
    </>
  );
}

function resolveTypeLabel(type: string, tType: (key: KnownConstituentType) => string): string {
  return KNOWN_TYPES.has(type) ? tType(type as KnownConstituentType) : type;
}

function DetailBreadcrumbs({
  constituentName,
  labels,
}: {
  constituentName: string;
  labels: { root: string; constituents: string };
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex items-center gap-2 text-sm text-on-surface-variant">
        <li>
          <Link href="/dashboard" className="whitespace-nowrap hover:text-on-surface">
            {labels.root}
          </Link>
        </li>
        <li aria-hidden="true" className="text-xs text-outline-variant">
          /
        </li>
        <li>
          <Link href="/constituents" className="whitespace-nowrap hover:text-on-surface">
            {labels.constituents}
          </Link>
        </li>
        <li aria-hidden="true" className="text-xs text-outline-variant">
          /
        </li>
        <li className="min-w-0">
          <span className="truncate font-medium text-on-surface" aria-current="page">
            {constituentName}
          </span>
        </li>
      </ol>
    </nav>
  );
}

interface ProfileLabels {
  ariaLabel: string;
  email: string;
  phone: string;
  edit: string;
  merge: string;
  exportGdpr: string;
  delete: string;
}

function ProfileCard({
  constituent,
  memberSinceLabel,
  typeLabel,
  typeVariant,
  canManageAdminActions,
  labels,
}: {
  constituent: Constituent;
  locale: string;
  memberSinceLabel: string;
  typeLabel: string;
  typeVariant: BadgeVariant;
  canManageAdminActions: boolean;
  labels: ProfileLabels;
}) {
  return (
    <section
      aria-label={labels.ariaLabel}
      className="mb-6 flex flex-col gap-5 rounded-2xl bg-surface-container-lowest p-6 shadow-card md:flex-row md:items-start"
    >
      <div
        aria-hidden="true"
        className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-on-primary"
      >
        {initials(constituent)}
      </div>

      <div className="min-w-0 flex-1">
        <h1 className="font-heading text-3xl leading-tight text-on-surface">
          {fullName(constituent)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant={typeVariant}>{typeLabel}</Badge>
          {constituent.tags?.map((tag) => (
            <Badge key={tag} variant="neutral" shape="square">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="mt-2 text-sm text-on-surface-variant">{memberSinceLabel}</p>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <ContactRow
            label={labels.email}
            value={constituent.email}
            href={constituent.email ? `mailto:${constituent.email}` : null}
          />
          <ContactRow
            label={labels.phone}
            value={constituent.phone}
            href={constituent.phone ? `tel:${constituent.phone}` : null}
          />
        </dl>
      </div>

      <ProfileActions
        constituentId={constituent.id}
        canManageAdminActions={canManageAdminActions}
        labels={labels}
      />
    </section>
  );
}

function ContactRow({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null;
  href: string | null;
}) {
  const content = value && href ? <ContactLink href={href}>{value}</ContactLink> : "—";
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-16 shrink-0 font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 truncate text-on-surface">{content}</dd>
    </div>
  );
}

function ContactLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="text-sky-text hover:underline">
      {children}
    </a>
  );
}

function ProfileActions({
  constituentId,
  canManageAdminActions,
  labels,
}: {
  constituentId: string;
  /**
   * Merge (`POST /v1/constituents/:id/merge`) and Delete
   * (`DELETE /v1/constituents/:id`) both require `org_admin` server-side.
   * Hide the affordances for non-admins so they don't see buttons that
   * would 403 once wired up. Edit / Export GDPR stay visible — they're
   * either operational writes (Edit) or open to all roles (export stub).
   */
  canManageAdminActions: boolean;
  labels: ProfileLabels;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 md:shrink-0">
      <Button asChild variant="primary" size="sm">
        <Link href={`/constituents/${constituentId}/edit`}>
          <Pencil size={16} aria-hidden="true" />
          {labels.edit}
        </Link>
      </Button>
      {canManageAdminActions ? (
        <Button variant="secondary" size="sm" disabled>
          <GitMerge size={16} aria-hidden="true" />
          {labels.merge}
        </Button>
      ) : null}
      <Button variant="secondary" size="sm" disabled>
        <Download size={16} aria-hidden="true" />
        {labels.exportGdpr}
      </Button>
      {canManageAdminActions ? (
        <Button variant="destructive" size="sm" disabled>
          <Trash2 size={16} aria-hidden="true" />
          {labels.delete}
        </Button>
      ) : null}
    </div>
  );
}

function AiSuggestionCard({
  labels,
}: {
  labels: { ariaLabel: string; label: string; body: string; apply: string; ignore: string };
}) {
  return (
    <section
      aria-label={labels.ariaLabel}
      className="mb-6 rounded-2xl border border-primary/20 bg-primary-50/40 p-5 shadow-card"
    >
      <div className="flex items-center gap-2 text-primary">
        <Sparkles size={16} aria-hidden="true" />
        <span className="font-mono text-xs font-bold uppercase tracking-wide">{labels.label}</span>
      </div>
      <p className="mt-2 text-sm text-on-surface">{labels.body}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="primary" disabled>
          {labels.apply}
        </Button>
        <Button size="sm" variant="ghost" disabled>
          {labels.ignore}
        </Button>
      </div>
    </section>
  );
}

interface OverviewLabels {
  ariaLabel: string;
  title: string;
  noActivity: string;
  totalDonated: string;
  pledgeCount: string;
  lastActivity: string;
}

function OverviewTab({
  totalDonatedCents,
  donationCount,
  lastDonationAt,
  locale,
  labels,
}: {
  totalDonatedCents: number;
  donationCount: number;
  lastDonationAt: string | undefined;
  locale: string;
  labels: OverviewLabels;
}) {
  const lastActivityLabel = lastDonationAt ? formatDate(lastDonationAt, locale) : labels.noActivity;

  return (
    <section
      className="rounded-2xl bg-surface-container-lowest p-6 shadow-card"
      aria-label={labels.ariaLabel}
    >
      <h2 className="font-heading text-xl text-on-surface">{labels.title}</h2>
      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label={labels.totalDonated} value={formatCurrency(totalDonatedCents, locale)} />
        <Stat label={labels.pledgeCount} value={String(donationCount)} />
        <Stat label={labels.lastActivity} value={lastActivityLabel} small />
      </dl>
    </section>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-on-surface-variant">{label}</dt>
      <dd
        className={`mt-1 font-mono font-bold text-on-surface ${small ? "text-lg" : "text-xl"}`.trim()}
      >
        {value}
      </dd>
    </div>
  );
}

interface TimelineLabels {
  ariaLabel: string;
  title: string;
  stubHint: string;
  profileCreated: string;
  lastDonation: (amount: string) => string;
}

function TimelineTab({
  constituent,
  lastDonation,
  locale,
  labels,
}: {
  constituent: Constituent;
  lastDonation: Donation | undefined;
  locale: string;
  labels: TimelineLabels;
}) {
  return (
    <section
      className="rounded-2xl bg-surface-container-lowest p-6 shadow-card"
      aria-label={labels.ariaLabel}
    >
      <h2 className="font-heading text-xl text-on-surface">{labels.title}</h2>
      <ol className="mt-4 space-y-4">
        {lastDonation ? (
          <TimelineItem
            icon={<FileText size={16} />}
            iconClassName="bg-primary-50 text-primary"
            title={labels.lastDonation(
              formatCurrency(lastDonation.amountCents, locale, lastDonation.currency),
            )}
            meta={formatDate(lastDonation.donatedAt, locale)}
          />
        ) : null}
        <TimelineItem
          icon={<Mail size={16} />}
          iconClassName="bg-sky-50 text-sky-text"
          title={labels.profileCreated}
          meta={formatDate(constituent.createdAt, locale)}
        />
      </ol>
      <p className="mt-4 text-xs italic text-on-surface-variant">{labels.stubHint}</p>
    </section>
  );
}

function TimelineItem({
  icon,
  iconClassName,
  title,
  meta,
}: {
  icon: React.ReactNode;
  iconClassName: string;
  title: string;
  meta: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconClassName}`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-on-surface">{title}</p>
        <p className="text-xs text-on-surface-variant">{meta}</p>
      </div>
    </li>
  );
}
