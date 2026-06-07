"use client";

import type { PublicPageStyleKey } from "@givernance/shared/constants";
import {
  CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES,
  CampaignPublicPageSchema,
} from "@givernance/shared/validators";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { Copy, ExternalLink, Eye, Globe, Palette, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  type DefaultValues,
  type Resolver,
  type UseFormReturn,
  useForm,
  useWatch,
} from "react-hook-form";

import { ArchetypeRenderer } from "@/components/campaigns/archetype-renderer";
import { CampaignPublicPageStyleSection } from "@/components/campaigns/campaign-public-page-style-section";

import { AmountInput } from "@/components/shared/amount-input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
import { FormSection } from "@/components/shared/form-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency } from "@/lib/format";
import type { Campaign } from "@/models/campaign";
import type { CampaignPublicPage, PublicPageStatus } from "@/models/public-page";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";

interface CampaignPublicPageFormProps {
  campaign: Campaign;
  initialPage: CampaignPublicPage | null;
  /**
   * Whether `donation.public_page_styles` is enabled for this tenant.
   * Resolved SSR-side from the public projection so the picker is
   * hidden when the flag is off — matches the field-level PUT gate
   * on the API. When `false`, the section is not rendered AND the
   * submit payload omits `publicPageStyle` (the API would 400 it).
   */
  publicPageStylesEnabled: boolean;
}

interface CampaignPublicPageFormValues {
  title: string;
  description: string;
  colorPrimary: ThemeColorValue;
  goalAmountCents: number | null;
  status: PublicPageStatus;
  /**
   * Per-campaign archetype override (Epic #362). `null` = inherit
   * the tenant default (or platform default if that's also null).
   * Tri-state on the wire (`undefined` = unchanged, `null` = clear,
   * `<key>` = set) is enforced inside `toApiPayload` based on whether
   * the picker is even shown.
   */
  publicPageStyle: PublicPageStyleKey | null;
}

type ThemeColorValue = (typeof CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES)[number];
type ThemeColorLabelKey = "primary" | "secondary" | "tertiary" | "emerald" | "slate";

const DEFAULT_THEME_COLOR = CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES[0];

const THEME_COLORS: Array<{ value: ThemeColorValue; labelKey: ThemeColorLabelKey }> = [
  { value: "#08675b", labelKey: "primary" },
  { value: "#0a6b5e", labelKey: "secondary" },
  { value: "#864700", labelKey: "tertiary" },
  { value: "#00514a", labelKey: "emerald" },
  { value: "#3F4943", labelKey: "slate" },
];

