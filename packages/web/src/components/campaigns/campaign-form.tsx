"use client";

import { FormatRegistry } from "@sinclair/typebox";
import { PiggyBank, Plus } from "lucide-react";

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

import type { CustomFieldDefinition, CustomFieldValue } from "@givernance/shared/custom-fields";
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
import {
  buildCustomFieldPatch,
  CustomFieldsSection,
  extractCustomFieldErrors,
  initialCustomValues,
  missingRequiredCustomKeys,
} from "@/components/shared/custom-fields";
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
import { FormStickyFooter } from "@/components/shared/form-sticky-footer";
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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { BankAccount } from "@/models/bank-account";
import type {
  Campaign,
  CampaignCurrency,
  CampaignQrReferenceMode,
  CampaignType,
} from "@/models/campaign";
import type { Fund } from "@/models/fund";
import { BankAccountService } from "@/services/BankAccountService";
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
  /**
   * Free-form admin description (Epic #274 follow-up). Drives the
   * postal-letter body and seeds the public donation page on first
   * publish. Empty-string in the form maps to NULL on the API.
   */
  description: string;
  type: CampaignType;
  defaultCurrency: CampaignCurrency;
  parentId: string;
  operationalCostCents: number | null;
  goalAmountCents: number | null;
  fundIds: string[];
  /**
   * Epic #318 — Swiss QR-bill picker. Sentinel `__none__` = no bank
   * account linked (standard postal mode). Any other value is a
   * `bank_accounts.id` from the operator's Settings → Bank Accounts.
   */
  bankAccountId: string;
  /** `auto` lets the worker derive the type from `bank_accounts.iban_kind`. */
  qrReferenceMode: CampaignQrReferenceMode;
}

type CreateMode = { mode: "create"; campaign?: undefined };
type EditMode = { mode: "edit"; campaign: Campaign };

export type CampaignFormProps = (CreateMode | EditMode) & {
  /**
   * Active campaign-domain custom-field definitions (Epic #539), SSR-fetched
   * by the page when `campaigns.custom_fields` is on. Empty (the default) ⇒
   * the custom-fields section is completely absent.
   */
  customFieldDefs?: CustomFieldDefinition[];
};

const EMPTY_PARENT = "__none__";
/** Same sentinel pattern as `EMPTY_PARENT`; ‘None’ = unlinked / no Swiss QR-bill. */
const EMPTY_BANK_ACCOUNT = "__none__";
const CAMPAIGN_OPTION_PAGE_SIZE = 100;
const QR_REFERENCE_MODES: readonly CampaignQrReferenceMode[] = ["auto", "qrr", "scor"];

