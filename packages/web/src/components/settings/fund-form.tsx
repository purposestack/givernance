"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";

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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import type { Fund, FundType } from "@/models/fund";
import { FundService } from "@/services/FundService";

interface FundFormValues {
  name: string;
  description: string;
  type: FundType;
}

type CreateMode = { mode: "create"; fund?: undefined };
type EditMode = { mode: "edit"; fund: Fund };

interface FundFormBaseProps {
  canManageFunds: boolean;
}

export type FundFormProps = FundFormBaseProps & (CreateMode | EditMode);

const FUND_TYPES: readonly FundType[] = ["unrestricted", "restricted"];

export function FundForm(props: FundFormProps) {
  const { canManageFunds, mode } = props;
  const router = useRouter();
  const t = useTranslations("settings.funds.form");
  const tFunds = useTranslations("settings.funds");

  const form = useForm<FundFormValues>({
    mode: "onBlur",
    defaultValues: {
      name: props.fund?.name ?? "",
      description: props.fund?.description ?? "",
      type: props.fund?.type ?? "unrestricted",
    },
  });

  async function onSubmit(values: FundFormValues) {
    if (!canManageFunds) return;

    form.clearErrors("root");

    try {
      if (mode === "create") {
        await FundService.createFund(createClientApiClient(), {
          name: values.name.trim(),
          description: values.description.trim() || null,
          type: values.type,
        });
        toast.success(t("success.created"));
      } else {
        await FundService.updateFund(createClientApiClient(), props.fund.id, {
          name: values.name.trim(),
          description: values.description.trim() || null,
          type: values.type,
        });
        toast.success(t("success.updated"));
      }
      router.push("/settings/funds");
      router.refresh();
    } catch (error) {
      handleApiError(error, form, t("errors.generic"));
    }
  }

  const isSubmitting = form.formState.isSubmitting;
  const rootError = form.formState.errors.root?.message;

  if (!canManageFunds) {
    return (
      <Card>
        <div className="inline-flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
          <Lock size={16} aria-hidden="true" />
          <span>{tFunds("readOnly")}</span>
        </div>
      </Card>
    );
  }

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
              rules={{
                required: t("errors.nameRequired"),
                validate: (value) => (value.trim().length > 0 ? true : t("errors.nameRequired")),
                maxLength: {
                  value: 255,
                  message: t("errors.nameTooLong"),
                },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.name")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t("fields.namePlaceholder")} maxLength={255} />
                  </FormControl>
                  <FormDescription>{t("fields.nameHint")}</FormDescription>
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
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value as FundType)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FUND_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {tFunds(`types.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t("fields.typeHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormSection
          title={t("sections.description.title")}
          description={t("sections.description.description")}
        >
          <FormField
            control={form.control}
            name="description"
            rules={{
              maxLength: {
                value: 5000,
                message: t("errors.descriptionTooLong"),
              },
            }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.description")}</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    rows={5}
                    placeholder={t("fields.descriptionPlaceholder")}
                    maxLength={5000}
                  />
                </FormControl>
                <FormDescription>{t("fields.descriptionHint")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        <div className="flex flex-col gap-4 py-8">
          <div className="min-h-5 text-sm text-error">{rootError}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="ghost">
              <Link href="/settings/funds">{t("actions.cancel")}</Link>
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? t("actions.submitting")
                : mode === "create"
                  ? t("actions.submitCreate")
                  : t("actions.submitUpdate")}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

function handleApiError(
  error: unknown,
  form: ReturnType<typeof useForm<FundFormValues>>,
  fallback: string,
) {
  const message = resolveApiErrorMessage(error, fallback);
  form.setError("root", {
    type: "server",
    message,
  });
  toast.error(message);
}

function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiProblem) {
    return error.detail ?? error.title ?? fallback;
  }

  return fallback;
}
