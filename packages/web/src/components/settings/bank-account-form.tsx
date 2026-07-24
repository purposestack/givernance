"use client";

import { classifyIban } from "@givernance/shared/validators";
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
import { FormStickyFooter } from "@/components/shared/form-sticky-footer";
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
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { BankAccount, BankAccountCurrency } from "@/models/bank-account";
import { BankAccountService } from "@/services/BankAccountService";

interface BankAccountFormValues {
  holderName: string;
  holderStreet: string;
  holderBuildingNumber: string;
  holderPostalCode: string;
  holderTown: string;
  holderCountryCode: string;
  iban: string;
  bic: string;
  bankName: string;
  currency: BankAccountCurrency;
}

type CreateMode = { mode: "create"; bankAccount?: undefined };
type EditMode = { mode: "edit"; bankAccount: BankAccount };

interface BankAccountFormBaseProps {
  canManage: boolean;
}

export type BankAccountFormProps = BankAccountFormBaseProps & (CreateMode | EditMode);

const CURRENCIES: readonly BankAccountCurrency[] = ["CHF", "EUR"];
const COUNTRIES: readonly { value: string; key: string }[] = [
  { value: "CH", key: "CH" },
  { value: "LI", key: "LI" },
];

export function BankAccountForm(props: BankAccountFormProps) {
  const { canManage, mode } = props;
  const router = useRouter();
  const t = useTranslations("settings.bankAccounts.form");
  const tBankAccounts = useTranslations("settings.bankAccounts");

  const form = useForm<BankAccountFormValues>({
    mode: "onBlur",
    defaultValues: {
      holderName: props.bankAccount?.holderName ?? "",
      holderStreet: props.bankAccount?.holderStreet ?? "",
      holderBuildingNumber: props.bankAccount?.holderBuildingNumber ?? "",
      holderPostalCode: props.bankAccount?.holderPostalCode ?? "",
      holderTown: props.bankAccount?.holderTown ?? "",
      holderCountryCode: props.bankAccount?.holderCountryCode ?? "CH",
      iban: props.bankAccount?.iban ?? "",
      bic: props.bankAccount?.bic ?? "",
      bankName: props.bankAccount?.bankName ?? "",
      currency: props.bankAccount?.currency ?? "CHF",
    },
  });

  const ibanValue = form.watch("iban");
  const currencyValue = form.watch("currency");
  // Live IBAN classification — gives the operator real-time feedback
  // that their typed IBAN will route through QRR (QR-IBAN) vs SCOR
  // (regular). EUR + QR-IBAN is the most common pitfall (illegal under
  // IG QR-bill v2.4) — surfaced inline before they hit submit.
  const ibanKind = ibanValue ? classifyIban(ibanValue) : "invalid";
  const eurOnQrIban = ibanKind === "qr_iban" && currencyValue === "EUR";

  async function onSubmit(values: BankAccountFormValues) {
    if (!canManage) return;
    form.clearErrors("root");
    try {
      if (mode === "create") {
        await BankAccountService.createBankAccount(createClientApiClient(), {
          holderName: values.holderName.trim(),
          holderStreet: values.holderStreet.trim(),
          holderBuildingNumber: values.holderBuildingNumber.trim() || null,
          holderPostalCode: values.holderPostalCode.trim(),
          holderTown: values.holderTown.trim(),
          holderCountryCode: values.holderCountryCode,
          iban: values.iban.trim(),
          bic: values.bic.trim() || null,
          bankName: values.bankName.trim(),
          currency: values.currency,
        });
        toast.success(t("success.created"));
      } else {
        // IBAN is immutable on edit (financial-record integrity).
        await BankAccountService.updateBankAccount(createClientApiClient(), props.bankAccount.id, {
          holderName: values.holderName.trim(),
          holderStreet: values.holderStreet.trim(),
          holderBuildingNumber: values.holderBuildingNumber.trim() || null,
          holderPostalCode: values.holderPostalCode.trim(),
          holderTown: values.holderTown.trim(),
          holderCountryCode: values.holderCountryCode,
          bic: values.bic.trim() || null,
          bankName: values.bankName.trim(),
          currency: values.currency,
        });
        toast.success(t("success.updated"));
      }
      router.push("/settings/bank-accounts");
      router.refresh();
    } catch (error) {
      if (!(error instanceof ApiProblem)) {
        console.error("BankAccountForm submit failed:", error);
      }
      const message =
        error instanceof ApiProblem
          ? (error.detail ?? error.title ?? t("errors.generic"))
          : t("errors.generic");
      form.setError("root", { type: "server", message });
      toast.error(message);
    }
  }

  const isSubmitting = form.formState.isSubmitting;
  const rootError = form.formState.errors.root?.message;

  if (!canManage) {
    return (
      <Card>
        <div className="inline-flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
          <Lock size={16} aria-hidden="true" />
          <span>{tBankAccounts("readOnly")}</span>
        </div>
      </Card>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="rounded-2xl bg-surface-container-lowest px-5 border border-border-brand sm:px-6"
        noValidate
      >
        <FormSection
          title={t("sections.account.title")}
          description={t("sections.account.description")}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <FormField
              control={form.control}
              name="iban"
              rules={{
                required: t("errors.ibanRequired"),
                validate: (value) =>
                  classifyIban(value) === "invalid" ? t("errors.ibanInvalid") : true,
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.iban")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t("fields.ibanPlaceholder")}
                      maxLength={42}
                      disabled={mode === "edit"}
                      aria-describedby="iban-kind-hint"
                    />
                  </FormControl>
                  <FormDescription id="iban-kind-hint">
                    {mode === "edit"
                      ? t("fields.ibanImmutable")
                      : ibanKind === "qr_iban"
                        ? t("fields.ibanHintQrIban")
                        : ibanKind === "iban"
                          ? t("fields.ibanHintRegular")
                          : t("fields.ibanHintDefault")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="bankName"
              rules={{
                required: t("errors.bankNameRequired"),
                maxLength: { value: 100, message: t("errors.bankNameTooLong") },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.bankName")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t("fields.bankNamePlaceholder")}
                      maxLength={100}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="bic"
              rules={{
                validate: (value) => {
                  const v = value.replace(/\s+/g, "").toUpperCase();
                  if (v.length === 0) return true;
                  return v.length === 8 || v.length === 11 ? true : t("errors.bicLength");
                },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.bic")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t("fields.bicPlaceholder")} maxLength={13} />
                  </FormControl>
                  <FormDescription>{t("fields.bicHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.currency")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value as BankAccountCurrency)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {eurOnQrIban ? (
                      <span className="text-error">{t("fields.currencyEurQrIbanError")}</span>
                    ) : (
                      t("fields.currencyHint")
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormSection
          title={t("sections.holder.title")}
          description={t("sections.holder.description")}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <FormField
              control={form.control}
              name="holderName"
              rules={{
                required: t("errors.holderNameRequired"),
                maxLength: { value: 70, message: t("errors.holderNameTooLong") },
              }}
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel required>{t("fields.holderName")}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={70} />
                  </FormControl>
                  <FormDescription>{t("fields.holderNameHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="holderStreet"
              rules={{
                required: t("errors.holderStreetRequired"),
                maxLength: { value: 70, message: t("errors.holderStreetTooLong") },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.holderStreet")}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={70} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="holderBuildingNumber"
              rules={{
                maxLength: { value: 16, message: t("errors.holderBuildingNumberTooLong") },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.holderBuildingNumber")}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={16} />
                  </FormControl>
                  <FormDescription>{t("fields.holderBuildingNumberHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="holderPostalCode"
              rules={{
                required: t("errors.holderPostalCodeRequired"),
                maxLength: { value: 16, message: t("errors.holderPostalCodeTooLong") },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.holderPostalCode")}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={16} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="holderTown"
              rules={{
                required: t("errors.holderTownRequired"),
                maxLength: { value: 35, message: t("errors.holderTownTooLong") },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.holderTown")}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={35} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="holderCountryCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.holderCountryCode")}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t("fields.holderCountryHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormStickyFooter className="flex flex-col gap-4">
          <div className="min-h-5 text-sm text-error">{rootError}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="ghost">
              <Link href="/settings/bank-accounts">{t("actions.cancel")}</Link>
            </Button>
            <Button type="submit" disabled={isSubmitting || eurOnQrIban}>
              {isSubmitting
                ? t("actions.submitting")
                : mode === "create"
                  ? t("actions.submitCreate")
                  : t("actions.submitUpdate")}
            </Button>
          </div>
        </FormStickyFooter>
      </form>
    </Form>
  );
}
