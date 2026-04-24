"use client";

import { FormatRegistry } from "@sinclair/typebox";
import { PiggyBank, Plus } from "lucide-react";

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

import { CampaignCreateSchema } from "@givernance/shared/validators";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  type ControllerRenderProps,
  type DefaultValues,
  type Resolver,
  type UseFormReturn,
  useForm,
} from "react-hook-form";

import { AmountInput } from "@/components/shared/amount-input";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
} from "@/components/shared/form-field";
import { FormSection } from "@/components/shared/form-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { Campaign, CampaignCurrency, CampaignType } from "@/models/campaign";
import type { Fund } from "@/models/fund";
import { CampaignService } from "@/services/CampaignService";
import { FundService } from "@/services/FundService";

const CAMPAIGN_TYPES: readonly CampaignType[] = [
  "nominative_postal",
  "door_drop",
  "digital",
] as const;
const CAMPAIGN_CURRENCIES: readonly CampaignCurrency[] = ["EUR", "GBP", "CHF"] as const;

interface CampaignFormValues {
  name: string;
  type: CampaignType;
  defaultCurrency: CampaignCurrency;
  parentId: string;
  operationalCostCents: number | null;
  fundIds: string[];
}

type CreateMode = { mode: "create"; campaign?: undefined };
type EditMode = { mode: "edit"; campaign: Campaign };

export type CampaignFormProps = CreateMode | EditMode;

const EMPTY_PARENT = "__none__";
const CAMPAIGN_OPTION_PAGE_SIZE = 100;

