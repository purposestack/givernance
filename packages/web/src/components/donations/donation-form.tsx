"use client";

import { FormatRegistry } from "@sinclair/typebox";

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
}

import { DonationCreateSchema } from "@givernance/shared/validators";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { Check, ChevronsUpDown, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DefaultValues,
  type Resolver,
  type UseFormReturn,
  useFieldArray,
  useForm,
} from "react-hook-form";

import { Form, FormField, FormItem, FormLabel, FormMessage } from "@/components/shared/form-field";
import { FormSection } from "@/components/shared/form-section";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { cn } from "@/lib/utils";
import { type Constituent, fullName } from "@/models/constituent";
import type { DonationCreateInput } from "@/models/donation";
import { ConstituentService } from "@/services/ConstituentService";
import { DonationService } from "@/services/DonationService";

const CURRENCIES = ["EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK"] as const;
const PAYMENT_METHODS = ["wire", "cheque", "card", "sepa", "cash", "other"] as const;

interface AllocationFormValue {
  fundId: string;
  amountCents: number | null;
}

interface DonationFormValues {
  constituentId: string;
  amountCents: number | null;
  currency: (typeof CURRENCIES)[number];
  campaignId: string;
  paymentMethod: (typeof PAYMENT_METHODS)[number] | "";
  paymentRef: string;
  donatedAt: string;
  allocations: AllocationFormValue[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_VALUES: DefaultValues<DonationFormValues> = {
  constituentId: "",
  amountCents: null,
  currency: "EUR",
  campaignId: "",
  paymentMethod: "",
  paymentRef: "",
  donatedAt: todayIso(),
  allocations: [],
};

export function DonationForm() {
  const router = useRouter();
  const t = useTranslations("donations.form");

  const form = useForm<DonationFormValues>({
    mode: "onBlur",
    resolver: buildResolver(),
    defaultValues: DEFAULT_VALUES,
  });

  const {
    fields: allocationFields,
    append: appendAllocation,
    remove: removeAllocation,
  } = useFieldArray({
    control: form.control,
    name: "allocations",
  });

  const [selectedConstituent, setSelectedConstituent] = useState<Constituent | null>(null);

  async function onSubmit(values: DonationFormValues) {
    form.clearErrors("root");

    if (!values.constituentId) {
      form.setError("constituentId", { type: "manual", message: t("errors.constituentRequired") });
      return;
    }
    if (!values.amountCents || values.amountCents <= 0) {
      form.setError("amountCents", { type: "manual", message: t("errors.amountInvalid") });
      return;
    }

    const payload = toApiPayload(values);

    try {
      const created = await DonationService.createDonation(createClientApiClient(), payload);
      toast.success(t("success.created"));
      router.push(`/donations/${created.id}`);
      router.refresh();
    } catch (err) {
      handleApiError(err, form, {
        allocationSumMismatch: t("errors.allocationSumMismatch"),
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
        className="rounded-2xl bg-surface-container-lowest px-6 shadow-card"
        noValidate
      >
        <FormSection
          title={t("sections.donor.title")}
          description={t("sections.donor.description")}
        >
          <FormField
            control={form.control}
            name="constituentId"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>{t("fields.constituent")}</FormLabel>
                <ConstituentPicker
                  value={field.value}
                  selected={selectedConstituent}
                  onSelect={(constituent) => {
                    setSelectedConstituent(constituent);
                    field.onChange(constituent?.id ?? "");
                    if (constituent?.id) form.clearErrors("constituentId");
                  }}
                  invalid={Boolean(form.formState.errors.constituentId)}
                />
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        <FormSection
          title={t("sections.donation.title")}
          description={t("sections.donation.description")}
        >
          <div className="grid gap-5 md:grid-cols-2">
            <FormField
              control={form.control}
              name="amountCents"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.amount")}</FormLabel>
                  <AmountInput
                    value={field.value}
                    onChange={(v) => {
                      field.onChange(v);
                      if (v && v > 0) form.clearErrors("amountCents");
                    }}
                    invalid={Boolean(form.formState.errors.amountCents)}
                    placeholder={t("fields.amountPlaceholder")}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.currency")}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-invalid={Boolean(form.formState.errors.currency)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <FormField
              control={form.control}
              name="donatedAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.donatedAt")}</FormLabel>
                  <Input
                    type="date"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                    aria-invalid={Boolean(form.formState.errors.donatedAt)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.paymentMethod")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value === "" ? "" : value)}
                  >
                    <SelectTrigger aria-invalid={Boolean(form.formState.errors.paymentMethod)}>
                      <SelectValue placeholder={t("fields.paymentMethodPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((method) => (
                        <SelectItem key={method} value={method}>
                          {t(`paymentMethods.${method}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="paymentRef"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.paymentRef")}</FormLabel>
                <Input
                  {...field}
                  placeholder={t("fields.paymentRefPlaceholder")}
                  aria-invalid={Boolean(form.formState.errors.paymentRef)}
                />
                <p className="text-xs text-on-surface-variant">{t("fields.paymentRefHint")}</p>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        <FormSection
          title={t("sections.attribution.title")}
          description={t("sections.attribution.description")}
        >
          <FormField
            control={form.control}
            name="campaignId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.campaignId")}</FormLabel>
                <Input
                  {...field}
                  placeholder={t("fields.campaignIdPlaceholder")}
                  aria-invalid={Boolean(form.formState.errors.campaignId)}
                />
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="space-y-3">
            <FormLabelPlain>{t("fields.allocations")}</FormLabelPlain>
            <p className="text-xs text-on-surface-variant">{t("fields.allocationsHint")}</p>

            {allocationFields.length > 0 ? (
              <ul className="space-y-3">
                {allocationFields.map((fieldItem, index) => (
                  <li key={fieldItem.id} className="grid gap-3 md:grid-cols-[1fr_200px_auto]">
                    <FormField
                      control={form.control}
                      name={`allocations.${index}.fundId`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("fields.allocationFund")}</FormLabel>
                          <Input
                            {...field}
                            placeholder={t("fields.allocationFundPlaceholder")}
                            aria-invalid={Boolean(
                              form.formState.errors.allocations?.[index]?.fundId,
                            )}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`allocations.${index}.amountCents`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("fields.allocationAmount")}</FormLabel>
                          <AmountInput
                            value={field.value}
                            onChange={field.onChange}
                            invalid={Boolean(
                              form.formState.errors.allocations?.[index]?.amountCents,
                            )}
                            placeholder={t("fields.amountPlaceholder")}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="flex items-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeAllocation(index)}
                        aria-label={t("fields.allocationRemove")}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => appendAllocation({ fundId: "", amountCents: null })}
            >
              <Plus size={16} aria-hidden="true" />
              {t("fields.allocationAdd")}
            </Button>
          </div>
        </FormSection>

        {rootError ? (
          <p role="alert" className="py-3 text-sm font-medium text-error">
            {rootError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant py-6">
          <Button variant="ghost" onClick={() => router.back()} disabled={isSubmitting}>
            {t("actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={isSubmitting}>
            {isSubmitting ? t("actions.submitting") : t("actions.submitCreate")}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** Plain label outside the FormField context (not tied to a specific input). */
function FormLabelPlain({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-medium text-on-surface">
      <span>{children}</span>
    </p>
  );
}

interface ConstituentPickerProps {
  value: string;
  selected: Constituent | null;
  onSelect: (constituent: Constituent | null) => void;
  invalid: boolean;
}

function ConstituentPicker({ value, selected, onSelect, invalid }: ConstituentPickerProps) {
  const t = useTranslations("donations.form");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<Constituent[]>([]);
  const [loading, setLoading] = useState(false);

  const loadConstituents = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const client = createClientApiClient();
      const result = await ConstituentService.listConstituents(client, {
        page: 1,
        perPage: 50,
        search: query || undefined,
      });
      setCandidates(result.data);
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      loadConstituents(search.trim());
    }, 200);
    return () => clearTimeout(handle);
  }, [open, search, loadConstituents]);

  const triggerLabel = selected ? fullName(selected) : t("fields.constituentPlaceholder");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-invalid={invalid}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center justify-between gap-2",
            "h-[var(--input-height)] px-3",
            "bg-surface-container-lowest text-on-surface",
            "border border-outline-variant rounded-[var(--radius-input)]",
            "font-body text-base",
            "transition-[border-color,box-shadow] duration-normal ease-out",
            "focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-ring",
            "aria-invalid:border-error aria-invalid:focus-visible:shadow-ring-error",
            !selected && "text-text-muted",
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown size={16} className="shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("fields.constituentPlaceholder")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading ? (
              <div className="py-4 text-center text-sm text-on-surface-variant">
                {t("fields.constituentLoading")}
              </div>
            ) : candidates.length === 0 ? (
              <CommandEmpty>{t("fields.constituentEmpty")}</CommandEmpty>
            ) : (
              <CommandGroup>
                {candidates.map((constituent) => {
                  const name = fullName(constituent);
                  return (
                    <CommandItem
                      key={constituent.id}
                      value={constituent.id}
                      onSelect={() => {
                        onSelect(constituent);
                        setOpen(false);
                      }}
                    >
                      <Check
                        size={14}
                        aria-hidden="true"
                        className={cn(
                          "mr-2",
                          value === constituent.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-on-surface">{name}</span>
                        {constituent.email ? (
                          <span className="truncate text-xs text-on-surface-variant">
                            {constituent.email}
                          </span>
                        ) : null}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface AmountInputProps {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  invalid: boolean;
  placeholder?: string;
}

function AmountInput({ value, onChange, invalid, placeholder }: AmountInputProps) {
  const [raw, setRaw] = useState<string>(() => centsToDisplay(value));
  const lastValueRef = useRef<number | null | undefined>(value);

  useEffect(() => {
    if (value !== lastValueRef.current) {
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
        type="text"
        inputMode="decimal"
        value={raw}
        placeholder={placeholder}
        aria-invalid={invalid}
        className="pl-7 font-mono tabular-nums"
        onChange={(e) => {
          const next = e.target.value;
          setRaw(next);
          const parsed = parseAmount(next);
          lastValueRef.current = parsed;
          onChange(parsed);
        }}
        onBlur={() => {
          const parsed = parseAmount(raw);
          lastValueRef.current = parsed;
          setRaw(centsToDisplay(parsed));
        }}
      />
    </div>
  );
}

function centsToDisplay(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return (value / 100).toFixed(2);
}

function parseAmount(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function toApiPayload(values: DonationFormValues): DonationCreateInput {
  const donatedAt = values.donatedAt
    ? new Date(`${values.donatedAt}T00:00:00Z`).toISOString()
    : undefined;
  const allocations = values.allocations
    .map((a) => ({ fundId: a.fundId.trim(), amountCents: a.amountCents ?? 0 }))
    .filter((a) => a.fundId !== "" && a.amountCents > 0);

  return {
    constituentId: values.constituentId,
    amountCents: values.amountCents ?? 0,
    currency: values.currency,
    campaignId: values.campaignId.trim() || undefined,
    paymentMethod: values.paymentMethod || undefined,
    paymentRef: values.paymentRef.trim() || undefined,
    donatedAt,
    allocations: allocations.length > 0 ? allocations : undefined,
  };
}

type TypeboxSchema = Parameters<typeof typeboxResolver>[0];

/**
 * Resolver adapter — converts the form's friendly shape (date-only string,
 * empty optional strings) into the payload expected by DonationCreateSchema
 * before handing off to typeboxResolver.
 */
function buildResolver(): Resolver<DonationFormValues> {
  const innerResolver = typeboxResolver(
    DonationCreateSchema as TypeboxSchema,
  ) as unknown as Resolver<Record<string, unknown>>;

  const adapted: Resolver<DonationFormValues> = async (values, context, options) => {
    const cleaned: Record<string, unknown> = {
      constituentId: values.constituentId,
      amountCents: values.amountCents ?? 0,
      currency: values.currency,
    };
    if (values.campaignId && values.campaignId.trim() !== "") {
      cleaned.campaignId = values.campaignId.trim();
    }
    if (values.paymentMethod) {
      cleaned.paymentMethod = values.paymentMethod;
    }
    if (values.paymentRef && values.paymentRef.trim() !== "") {
      cleaned.paymentRef = values.paymentRef.trim();
    }
    if (values.donatedAt) {
      cleaned.donatedAt = new Date(`${values.donatedAt}T00:00:00Z`).toISOString();
    }
    const allocations = values.allocations
      .filter((a) => a.fundId.trim() !== "" && a.amountCents !== null && a.amountCents > 0)
      .map((a) => ({ fundId: a.fundId.trim(), amountCents: a.amountCents as number }));
    if (allocations.length > 0) {
      cleaned.allocations = allocations;
    }
    const result = await innerResolver(
      cleaned,
      context,
      options as unknown as Parameters<typeof innerResolver>[2],
    );
    return result as unknown as Awaited<ReturnType<Resolver<DonationFormValues>>>;
  };

  return adapted;
}

interface ErrorMessages {
  allocationSumMismatch: string;
  validation: string;
  generic: string;
}

function handleApiError(
  err: unknown,
  form: UseFormReturn<DonationFormValues>,
  messages: ErrorMessages,
) {
  if (err instanceof ApiProblem) {
    if (err.status === 422 && err.detail?.toLowerCase().includes("alloc")) {
      form.setError("root", { type: "server", message: messages.allocationSumMismatch });
      return;
    }
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
