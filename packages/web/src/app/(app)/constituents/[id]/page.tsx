import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { CustomFieldValues } from "@givernance/shared/custom-fields";
import { FileText, Mail, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConstituentTypeBadges } from "@/components/constituents/constituent-type-badge";
import { DeleteConstituentButton } from "@/components/constituents/delete-constituent-button";
import {
  CustomFieldDetailRows,
  type DetailCustomFieldDefinition,
  fetchDetailCustomFieldDefinitionsOrEmpty,
  visibleDetailCustomFieldDefinitions,
} from "@/components/shared/custom-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate } from "@/lib/format";
import { type Constituent, type ConstituentDetail, fullName, initials } from "@/models/constituent";
import type { Donation, DonationListResponse } from "@/models/donation";
import { ConstituentService } from "@/services/ConstituentService";
import { DonationService } from "@/services/DonationService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

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

async function fetchConstituentOrNotFound(id: string): Promise<ConstituentDetail> {
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
  const canWrite = hasPermission(auth, "write");
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

  // Issue #465 — when off, the profile header shows a single type badge
  // (`types[0]`), identical to today. When on, all types render as chips.
  // A flag-fetch failure defaults to OFF (safest single-badge posture).
  let multiTypeEnabled = false;
  // Epic #539 — flag off / fetch failure ⇒ no defs ⇒ no custom surface.
  let customFieldsEnabled = false;
  const flagClient = await createServerApiClient();
  try {
    const flags = await FeatureFlagsService.listPublic(flagClient);
    multiTypeEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE);
    customFieldsEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS);
  } catch {
    multiTypeEnabled = false;
    customFieldsEnabled = false;
  }
  // Detail catalog (includeArchived): archived definitions keep their stored
  // values visible here — read-only, "archived"-badged — per the archive
  // contract. Forms / filters / columns stay on the active-only catalog.
  const customFieldDefs = await fetchDetailCustomFieldDefinitionsOrEmpty(
    flagClient,
    "constituent",
    customFieldsEnabled,
  );

  const t = await getTranslations("constituentDetail");
  const tType = await getTranslations("constituents.types");
  const tCustom = await getTranslations("customFields");
  const locale = await getLocale();

  // Timeline teaser only — the giving totals come from the API (issue #614),
  // never from this one page of donations.
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
        multiTypeEnabled={multiTypeEnabled}
        canManageAdminActions={canManageAdminActions}
        canWrite={canWrite}
        labels={{
          ariaLabel: t("profile.ariaLabel"),
          email: t("profile.email"),
          phone: t("profile.phone"),
          edit: t("actions.edit"),
        }}
      />
      <DetailTabs
        overview={
          <>
            <OverviewTab
              totalDonatedCents={constituent.lifetimeAmountCents}
              donationCount={donationsResult.pagination.total}
              lastDonationAt={constituent.lastDonationAt}
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
            {/* Epic #539 — absent entirely when the flag is off / no defs. */}
            <CustomFieldsCard
              definitions={customFieldDefs}
              values={constituent.custom}
              locale={locale}
              title={tCustom("detail.sectionTitle")}
              booleanLabels={{ yes: tCustom("boolean.yes"), no: tCustom("boolean.no") }}
              archivedLabel={tCustom("detail.archivedBadge")}
            />
          </>
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

/**
 * "Custom fields" group on the Overview tab (Epic #539). Every active
 * definition renders a row (empty values as an em-dash) so operators see the
 * full configured surface; archived definitions render only when this record
 * still holds a value — muted, with an "archived" badge.
 */
function CustomFieldsCard({
  definitions,
  values,
  locale,
  title,
  booleanLabels,
  archivedLabel,
}: {
  definitions: DetailCustomFieldDefinition[];
  values: CustomFieldValues | undefined;
  locale: string;
  title: string;
  booleanLabels: { yes: string; no: string };
  archivedLabel: string;
}) {
  const visible = visibleDetailCustomFieldDefinitions(definitions, values);
  if (visible.length === 0) return null;
  return (
    <section
      aria-label={title}
      className="mt-6 rounded-2xl bg-surface-container-lowest p-6 border border-border-brand"
    >
      <h2 className="font-heading text-xl text-on-surface">{title}</h2>
      <div className="mt-4">
        <CustomFieldDetailRows
          definitions={visible}
          values={values}
          locale={locale}
          booleanLabels={booleanLabels}
          archivedLabel={archivedLabel}
        />
      </div>
    </section>
  );
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
}

function ProfileCard({
  constituent,
  memberSinceLabel,
  typeLabel,
  typeVariant,
  multiTypeEnabled,
  canManageAdminActions,
  canWrite,
  labels,
}: {
  constituent: Constituent;
  locale: string;
  memberSinceLabel: string;
  typeLabel: string;
  typeVariant: BadgeVariant;
  /**
   * `true` when `constituents.multi_type` is on (issue #465): render every
   * type as a chip. `false`: single badge on `types[0]` (the legacy view).
   */
  multiTypeEnabled: boolean;
  canManageAdminActions: boolean;
  canWrite: boolean;
  labels: ProfileLabels;
}) {
  return (
    <section
      aria-label={labels.ariaLabel}
      // ADR-035 rule A2 — content cascades in reading order: profile
      // header (0) → tabs block (1). Breadcrumbs are static structure
      // (rule A1). Pure CSS on server-rendered markup.
      className="mb-6 flex flex-col gap-5 rounded-2xl bg-surface-container-lowest p-6 border border-border-brand md:flex-row md:items-start reveal-item"
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
          {multiTypeEnabled ? (
            <ConstituentTypeBadges types={constituent.types} />
          ) : (
            <Badge variant={typeVariant}>{typeLabel}</Badge>
          )}
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
        constituentName={fullName(constituent)}
        canManageAdminActions={canManageAdminActions}
        canWrite={canWrite}
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
  constituentName,
  canManageAdminActions,
  canWrite,
  labels,
}: {
  constituentId: string;
  constituentName: string;
  /**
   * Delete (`DELETE /v1/constituents/:id`) requires `org_admin` server-side.
   * Hide the affordance for non-admins so they don't see a button that
   * would 403.
   */
  canManageAdminActions: boolean;
  /**
   * `false` for the `viewer` role — Edit (`PUT /v1/constituents/:id`) is
   * `requireWrite` server-side. Hide the button so viewers land on a
   * read-only profile view rather than a CTA that would 403.
   */
  canWrite: boolean;
  labels: ProfileLabels;
}) {
  // Issue #614 — only actions with a backing flow render. The permanently
  // disabled Merge / Export GDPR placeholders are gone until those profile
  // flows exist.
  if (!canWrite && !canManageAdminActions) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 md:shrink-0">
      {canWrite ? (
        <Button asChild variant="primary" size="sm">
          <Link href={`/constituents/${constituentId}/edit`}>
            <Pencil size={16} aria-hidden="true" />
            {labels.edit}
          </Link>
        </Button>
      ) : null}
      {canManageAdminActions ? (
        <DeleteConstituentButton constituentId={constituentId} constituentName={constituentName} />
      ) : null}
    </div>
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
  lastDonationAt: string | null;
  locale: string;
  labels: OverviewLabels;
}) {
  const lastActivityLabel = lastDonationAt ? formatDate(lastDonationAt, locale) : labels.noActivity;

  return (
    <section
      className="rounded-2xl bg-surface-container-lowest p-6 border border-border-brand"
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
      className="rounded-2xl bg-surface-container-lowest p-6 border border-border-brand"
      aria-label={labels.ariaLabel}
    >
      <h2 className="font-heading text-xl text-on-surface">{labels.title}</h2>
      <ol className="mt-4 space-y-4">
        {lastDonation ? (
          <TimelineItem
            icon={<FileText size={16} />}
            iconClassName="bg-primary-fixed text-on-primary-fixed-variant"
            title={labels.lastDonation(
              formatCurrency(lastDonation.amountCents, locale, lastDonation.currency),
            )}
            meta={formatDate(lastDonation.donatedAt, locale)}
          />
        ) : null}
        <TimelineItem
          icon={<Mail size={16} />}
          iconClassName="bg-secondary-fixed text-on-secondary-fixed-variant"
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