export function CampaignForm(props: CampaignFormProps) {
  const { mode } = props;
  const router = useRouter();
  const t = useTranslations("campaigns.form");
  const tCampaigns = useTranslations("campaigns");
  const optionsLoadErrorMessage = t("errors.optionsLoad");

  const defaultValues: DefaultValues<CampaignFormValues> = {
    name: props.campaign?.name ?? "",
    type: props.campaign?.type ?? "digital",
    defaultCurrency: props.campaign?.defaultCurrency ?? "EUR",
    parentId: props.campaign?.parentId ?? "",
    operationalCostCents: props.campaign?.operationalCostCents ?? null,
    fundIds: [],
  };

  const form = useForm<CampaignFormValues>({
    mode: "onBlur",
    resolver: buildResolver(),
    defaultValues,
  });

  const [parentOptions, setParentOptions] = useState<Campaign[]>([]);
  const [fundOptions, setFundOptions] = useState<Fund[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [fundsLoading, setFundsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadOptions() {
      try {
        const { campaigns, funds, selectedFundIds } = await loadCampaignFormOptions(
          mode,
          props.campaign?.id,
        );
        if (!active) return;
        applyCampaignFormOptions({
          campaigns,
          funds,
          selectedFundIds,
          mode,
          campaignId: props.campaign?.id,
          form,
          setOptionsError,
          setParentOptions,
          setFundOptions,
        });
      } catch {
        if (!active) return;
        resetCampaignFormOptions({
          mode,
          optionsLoadError: optionsLoadErrorMessage,
          setOptionsError,
          setParentOptions,
          setFundOptions,
        });
      } finally {
        if (active) {
          setOptionsLoading(false);
          setFundsLoading(false);
        }
      }
    }

    void loadOptions();

    return () => {
      active = false;
    };
  }, [form, mode, optionsLoadErrorMessage, props.campaign?.id]);

  async function onSubmit(values: CampaignFormValues) {
    form.clearErrors("root");

    if (mode === "edit" && optionsError) {
      toast.error(optionsError);
      return;
    }

    try {
      if (mode === "create") {
        const created = await CampaignService.createCampaign(
          createClientApiClient(),
          toApiPayload(values),
        );
        toast.success(t("success.created"));
        router.push(`/campaigns/${created.id}`);
        router.refresh();
      } else {
        const updated = await CampaignService.updateCampaign(
          createClientApiClient(),
          props.campaign.id,
          toApiPayload(values),
        );
        toast.success(t("success.updated"));
        router.push(`/campaigns/${updated.id}`);
        router.refresh();
      }
    } catch (err) {
      console.error("FORM SUBMIT ERROR:", err);
      handleApiError(err, form, {
        validation: t("errors.validation"),
        generic: t("errors.generic"),
      });
    }
  }

  const isSubmitting = form.formState.isSubmitting;
  const rootError = form.formState.errors.root?.message;

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="rounded-2xl bg-surface-container-lowest px-5 shadow-card sm:px-6"
        noValidate
      >
        <FormSection
          title={t("sections.identity.title")}
          description={t("sections.identity.description")}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.name")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t("fields.namePlaceholder")}
                      maxLength={255}
                      aria-invalid={Boolean(form.formState.errors.name)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.type")}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger aria-invalid={Boolean(form.formState.errors.type)}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CAMPAIGN_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {tCampaigns(`types.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="defaultCurrency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.defaultCurrency")}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger aria-invalid={Boolean(form.formState.errors.defaultCurrency)}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CAMPAIGN_CURRENCIES.map((currency) => (
                        <SelectItem key={currency} value={currency}>
                          {currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-on-surface-variant">
                    {t("fields.defaultCurrencyHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormSection
          title={t("sections.structure.title")}
          description={t("sections.structure.description")}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <FormField
              control={form.control}
              name="parentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.parent")}</FormLabel>
                  <Select
                    value={field.value || EMPTY_PARENT}
                    onValueChange={(value) => field.onChange(value === EMPTY_PARENT ? "" : value)}
                  >
                    <FormControl>
                      <SelectTrigger aria-invalid={Boolean(form.formState.errors.parentId)}>
                        <SelectValue placeholder={t("fields.parentPlaceholder")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={EMPTY_PARENT}>{t("fields.parentPlaceholder")}</SelectItem>
                      {parentOptions.map((campaign) => (
                        <SelectItem key={campaign.id} value={campaign.id}>
                          {campaign.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-on-surface-variant">
                    {optionsLoading ? t("fields.parentLoading") : t("fields.parentHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="operationalCostCents"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.operationalCost")}</FormLabel>
                  <FormControl>
                    <AmountInput
                      value={field.value}
                      onChange={(nextValue) => field.onChange(nextValue)}
                      placeholder={t("fields.operationalCostPlaceholder")}
                    />
                  </FormControl>
                  <p className="text-xs text-on-surface-variant">
                    {t("fields.operationalCostHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormSection
          title={t("sections.funds.title")}
          description={t("sections.funds.description")}
        >
          <FormField
            control={form.control}
            name="fundIds"
            render={({ field }) => (
              <FormItem>
                <CampaignFundIdsField
                  field={field}
                  fundOptions={fundOptions}
                  fundsLoading={fundsLoading}
                  optionsError={optionsError}
                  t={t}
                />
              </FormItem>
            )}
          />
        </FormSection>

        <div className="flex flex-col gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-sm text-error">{rootError}</div>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="ghost">
              <Link href={mode === "edit" ? `/campaigns/${props.campaign.id}` : "/campaigns"}>
                {t("actions.cancel")}
              </Link>
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || (mode === "edit" && Boolean(optionsError))}
            >
              {isSubmitting
                ? t("actions.submitting")
                : mode === "create"
                  ? t("actions.submitCreate")
                  : t("actions.submitEdit")}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

function toApiPayload(values: CampaignFormValues) {
  return {
    name: values.name?.trim() ?? "",
    type: values.type,
    defaultCurrency: values.defaultCurrency,
    parentId: values.parentId?.trim() || null,
    operationalCostCents: values.operationalCostCents,
    fundIds: values.fundIds.map((value) => value.trim()).filter((value) => value !== ""),
  };
}

type TypeboxSchema = Parameters<typeof typeboxResolver>[0];

function buildResolver(): Resolver<CampaignFormValues> {
  const innerResolver = typeboxResolver(
    CampaignCreateSchema as TypeboxSchema,
  ) as unknown as Resolver<Record<string, unknown>>;

  const adapted: Resolver<CampaignFormValues> = async (values, context, options) => {
    const cleaned: Record<string, unknown> = {
      name: values.name?.trim() ?? "",
      type: values.type,
      defaultCurrency: values.defaultCurrency,
    };

    if (values.parentId?.trim() !== "") {
      cleaned.parentId = values.parentId?.trim();
    }
    if (values.operationalCostCents !== null) {
      cleaned.operationalCostCents = values.operationalCostCents;
    }
    cleaned.fundIds = values.fundIds.map((value) => value.trim()).filter((value) => value !== "");

    const result = await innerResolver(
      cleaned,
      context,
      options as unknown as Parameters<typeof innerResolver>[2],
    );
    return result as unknown as Awaited<ReturnType<Resolver<CampaignFormValues>>>;
  };

  return adapted;
}

function applyCampaignFormOptions({
  campaigns,
  funds,
  selectedFundIds,
  mode,
  campaignId,
  form,
  setOptionsError,
  setParentOptions,
  setFundOptions,
}: {
  campaigns: Campaign[];
  funds: Fund[];
  selectedFundIds: string[];
  mode: CampaignFormProps["mode"];
  campaignId?: string;
  form: UseFormReturn<CampaignFormValues>;
  setOptionsError: (value: string | null) => void;
  setParentOptions: (value: Campaign[]) => void;
  setFundOptions: (value: Fund[]) => void;
}) {
  setOptionsError(null);
  setParentOptions(
    campaigns.filter((campaign) => (mode === "edit" ? campaign.id !== campaignId : true)),
  );
  setFundOptions(funds);
  form.setValue("fundIds", selectedFundIds, { shouldDirty: false });
}

function resetCampaignFormOptions({
  mode,
  optionsLoadError,
  setOptionsError,
  setParentOptions,
  setFundOptions,
}: {
  mode: CampaignFormProps["mode"];
  optionsLoadError: string;
  setOptionsError: (value: string | null) => void;
  setParentOptions: (value: Campaign[]) => void;
  setFundOptions: (value: Fund[]) => void;
}) {
  setParentOptions([]);
  setFundOptions([]);
  setOptionsError(mode === "edit" ? optionsLoadError : null);
}

function CampaignFundIdsField({
  field,
  fundOptions,
  fundsLoading,
  optionsError,
  t,
}: {
  field: ControllerRenderProps<CampaignFormValues, "fundIds">;
  fundOptions: Fund[];
  fundsLoading: boolean;
  optionsError: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const { formItemId, formDescriptionId, formMessageId, error } = useFormField();
  const isInvalid = Boolean(error || optionsError);
  const describedBy = isInvalid ? `${formDescriptionId} ${formMessageId}` : formDescriptionId;

  return (
    <>
      <fieldset aria-describedby={describedBy} aria-invalid={isInvalid} className="space-y-3">
        <legend
          id={formItemId}
          className={
            isInvalid ? "text-sm font-medium text-error" : "text-sm font-medium text-on-surface"
          }
        >
          {t("fields.funds")}
        </legend>
        {fundsLoading ? (
          <p className="text-xs text-on-surface-variant">{t("fields.fundsLoading")}</p>
        ) : fundOptions.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {fundOptions.map((fund) => {
              const checked = field.value.includes(fund.id);
              const checkboxId = `campaign-fund-${fund.id}`;
              const descriptionId = `${checkboxId}-description`;
              return (
                <div
                  key={fund.id}
                  className="flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3"
                >
                  <Checkbox
                    id={checkboxId}
                    checked={checked}
                    onCheckedChange={(nextChecked) => {
                      const current = field.value;
                      if (nextChecked === true) {
                        field.onChange([...current, fund.id]);
                        return;
                      }
                      field.onChange(current.filter((value) => value !== fund.id));
                    }}
                    aria-describedby={`${formDescriptionId} ${descriptionId}`}
                    aria-invalid={isInvalid}
                    disabled={Boolean(optionsError)}
                  />
                  <div className="min-w-0">
                    <label htmlFor={checkboxId} className="block font-medium text-on-surface">
                      {fund.name}
                    </label>
                    <span id={descriptionId} className="block text-xs text-on-surface-variant">
                      {t(`fundTypeHint.${fund.type}`)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={PiggyBank}
            title={t("fields.fundsEmptyTitle")}
            description={t("fields.fundsEmptyDescription")}
            className="rounded-2xl border border-dashed border-outline-variant bg-surface-container-low px-6 py-10"
            action={
              <Button asChild size="sm">
                <Link href="/settings/funds">
                  <Plus size={16} aria-hidden="true" />
                  {t("actions.createFund")}
                </Link>
              </Button>
            }
          />
        )}
      </fieldset>
      <FormDescription>{t("fields.fundsHint")}</FormDescription>
      <FormMessage>{optionsError}</FormMessage>
    </>
  );
}

interface ErrorMessages {
  validation: string;
  generic: string;
}

function handleApiError(
  err: unknown,
  form: UseFormReturn<CampaignFormValues>,
  messages: ErrorMessages,
) {
  if (err instanceof ApiProblem) {
    if (err.status === 422 || err.status === 400) {
      form.setError("root", { type: "server", message: err.detail ?? messages.validation });
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

async function loadCampaignFormOptions(mode: CampaignFormProps["mode"], campaignId?: string) {
  const client = createClientApiClient();
  const [campaignsResult, fundsResult, selectedFunds] = await Promise.all([
    CampaignService.listCampaigns(client, {
      perPage: CAMPAIGN_OPTION_PAGE_SIZE,
    }),
    FundService.listFunds(client, { perPage: CAMPAIGN_OPTION_PAGE_SIZE }),
    mode === "edit" && campaignId
      ? FundService.listCampaignFunds(client, campaignId)
      : Promise.resolve([]),
  ]);

  return {
    campaigns: campaignsResult.data,
    funds: fundsResult.data,
    selectedFundIds: selectedFunds.map((fund) => fund.id),
  };
}