export function CampaignPublicPageForm({
  campaign,
  initialPage,
  publicPageStylesEnabled,
}: CampaignPublicPageFormProps) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("campaigns.publicPage");
  const tCampaigns = useTranslations("campaigns");
  const tStyle = useTranslations("campaigns.publicPage.styleSection");

  const defaultValues: DefaultValues<CampaignPublicPageFormValues> = {
    title: initialPage?.title ?? campaign.name,
    description: initialPage?.description ?? "",
    colorPrimary: normalizeThemeColor(initialPage?.colorPrimary),
    goalAmountCents: initialPage?.goalAmountCents ?? campaign.goalAmountCents ?? null,
    status: initialPage?.status ?? "draft",
    publicPageStyle: initialPage?.publicPageStyle ?? null,
  };

  const form = useForm<CampaignPublicPageFormValues>({
    mode: "onBlur",
    resolver: buildResolver({
      goalAmountInvalid: t("errors.goalAmountInvalid"),
      colorInvalid: t("errors.colorInvalid"),
    }),
    defaultValues,
  });

  const previewValues = useWatch({ control: form.control }) as CampaignPublicPageFormValues;

  async function onSubmit(values: CampaignPublicPageFormValues) {
    form.clearErrors("root");

    // `publicPageStyle` is intentionally not in the resolver's output
    // (see the buildResolver note about `Type.Unsafe`), so pull it from
    // the live form state to be sure it reaches the API payload.
    const submitValues: CampaignPublicPageFormValues = {
      ...values,
      publicPageStyle: form.getValues("publicPageStyle"),
    };

    try {
      await CampaignPublicPageService.upsertCampaignPublicPage(
        createClientApiClient(),
        campaign.id,
        toApiPayload(submitValues, publicPageStylesEnabled),
      );
      toast.success(values.status === "published" ? t("success.published") : t("success.saved"));
      // Re-baseline the form so `isDirty` flips back to false — without
      // this, the "View public page" tooltip-guard stays disabled after
      // a successful save (the user would have to hard-refresh to get a
      // working link). We reset to `form.getValues()` — the COMPLETE live
      // form state — rather than `submitValues`: the resolver output drops
      // null/empty fields (`goalAmountCents`, `description`), so a baseline
      // built from it would never match the live values and `isDirty` would
      // stay true. `getValues()` carries every field (incl. the freshly
      // saved `publicPageStyle`) at its real value, so defaults == values
      // and `isDirty` reliably clears.
      form.reset(form.getValues());
      router.refresh();
    } catch (err) {
      if (err instanceof ApiProblem) {
        console.error("API SUBMIT ERROR", err, err.detail, err.status);
      } else {
        console.error("API SUBMIT ERROR", err);
      }
      handleApiError(err, form, {
        validation: t("errors.validation"),
        generic: t("errors.generic"),
      });
    }
  }

  const rootError = form.formState.errors.root?.message;
  const isSubmitting = form.formState.isSubmitting;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="rounded-2xl bg-surface-container-lowest px-5 shadow-card sm:px-6"
          noValidate
        >
          {publicPageStylesEnabled ? (
            <FormField
              control={form.control}
              name="publicPageStyle"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <CampaignPublicPageStyleSection
                      value={field.value}
                      onChange={field.onChange}
                      labels={{
                        title: tStyle("title"),
                        description: tStyle("description"),
                        clear: tStyle("clear"),
                        inheritsBadge: tStyle("inheritsBadge"),
                        comingSoonBadge: tStyle("comingSoonBadge"),
                        voice: {
                          institutional: tStyle("voice.institutional"),
                          expressive: tStyle("voice.expressive"),
                          editorial: tStyle("voice.editorial"),
                          minimal: tStyle("voice.minimal"),
                          civic: tStyle("voice.civic"),
                        },
                      }}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          ) : null}

          <FormSection
            title={t("sections.content.title")}
            description={t("sections.content.description")}
          >
            <div className="grid gap-5">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("fields.title")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t("fields.titlePlaceholder")}
                        maxLength={255}
                      />
                    </FormControl>
                    <FormDescription>{t("fields.titleHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.description")}</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        rows={6}
                        placeholder={t("fields.descriptionPlaceholder")}
                        maxLength={5000}
                      />
                    </FormControl>
                    <FormDescription>{t("fields.descriptionHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </FormSection>

          <FormSection
            title={t("sections.presentation.title")}
            description={t("sections.presentation.description")}
          >
            <div className="grid gap-5 md:grid-cols-2">
              <FormField
                control={form.control}
                name="goalAmountCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.goal")}</FormLabel>
                    <FormControl>
                      <AmountInput
                        value={field.value}
                        onChange={(nextValue, meta) =>
                          field.onChange(meta.isValid ? nextValue : (Number.NaN as number))
                        }
                        placeholder={t("fields.goalPlaceholder")}
                      />
                    </FormControl>
                    <FormDescription>{t("fields.goalHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("fields.status")}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="draft">{t("status.draft")}</SelectItem>
                        <SelectItem value="published">{t("status.published")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>{t("fields.statusHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="colorPrimary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.color")}</FormLabel>
                  <Select
                    value={normalizeThemeColor(field.value)}
                    onValueChange={(value) => field.onChange(value as ThemeColorValue)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {THEME_COLORS.map((color) => (
                        <SelectItem key={color.value} value={color.value}>
                          <span className="flex items-center gap-3">
                            <span
                              className="h-3.5 w-3.5 rounded-full border border-outline-variant"
                              style={{ backgroundColor: color.value }}
                              aria-hidden="true"
                            />
                            <span>{getThemeColorLabel(t, color.labelKey)}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t("fields.colorHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FormSection>

          <div className="flex flex-col gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-h-5 text-sm text-error">{rootError}</div>
            <div className="flex flex-wrap items-center gap-3">
              <PublicPageShareActions
                campaignId={campaign.id}
                initialStatus={initialPage?.status ?? "draft"}
                hasUnsavedChanges={form.formState.isDirty}
              />
              <Button asChild variant="ghost">
                <Link href={`/campaigns/${campaign.id}`}>{t("actions.back")}</Link>
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                <Save size={16} aria-hidden="true" />
                {isSubmitting ? t("actions.submitting") : t("actions.save")}
              </Button>
            </div>
          </div>
        </form>
      </Form>

      <CampaignPublicPagePreview
        campaign={campaign}
        locale={locale}
        status={previewValues.status ?? "draft"}
        title={(previewValues.title || campaign.name).trim()}
        description={previewValues.description?.trim() || ""}
        colorPrimary={normalizeThemeColor(previewValues.colorPrimary)}
        goalAmountCents={sanitizeGoalAmount(previewValues.goalAmountCents)}
        fallbackGoalAmountCents={campaign.goalAmountCents}
        fallbackTypeLabel={tCampaigns(`types.${campaign.type}`)}
        publicPageStyle={publicPageStylesEnabled ? (previewValues.publicPageStyle ?? null) : null}
      />
    </div>
  );
}

interface CampaignPublicPagePreviewProps {
  campaign: Campaign;
  locale: string;
  status: PublicPageStatus;
  title: string;
  description: string;
  colorPrimary: string;
  goalAmountCents: number | null;
  fallbackGoalAmountCents: number | null;
  fallbackTypeLabel: string;
  /**
   * Epic #362 — when set, the preview swaps its hand-built mockup
   * out for the **actual archetype** rendered via `<ArchetypeRenderer>`
   * with form-derived `ArchetypePageData`. `null` keeps the original
   * static preview (the donor today sees the hardcoded layout).
   */
  publicPageStyle: PublicPageStyleKey | null;
}

function CampaignPublicPagePreview({
  campaign,
  locale,
  status,
  title,
  description,
  colorPrimary,
  goalAmountCents,
  fallbackGoalAmountCents,
  fallbackTypeLabel,
  publicPageStyle,
}: CampaignPublicPagePreviewProps) {
  const t = useTranslations("campaigns.publicPage.preview");
  const effectiveGoal = goalAmountCents ?? fallbackGoalAmountCents;
  const safeColor = normalizeThemeColor(colorPrimary);
  const onColor = getReadableTextColor(safeColor);

  // Live archetype branch — render the operator's picked style with
  // form-derived data so changes to the title / colour / goal flow
  // through immediately. The Stripe form is replaced by a minimal
  // mockup since the preview shouldn't load Stripe Elements (no
  // tenant onboarding, no PaymentIntents, and donor-only side-
  // effects shouldn't fire from inside an editor preview).
  if (publicPageStyle !== null) {
    return (
      <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        <section className="rounded-2xl bg-surface-container-lowest p-3 shadow-card">
          <div className="mb-3 flex items-center justify-between gap-3 px-2">
            <h2 className="font-heading text-base text-on-surface">{t("title")}</h2>
            <Badge variant={status === "published" ? "success" : "neutral"}>
              {status === "published" ? t("published") : t("draft")}
            </Badge>
          </div>
          <div className="archetype-preview overflow-hidden rounded-xl border border-outline-variant bg-surface">
            <ArchetypeRenderer
              styleKey={publicPageStyle}
              data={{
                campaignId: campaign.id,
                title: title || campaign.name,
                description: description || null,
                colorPrimary: safeColor,
                goalAmountCents: effectiveGoal,
                raisedCents: 0,
                donorCount: 0,
                defaultCurrency: campaign.defaultCurrency as "EUR" | "GBP" | "CHF",
                // Preview-side has no access to the real tenant org name —
                // empty string is the donor-page convention (matches the
                // `page.organisationName ?? ""` fallback in `/p/[id]`), and
                // the archetype slots truthy-check it to skip avatar +
                // eyebrow. Avoids the "campaign name shown 3×" preview bug.
                organisationName: "",
                organisationMission: null,
                organisationLogoUrl: null,
                publicPageStyle,
              }}
              formNode={
                // Card chrome lives in each archetype's `AmountPicker`
                // slot (e.g. `.calm-form`, `.activist-form`). The
                // formNode is content-only so the archetype's chrome
                // isn't doubled by a nested generic card.
                <>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] opacity-80">
                    {t("donationCardLabel")}
                  </p>
                  <p className="mt-2 text-sm opacity-90">{t("donationCardBody")}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {[25, 50, 100].map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        className="rounded-xl border border-current/20 bg-current/5 px-3 py-2 text-center text-base font-semibold"
                        disabled
                      >
                        {new Intl.NumberFormat(locale, {
                          style: "currency",
                          currency: "EUR",
                          maximumFractionDigits: 0,
                        }).format(amount)}
                      </button>
                    ))}
                  </div>
                  <Button
                    className="mt-3 w-full"
                    style={{ backgroundColor: safeColor, color: onColor }}
                    disabled
                  >
                    {t("cta")}
                  </Button>
                </>
              }
            />
          </div>
          <p className="mt-2 px-2 text-xs text-on-surface-variant">{t("description")}</p>
        </section>
      </aside>
    );
  }

  return (
    <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
      <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-heading text-xl text-on-surface">{t("title")}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">{t("description")}</p>
          </div>
          <Badge variant={status === "published" ? "success" : "neutral"}>
            {status === "published" ? t("published") : t("draft")}
          </Badge>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-outline-variant bg-surface shadow-card">
          <div
            className="px-5 py-5 sm:px-6"
            style={{
              background: `linear-gradient(135deg, ${safeColor}, color-mix(in srgb, ${safeColor} 55%, #0B1220))`,
              color: onColor,
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] border border-white/15 bg-white/15 px-2 py-[2px] font-mono text-xs font-bold leading-[1.4]"
                style={{ color: onColor }}
              >
                <Globe size={12} aria-hidden="true" />
                {t("live")}
              </div>
              <span className="text-xs font-medium uppercase tracking-[0.16em] opacity-80">
                {fallbackTypeLabel}
              </span>
            </div>
            <h3 className="mt-5 font-heading text-3xl leading-tight">{title}</h3>
            <p className="mt-3 max-w-[28rem] text-sm leading-6 opacity-90">
              {description || t("descriptionFallback")}
            </p>
          </div>

          <div className="space-y-5 p-5 sm:p-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <PreviewMetric
                label={t("campaign")}
                value={campaign.name}
                icon={<Palette size={14} aria-hidden="true" />}
              />
              <PreviewMetric
                label={t("goal")}
                value={
                  effectiveGoal === null ? t("goalFallback") : formatCurrency(effectiveGoal, locale)
                }
                icon={<Eye size={14} aria-hidden="true" />}
              />
            </div>

            <div className="rounded-2xl border border-outline-variant bg-surface-container-low p-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-on-surface-variant">
                {t("donationCardLabel")}
              </p>
              <p className="mt-2 text-sm text-on-surface-variant">{t("donationCardBody")}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {[25, 50, 100].map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    className="rounded-2xl border border-outline-variant bg-surface px-4 py-5 text-center text-xl font-semibold text-on-surface"
                  >
                    {new Intl.NumberFormat(locale, {
                      style: "currency",
                      currency: "EUR",
                      maximumFractionDigits: 0,
                    }).format(amount)}
                  </button>
                ))}
              </div>
              <Button
                className="mt-4 w-full"
                style={{ backgroundColor: safeColor, color: onColor }}
              >
                {t("cta")}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </aside>
  );
}

function PreviewMetric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-low p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-on-surface-variant">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-3 text-sm font-medium text-on-surface">{value}</p>
    </div>
  );
}

function PublicPageShareActions({
  campaignId,
  initialStatus,
  hasUnsavedChanges,
}: {
  campaignId: string;
  initialStatus: PublicPageStatus;
  /**
   * `react-hook-form`'s `isDirty` for the editor. When true, the live
   * public page still serves the *last saved* version — so opening
   * `/p/[id]` would show the donor a stale render and mislead the
   * operator into thinking their picker change didn't take effect.
   * We disable "View public page" with a tooltip explaining why.
   */
  hasUnsavedChanges: boolean;
}) {
  const t = useTranslations("campaigns.publicPage");
  const publicPath = `/p/${campaignId}`;

  // Only show the buttons if the page is currently saved as published in the database,
  // not just because the user toggled the dropdown in the form locally.
  if (initialStatus !== "published") return null;

  async function copyPublicLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${publicPath}`);
      toast.success(t("success.linkCopied"));
    } catch {
      toast.error(t("errors.copyLink"));
    }
  }

  return (
    <>
      {hasUnsavedChanges ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapper span lets the tooltip stay reachable even
                  while the button is disabled (pointer-events: none on
                  a disabled <button> would swallow the hover/focus). */}
              <span className="inline-flex">
                <Button type="button" variant="secondary" disabled aria-disabled="true">
                  <ExternalLink size={16} aria-hidden="true" />
                  {t("actions.viewLive")}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{t("actions.viewLiveDirtyTooltip")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <Button asChild variant="secondary">
          <Link href={publicPath} target="_blank" rel="noreferrer">
            <ExternalLink size={16} aria-hidden="true" />
            {t("actions.viewLive")}
          </Link>
        </Button>
      )}
      <Button type="button" variant="ghost" onClick={copyPublicLink}>
        <Copy size={16} aria-hidden="true" />
        {t("actions.copyLink")}
      </Button>
    </>
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

function toApiPayload(values: CampaignPublicPageFormValues, publicPageStylesEnabled: boolean) {
  const base: {
    title: string;
    description: string | null;
    colorPrimary: ThemeColorValue;
    goalAmountCents: number | null;
    status: PublicPageStatus;
    publicPageStyle?: PublicPageStyleKey | null;
  } = {
    title: values.title?.trim() ?? "",
    description: values.description?.trim() || null,
    colorPrimary: values.colorPrimary,
    goalAmountCents: sanitizeGoalAmount(values.goalAmountCents),
    status: values.status,
  };
  // Tri-state on `publicPageStyle`:
  //   - flag off → omit (the API would 400 it anyway; field-level gate)
  //   - flag on → include, even when null (explicit clear)
  if (publicPageStylesEnabled) {
    base.publicPageStyle = values.publicPageStyle;
  }
  return base;
}

type TypeboxSchema = Parameters<typeof typeboxResolver>[0];

/**
 * Shape passed to the inner TypeBox resolver — explicitly excludes
 * `publicPageStyle`. Re-adding the field is a TS error rather than a
 * silent regression. See the `// We deliberately do NOT pass…` note
 * in `buildResolver` below.
 */
interface ResolverCleaned {
  title: string;
  colorPrimary: ThemeColorValue;
  status: PublicPageStatus;
  description?: string;
  goalAmountCents?: number;
}

interface ResolverMessages {
  goalAmountInvalid: string;
  colorInvalid: string;
}

function buildResolver(messages: ResolverMessages): Resolver<CampaignPublicPageFormValues> {
  const innerResolver = typeboxResolver(
    CampaignPublicPageSchema as TypeboxSchema,
  ) as unknown as Resolver<Record<string, unknown>>;

  const adapted: Resolver<CampaignPublicPageFormValues> = async (values, context, options) => {
    const normalizedColor = normalizeThemeColor(values.colorPrimary);
    const sanitizedGoalAmount = sanitizeGoalAmount(values.goalAmountCents);

    if (values.goalAmountCents !== null && Number.isNaN(values.goalAmountCents)) {
      return {
        values: {},
        errors: {
          goalAmountCents: {
            type: "validate",
            message: messages.goalAmountInvalid,
          },
        },
      };
    }

    if (normalizedColor !== values.colorPrimary) {
      return {
        values: {},
        errors: {
          colorPrimary: {
            type: "validate",
            message: messages.colorInvalid,
          },
        },
      };
    }

    // We deliberately do NOT pass `publicPageStyle` through the inner
    // TypeBox resolver. The schema uses `Type.Unsafe` for the enum,
    // which @hookform/resolvers/typebox's compiler doesn't recognise
    // and throws "Unknown type" on. The picker UI already constrains
    // the value to one of `PUBLIC_PAGE_STYLE_KEYS` (or null), and the
    // server re-validates on receipt — so it's read directly from
    // `form.getValues("publicPageStyle")` inside `onSubmit`.
    //
    // The TS-level guard: `ResolverCleaned` explicitly omits
    // `publicPageStyle`. Re-adding the field here is a compile-time
    // error, not a silent runtime regression.
    const cleaned: ResolverCleaned = {
      title: values.title?.trim() ?? "",
      colorPrimary: normalizedColor,
      status: values.status,
    };

    if (values.description && values.description.trim() !== "") {
      cleaned.description = values.description.trim();
    }
    if (sanitizedGoalAmount !== null) {
      cleaned.goalAmountCents = sanitizedGoalAmount;
    }

    const result = await innerResolver(
      cleaned as unknown as Record<string, unknown>,
      context,
      options as unknown as Parameters<typeof innerResolver>[2],
    );
    return result as unknown as Awaited<ReturnType<Resolver<CampaignPublicPageFormValues>>>;
  };

  return adapted;
}

function normalizeThemeColor(value: string | null | undefined): ThemeColorValue {
  if (value && CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES.includes(value as ThemeColorValue)) {
    return value as ThemeColorValue;
  }

  return DEFAULT_THEME_COLOR;
}

function sanitizeGoalAmount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getThemeColorLabel(
  t: ReturnType<typeof useTranslations<"campaigns.publicPage">>,
  labelKey: ThemeColorLabelKey,
): string {
  switch (labelKey) {
    case "primary":
      return t("fields.colorOptions.primary");
    case "secondary":
      return t("fields.colorOptions.secondary");
    case "tertiary":
      return t("fields.colorOptions.tertiary");
    case "emerald":
      return t("fields.colorOptions.emerald");
    case "slate":
      return t("fields.colorOptions.slate");
  }
}

interface ErrorMessages {
  validation: string;
  generic: string;
}

const API_FIELD_NAMES = [
  "title",
  "description",
  "colorPrimary",
  "goalAmountCents",
  "status",
] as const;

function applyFieldErrors(
  form: UseFormReturn<CampaignPublicPageFormValues>,
  raw: unknown,
): boolean {
  if (!raw || typeof raw !== "object") return false;

  let applied = false;
  for (const name of API_FIELD_NAMES) {
    const value = (raw as Record<string, unknown>)[name];
    const message = typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
    if (typeof message !== "string") continue;
    form.setError(name, { type: "server", message });
    applied = true;
  }

  return applied;
}

function handleApiError(
  err: unknown,
  form: UseFormReturn<CampaignPublicPageFormValues>,
  messages: ErrorMessages,
) {
  if (err instanceof ApiProblem) {
    if (err.status === 422 || err.status === 400) {
      const applied = applyFieldErrors(form, err.extensions.fieldErrors);
      form.setError("root", {
        type: "server",
        message: applied ? messages.validation : (err.detail ?? messages.validation),
      });
      return;
    }
    form.setError("root", {
      type: "server",
      message: err.detail ?? err.title ?? messages.generic,
    });
    return;
  }

  form.setError("root", { type: "server", message: messages.generic });
}
