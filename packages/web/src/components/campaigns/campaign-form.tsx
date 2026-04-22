"use client";

import { FormatRegistry } from "@sinclair/typebox";

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
import { type DefaultValues, type Resolver, type UseFormReturn, useForm } from "react-hook-form";

import { AmountInput } from "@/components/shared/amount-input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
import { FormSection } from "@/components/shared/form-section";
import { Button } from "@/components/ui/button";
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
import type { Campaign, CampaignType } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";

const CAMPAIGN_TYPES: readonly CampaignType[] = [
  "nominative_postal",
  "door_drop",
  "digital",
] as const;

interface CampaignFormValues {
  name: string;
  type: CampaignType;
  parentId: string;
  costCents: number | null;
}

type CreateMode = { mode: "create"; campaign?: undefined };
type EditMode = { mode: "edit"; campaign: Campaign };

export type CampaignFormProps = CreateMode | EditMode;

const EMPTY_PARENT = "__none__";

export function CampaignForm(props: CampaignFormProps) {
  const { mode } = props;
  const router = useRouter();
  const t = useTranslations("campaigns.form");
  const tCampaigns = useTranslations("campaigns");

  const defaultValues: DefaultValues<CampaignFormValues> = {
    name: props.campaign?.name ?? "",
    type: props.campaign?.type ?? "digital",
    parentId: props.campaign?.parentId ?? "",
    costCents: props.campaign?.costCents ?? null,
  };

  const form = useForm<CampaignFormValues>({
    mode: "onBlur",
    resolver: buildResolver(),
    defaultValues,
  });

  const [parentOptions, setParentOptions] = useState<Campaign[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadOptions() {
      try {
        const result = await CampaignService.listCampaigns(createClientApiClient(), {
          perPage: 100,
        });
        if (!active) return;
        setParentOptions(
          result.data.filter((campaign) =>
            mode === "edit" ? campaign.id !== props.campaign.id : true,
          ),
        );
      } catch {
        if (!active) return;
        setParentOptions([]);
      } finally {
        if (active) setOptionsLoading(false);
      }
    }

    void loadOptions();

    return () => {
      active = false;
    };
  }, [mode, props.campaign?.id]);

  async function onSubmit(values: CampaignFormValues) {
    form.clearErrors("root");

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
              name="costCents"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.goal")}</FormLabel>
                  <FormControl>
                    <AmountInput
                      value={field.value}
                      onChange={(nextValue) => field.onChange(nextValue)}
                      placeholder={t("fields.goalPlaceholder")}
                    />
                  </FormControl>
                  <p className="text-xs text-on-surface-variant">{t("fields.goalHint")}</p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <div className="flex flex-col gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-sm text-error">{rootError}</div>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="ghost">
              <Link href={mode === "edit" ? `/campaigns/${props.campaign.id}` : "/campaigns"}>
                {t("actions.cancel")}
              </Link>
            </Button>
            <Button type="submit" disabled={isSubmitting}>
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
    parentId: values.parentId?.trim() || null,
    costCents: values.costCents,
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
    };

    if (values.parentId?.trim() !== "") {
      cleaned.parentId = values.parentId?.trim();
    }
    if (values.costCents !== null) {
      cleaned.costCents = values.costCents;
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
