"use client";

import {
  CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES,
  CampaignPublicPageSchema,
} from "@givernance/shared/validators";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { Eye, Globe, Palette, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type DefaultValues,
  type Resolver,
  type UseFormReturn,
  useForm,
  useWatch,
} from "react-hook-form";

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
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency } from "@/lib/format";
import type { Campaign } from "@/models/campaign";
import type { CampaignPublicPage, PublicPageStatus } from "@/models/public-page";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";

interface CampaignPublicPageFormProps {
  campaign: Campaign;
  initialPage: CampaignPublicPage | null;
}

interface CampaignPublicPageFormValues {
  title: string;
  description: string;
  colorPrimary: ThemeColorValue;
  goalAmountCents: number | null;
  status: PublicPageStatus;
}

type ThemeColorValue = (typeof CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES)[number];
type ThemeColorLabelKey = "primary" | "secondary" | "tertiary" | "emerald" | "slate";

const DEFAULT_THEME_COLOR = CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES[0];

const THEME_COLORS: Array<{ value: ThemeColorValue; labelKey: ThemeColorLabelKey }> = [
  { value: "#096447", labelKey: "primary" },
  { value: "#006C48", labelKey: "secondary" },
  { value: "#864700", labelKey: "tertiary" },
  { value: "#005138", labelKey: "emerald" },
  { value: "#3F4943", labelKey: "slate" },
];

export function CampaignPublicPageForm({ campaign, initialPage }: CampaignPublicPageFormProps) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("campaigns.publicPage");
  const tCampaigns = useTranslations("campaigns");

  const defaultValues: DefaultValues<CampaignPublicPageFormValues> = {
    title: initialPage?.title ?? campaign.name,
    description: initialPage?.description ?? "",
    colorPrimary: normalizeThemeColor(initialPage?.colorPrimary),
    goalAmountCents: initialPage?.goalAmountCents ?? campaign.costCents ?? null,
    status: initialPage?.status ?? "draft",
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

    try {
      await CampaignPublicPageService.upsertCampaignPublicPage(
        createClientApiClient(),
        campaign.id,
        toApiPayload(values),
      );
      toast.success(values.status === "published" ? t("success.published") : t("success.saved"));
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
          className="rounded-2xl bg-surface-container-lowest px-6 shadow-card"
          noValidate
        >
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
                        onChange={field.onChange}
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
        goalAmountCents={normalizeGoalAmount(previewValues.goalAmountCents)}
        fallbackGoalAmountCents={campaign.costCents}
        fallbackTypeLabel={tCampaigns(`types.${campaign.type}`)}
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
}: CampaignPublicPagePreviewProps) {
  const t = useTranslations("campaigns.publicPage.preview");
  const effectiveGoal = goalAmountCents ?? fallbackGoalAmountCents;
  const safeColor = normalizeThemeColor(colorPrimary);
  const onColor = getReadableTextColor(safeColor);

  return (
    <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-card">
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
            className="px-6 py-5"
            style={{
              background: `linear-gradient(135deg, ${safeColor}, color-mix(in srgb, ${safeColor} 55%, #0B1220))`,
              color: onColor,
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <Badge
                className="border border-white/15 bg-white/15"
                shape="square"
                style={{ color: onColor }}
              >
                <Globe size={12} aria-hidden="true" />
                {t("live")}
              </Badge>
              <span className="text-xs font-medium uppercase tracking-[0.16em] opacity-80">
                {fallbackTypeLabel}
              </span>
            </div>
            <h3 className="mt-5 font-heading text-3xl leading-tight">{title}</h3>
            <p className="mt-3 max-w-[28rem] text-sm leading-6 opacity-90">
              {description || t("descriptionFallback")}
            </p>
          </div>

          <div className="space-y-5 p-6">
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
                    className="rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-3 text-left font-medium text-on-surface"
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

interface AmountInputProps {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  placeholder?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

function AmountInput({
  value,
  onChange,
  placeholder,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: AmountInputProps) {
  const [raw, setRaw] = useState<string>(() => centsToDisplay(value));
  const lastValueRef = useRef<number | null | undefined>(value);

  useEffect(() => {
    if (!Object.is(value, lastValueRef.current)) {
      lastValueRef.current = value;
      setRaw(centsToDisplay(value));
    }
  }, [value]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-variant">
        €
      </span>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        value={raw}
        placeholder={placeholder}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className="pl-7 font-mono tabular-nums"
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          const parsed = parseAmount(next);
          const nextValue = parsed.isValid ? sanitizeGoalAmount(parsed.value) : Number.NaN;
          lastValueRef.current = nextValue;
          onChange(nextValue);
        }}
        onBlur={() => {
          const parsed = parseAmount(raw);
          if (!parsed.isValid) {
            lastValueRef.current = Number.NaN;
            onChange(Number.NaN);
            return;
          }

          const nextValue = sanitizeGoalAmount(parsed.value);
          lastValueRef.current = nextValue;
          onChange(nextValue);
          setRaw(centsToDisplay(nextValue));
        }}
      />
    </div>
  );
}

function centsToDisplay(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return (value / 100).toFixed(2);
}

function parseAmount(raw: string): { value: number | null; isValid: boolean } {
  const trimmed = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (trimmed === "") return { value: null, isValid: true };
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) {
    return { value: null, isValid: false };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, isValid: false };
  }

  return { value: Math.round(parsed * 100), isValid: true };
}

function getReadableTextColor(hex: string): "#FFFFFF" | "#111827" {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#FFFFFF";
}

function toApiPayload(values: CampaignPublicPageFormValues) {
  return {
    title: values.title?.trim() ?? "",
    description: values.description?.trim() || null,
    colorPrimary: values.colorPrimary,
    goalAmountCents: sanitizeGoalAmount(values.goalAmountCents),
    status: values.status,
  };
}

type TypeboxSchema = Parameters<typeof typeboxResolver>[0];

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

    const cleaned: Record<string, unknown> = {
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
      cleaned,
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

function normalizeGoalAmount(value: number | null | undefined): number | null {
  return sanitizeGoalAmount(value);
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

const API_FIELD_NAMES = ["title", "description", "colorPrimary", "goalAmountCents", "status"] as const;

function applyFieldErrors(form: UseFormReturn<CampaignPublicPageFormValues>, raw: unknown): boolean {
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
        message: applied ? messages.validation : err.detail ?? messages.validation,
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