export function CampaignForm(props: CampaignFormProps) {
  const { mode, customFieldDefs = [] } = props;
  const router = useRouter();
  const t = useTranslations("campaigns.form");
  const tCampaigns = useTranslations("campaigns");
  const tCustom = useTranslations("customFields");
  const optionsLoadErrorMessage = t("errors.optionsLoad");

  // Epic #539 — custom values live outside react-hook-form (controlled map;
  // server registry is the authoritative validator).
  const [initialCustom] = useState<Record<string, CustomFieldValue>>(() =>
    initialCustomValues(customFieldDefs, props.campaign?.custom),
  );
  const [customValues, setCustomValues] = useState<Record<string, CustomFieldValue>>(() => ({
    ...initialCustom,
  }));
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});

  const handleCustomChange = (key: string, value: CustomFieldValue | null) => {
    setCustomValues((prev) => {
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
    setCustomErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const prepareCustomPatch = (): { ok: boolean; patch?: Record<string, unknown> } => {
    if (customFieldDefs.length === 0) return { ok: true };
    if (mode === "create") {
      const missing = missingRequiredCustomKeys(customFieldDefs, customValues);
      if (missing.length > 0) {
        setCustomErrors(
          Object.fromEntries(missing.map((key) => [key, tCustom("form.requiredMissing")])),
        );
        return { ok: false };
      }
    }
    return {
      ok: true,
      patch: buildCustomFieldPatch(
        mode === "create" ? {} : initialCustom,
        customValues,
        customFieldDefs,
      ),
    };
  };

  const defaultValues: DefaultValues<CampaignFormValues> = {
    name: props.campaign?.name ?? "",
    description: props.campaign?.description ?? "",
    type: props.campaign?.type ?? "digital",
    defaultCurrency: props.campaign?.defaultCurrency ?? "EUR",
    parentId: props.campaign?.parentId ?? "",
    operationalCostCents: props.campaign?.operationalCostCents ?? null,
    goalAmountCents: props.campaign?.goalAmountCents ?? null,
    fundIds: [],
    bankAccountId: props.campaign?.bankAccountId ?? EMPTY_BANK_ACCOUNT,
    qrReferenceMode: props.campaign?.qrReferenceMode ?? "auto",
  };

  const form = useForm<CampaignFormValues>({
    mode: "onBlur",
    resolver: buildResolver(),
    defaultValues,
  });

  const [parentOptions, setParentOptions] = useState<Campaign[]>([]);
  const [fundOptions, setFundOptions] = useState<Fund[]>([]);
  /** Epic #318 — Swiss QR-bill picker source list (Settings → Bank Accounts). */
  const [bankAccountOptions, setBankAccountOptions] = useState<BankAccount[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [fundsLoading, setFundsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadOptions() {
      try {
        const { campaigns, funds, selectedFundIds, bankAccountsForOrg } =
          await loadCampaignFormOptions(mode, props.campaign?.id);
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
        setBankAccountOptions(bankAccountsForOrg);
      } catch {
        if (!active) return;
        resetCampaignFormOptions({
          mode,
          optionsLoadError: optionsLoadErrorMessage,
          setOptionsError,
          setParentOptions,
          setFundOptions,
        });
        setBankAccountOptions([]);
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

    const customPrep = prepareCustomPatch();
    if (!customPrep.ok) return;
    const customPatch = customPrep.patch ? { custom: customPrep.patch } : {};

    try {
      if (mode === "create") {
        const created = await CampaignService.createCampaign(createClientApiClient(), {
          ...toApiPayload(values),
          ...customPatch,
        });
        toast.success(t("success.created"));
        // For nominative postal campaigns, redirect to constituent selection
        if (created.type === "nominative_postal") {
          router.push(`/campaigns/${created.id}/add-constituents`);
        } else {
          router.push(`/campaigns/${created.id}`);
        }
        router.refresh();
      } else {
        const updated = await CampaignService.updateCampaign(
          createClientApiClient(),
          props.campaign.id,
          { ...toApiPayload(values), ...customPatch },
        );
        toast.success(t("success.updated"));
        router.push(`/campaigns/${updated.id}`);
        router.refresh();
      }
    } catch (err) {
      console.error("FORM SUBMIT ERROR:", err);
      // Epic #539 — surface per-key registry 422s inline on the custom section.
      if (err instanceof ApiProblem && (err.status === 422 || err.status === 400)) {
        const perKey = extractCustomFieldErrors(err.extensions.fieldErrors);
        if (Object.keys(perKey).length > 0) setCustomErrors(perKey);
      }
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
        className="rounded-2xl bg-surface-container-lowest px-5 border border-border-brand sm:px-6"
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
              name="description"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>{t("fields.description")}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      placeholder={t("fields.descriptionPlaceholder")}
                      rows={4}
                      maxLength={2000}
                    />
                  </FormControl>
                  <p className="text-xs text-on-surface-variant">{t("fields.descriptionHint")}</p>
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
            <FormField
              control={form.control}
              name="goalAmountCents"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.goalAmount")}</FormLabel>
                  <FormControl>
                    <AmountInput
                      value={field.value}
                      onChange={(nextValue) => field.onChange(nextValue)}
                      placeholder={t("fields.goalAmountPlaceholder")}
                    />
                  </FormControl>
                  <p className="text-xs text-on-surface-variant">{t("fields.goalAmountHint")}</p>
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

        <FormSection
          title={t("sections.swissQrBill.title")}
          description={t("sections.swissQrBill.description")}
        >
          <SwissQrBillFields
            form={form}
            bankAccountOptions={bankAccountOptions}
            optionsLoading={optionsLoading}
            t={t}
          />
        </FormSection>

        {/* Epic #539 — absent entirely when the flag is off / no defs. */}
        <CustomFieldsSection
          definitions={customFieldDefs}
          values={customValues}
          onChange={handleCustomChange}
          errors={customErrors}
          title={tCustom("form.sectionTitle")}
          description={tCustom("form.sectionDescription")}
          disabled={isSubmitting}
        />

        <FormStickyFooter className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        </FormStickyFooter>
      </form>
    </Form>
  );
}

function toApiPayload(values: CampaignFormValues) {
  // Trim the description and forward `null` on empty so the API
  // explicitly clears the column rather than storing whitespace. The
  // API treats `undefined` vs. `null` differently — undefined leaves
  // the existing value alone, null clears it (cf. CampaignUpdateInput).
  const description = values.description?.trim() ?? "";
  // Epic #318 — sentinel `__none__` maps to `null` so the API unlinks
  // the bank account (and the worker drops back to standard mode).
  const bankAccountId =
    values.bankAccountId === EMPTY_BANK_ACCOUNT || !values.bankAccountId?.trim()
      ? null
      : values.bankAccountId.trim();
  return {
    name: values.name?.trim() ?? "",
    description: description.length > 0 ? description : null,
    type: values.type,
    defaultCurrency: values.defaultCurrency,
    parentId: values.parentId?.trim() || null,
    operationalCostCents: values.operationalCostCents,
    goalAmountCents: values.goalAmountCents,
    fundIds: values.fundIds.map((value) => value.trim()).filter((value) => value !== ""),
    bankAccountId,
    qrReferenceMode: values.qrReferenceMode,
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

    // `description` is the source of truth for the postal-letter body
    // (Epic #274). Earlier the resolver dropped it because it built
    // `cleaned` field-by-field — the user filled the field, hit save,
    // the form validated against the typebox schema (which accepts
    // `description: optional`), but the validated values handed to
    // `onSubmit` no longer contained the description, so `toApiPayload`
    // got `undefined` and serialised `null` to the API, silently
    // wiping the operator's input.
    //
    // Always include the trimmed value (even when empty) so the
    // "user cleared a previously-set description" path round-trips
    // correctly: empty string lands at `toApiPayload` which converts
    // it to `null` and the API clears the column.
    cleaned.description = values.description?.trim() ?? "";

    if (values.parentId?.trim() !== "") {
      cleaned.parentId = values.parentId?.trim();
    }
    if (values.operationalCostCents !== null) {
      cleaned.operationalCostCents = values.operationalCostCents;
    }
    if (values.goalAmountCents !== null) {
      cleaned.goalAmountCents = values.goalAmountCents;
    }
    cleaned.fundIds = values.fundIds.map((value) => value.trim()).filter((value) => value !== "");
    // Epic #318 — Swiss QR-bill fields. Same `__none__` → null mapping
    // as `toApiPayload` so the TypeBox-side schema sees a valid uuid
    // or `null` instead of the sentinel string.
    if (values.bankAccountId !== undefined) {
      cleaned.bankAccountId =
        values.bankAccountId === EMPTY_BANK_ACCOUNT || !values.bankAccountId.trim()
          ? null
          : values.bankAccountId.trim();
    }
    if (values.qrReferenceMode !== undefined) {
      cleaned.qrReferenceMode = values.qrReferenceMode;
    }

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

/**
 * Epic #318 — Swiss QR-bill section on the campaign form. Mirrors the
 * docs/25 §8.4.bis UX: no toggle, the dropdown's "None" sentinel IS the
 * off-state, and the `qrReferenceMode` override is hidden until a bank
 * account is actually selected (no operator should have to pick
 * `auto/qrr/scor` for a campaign that has no bank account linked).
 */
function SwissQrBillFields({
  form,
  bankAccountOptions,
  optionsLoading,
  t,
}: {
  form: UseFormReturn<CampaignFormValues>;
  bankAccountOptions: BankAccount[];
  optionsLoading: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const selectedBankAccountId = form.watch("bankAccountId");
  const swissModeActive =
    selectedBankAccountId !== EMPTY_BANK_ACCOUNT && selectedBankAccountId !== "";
  const selectedAccount = swissModeActive
    ? (bankAccountOptions.find((a) => a.id === selectedBankAccountId) ?? null)
    : null;
  const referenceTypeHint = selectedAccount
    ? selectedAccount.ibanKind === "qr_iban"
      ? t("fields.qrBillModeReferenceHintQrr")
      : t("fields.qrBillModeReferenceHintScor")
    : null;

  return (
    <div className="flex flex-col gap-5">
      <FormField
        control={form.control}
        name="bankAccountId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("fields.bankAccount")}</FormLabel>
            <Select
              value={field.value || EMPTY_BANK_ACCOUNT}
              onValueChange={field.onChange}
              disabled={optionsLoading}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      optionsLoading
                        ? t("fields.bankAccountLoading")
                        : t("fields.bankAccountPlaceholder")
                    }
                  />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={EMPTY_BANK_ACCOUNT}>{t("fields.bankAccountNone")}</SelectItem>
                {bankAccountOptions.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {`${account.bankName} · ${formatIbanForDisplay(account.iban)} · ${account.currency}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>
              {bankAccountOptions.length === 0 && !optionsLoading
                ? t("fields.bankAccountEmptyHint")
                : swissModeActive
                  ? t("fields.bankAccountActiveHint")
                  : t("fields.bankAccountInactiveHint")}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      {swissModeActive ? (
        <FormField
          control={form.control}
          name="qrReferenceMode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.qrReferenceMode")}</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) => field.onChange(value as CampaignQrReferenceMode)}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {QR_REFERENCE_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`fields.qrReferenceModeOption.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                {referenceTypeHint ?? t("fields.qrReferenceModeHint")}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : null}
    </div>
  );
}

/** Insert a space every 4 chars per ISO 13616 presentation guidance. */
function formatIbanForDisplay(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

async function loadCampaignFormOptions(mode: CampaignFormProps["mode"], campaignId?: string) {
  const client = createClientApiClient();
  const [campaignsResult, fundsResult, selectedFunds, bankAccountsResult] = await Promise.all([
    CampaignService.listCampaigns(client, {
      perPage: CAMPAIGN_OPTION_PAGE_SIZE,
    }),
    FundService.listFunds(client, { perPage: CAMPAIGN_OPTION_PAGE_SIZE }),
    mode === "edit" && campaignId
      ? FundService.listCampaignFunds(client, campaignId)
      : Promise.resolve([]),
    // Epic #318 — Swiss QR-bill picker source list. Skip soft-deleted
    // rows by default so the dropdown only surfaces actionable accounts.
    BankAccountService.listBankAccounts(client, { perPage: CAMPAIGN_OPTION_PAGE_SIZE }),
  ]);

  return {
    campaigns: campaignsResult.data,
    funds: fundsResult.data,
    selectedFundIds: selectedFunds.map((fund) => fund.id),
    bankAccountsForOrg: bankAccountsResult.data,
  };
}
