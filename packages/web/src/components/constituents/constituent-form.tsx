"use client";

import { FormatRegistry } from "@sinclair/typebox";

if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (value: string) =>
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value),
  );
}

import { ConstituentCreateSchema, ConstituentUpdateSchema } from "@givernance/shared/validators";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type DefaultValues, type Resolver, type UseFormReturn, useForm } from "react-hook-form";
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
import { CheckboxVisual } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import type { Constituent, ConstituentType } from "@/models/constituent";
import { type ConstituentCreateInput, ConstituentService } from "@/services/ConstituentService";

const CONSTITUENT_TYPES: readonly ConstituentType[] = [
  "donor",
  "volunteer",
  "member",
  "beneficiary",
  "partner",
] as const;

interface ConstituentFormValues {
  /**
   * Canonical multi-valued type (issue #465). Always holds ≥1 value. When the
   * `constituents.multi_type` flag is off, the single `Select` keeps this array
   * at exactly one element; when on, the multiselect lets it hold several.
   * Submitted as `types` so the API contract is uniform across both states.
   */
  types: ConstituentType[];
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /**
   * Postal address (Epic #274 follow-up). Drives the window-envelope
   * recipient block on personalised postal letters. All fields are
   * optional; when the operator fills `addressLine1` + `postalCode` +
   * `city` the renderer positions the block in the standard French DL
   * window so the letter fits in a window envelope after a Z-fold.
   */
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  countryCode: string;
}

interface DuplicateCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  score: number;
}

type CreateMode = { mode: "create"; constituent?: undefined };
type EditMode = { mode: "edit"; constituent: Constituent };

/**
 * `multiTypeEnabled` is SSR-fetched from `/v1/feature-flags`
 * (`constituents.multi_type`, issue #465) in the page server component and
 * threaded down. On → multiselect type control; off → single `Select`.
 */
export type ConstituentFormProps = (CreateMode | EditMode) & { multiTypeEnabled: boolean };

/** Coerce the constituent's stored types into a non-empty form-default array. */
function defaultTypes(constituent: Constituent | undefined): ConstituentType[] {
  const stored = constituent?.types?.filter((t): t is ConstituentType =>
    (CONSTITUENT_TYPES as readonly string[]).includes(t),
  );
  if (stored && stored.length > 0) return stored;
  const legacy = constituent?.type;
  if (legacy && (CONSTITUENT_TYPES as readonly string[]).includes(legacy)) {
    return [legacy as ConstituentType];
  }
  return ["donor"];
}

export function ConstituentForm(props: ConstituentFormProps) {
  const { mode, multiTypeEnabled } = props;
  const router = useRouter();
  const t = useTranslations("constituentForm");
  const tType = useTranslations("constituents.types");

  const defaultValues: DefaultValues<ConstituentFormValues> = {
    types: defaultTypes(props.constituent),
    firstName: props.constituent?.firstName ?? "",
    lastName: props.constituent?.lastName ?? "",
    email: props.constituent?.email ?? "",
    phone: props.constituent?.phone ?? "",
    addressLine1: props.constituent?.addressLine1 ?? "",
    addressLine2: props.constituent?.addressLine2 ?? "",
    postalCode: props.constituent?.postalCode ?? "",
    city: props.constituent?.city ?? "",
    // Default new-record country to FR so the most common French case
    // doesn't require the operator to type "FR" every time. Editable.
    countryCode: props.constituent?.countryCode ?? "FR",
  };

  const form = useForm<ConstituentFormValues>({
    mode: "onBlur",
    resolver: buildResolver(mode === "create" ? ConstituentCreateSchema : ConstituentUpdateSchema),
    defaultValues,
  });

  const [duplicateState, setDuplicateState] = useState<{
    open: boolean;
    candidates: DuplicateCandidate[];
    pendingValues: ConstituentFormValues | null;
  }>({ open: false, candidates: [], pendingValues: null });

  async function onSubmit(values: ConstituentFormValues) {
    form.clearErrors("root");
    // At least one type is required (issue #465). The single Select can never
    // be empty, but the multiselect can — guard before hitting the API so the
    // operator gets an inline field error instead of a 422 round-trip.
    if (!values.types || values.types.length === 0) {
      form.setError("types", { type: "manual", message: t("errors.typesRequired") });
      return;
    }
    try {
      if (mode === "create") {
        const created = await ConstituentService.createConstituent(
          createClientApiClient(),
          toApiPayload(values, "create"),
        );
        toast.success(t("success.created"));
        router.push(`/constituents/${created.id}`);
        router.refresh();
      } else {
        const updated = await ConstituentService.updateConstituent(
          createClientApiClient(),
          props.constituent.id,
          toApiPayload(values, "edit"),
        );
        toast.success(t("success.updated"));
        router.push(`/constituents/${updated.id}`);
        router.refresh();
      }
    } catch (err) {
      // The form maps API problems to inline field errors and falls back to
      // a generic toast for everything else — but used to swallow non-API
      // errors (e.g. a TypeError in `toApiPayload`) without any console
      // breadcrumb, leaving operators staring at "Something went wrong"
      // with nothing to grep. Log non-ApiProblem errors so the next
      // silent-failure regression is one DevTools tab away.
      if (!(err instanceof ApiProblem)) {
        console.error("ConstituentForm submit failed (unexpected error):", err);
      }
      handleApiError(err, form, values, setDuplicateState, {
        validation: t("errors.validation"),
        generic: t("errors.generic"),
      });
    }
  }

  async function forceCreate() {
    const values = duplicateState.pendingValues;
    if (!values || mode !== "create") {
      setDuplicateState({ open: false, candidates: [], pendingValues: null });
      return;
    }
    setDuplicateState((prev) => ({ ...prev, open: false }));
    try {
      const created = await ConstituentService.createConstituent(
        createClientApiClient(),
        toApiPayload(values, "create"),
        { force: true },
      );
      toast.success(t("success.created"));
      router.push(`/constituents/${created.id}`);
      router.refresh();
    } catch (err) {
      handleApiError(err, form, values, setDuplicateState, {
        validation: t("errors.validation"),
        generic: t("errors.generic"),
      });
    }
  }

  const isSubmitting = form.formState.isSubmitting;
  const rootError = form.formState.errors.root?.message;

  return (
    <>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="rounded-2xl bg-surface-container-lowest px-6 border border-border-brand"
          noValidate
        >
          <FormSection
            title={t("sections.identity.title")}
            description={t("sections.identity.description")}
          >
            <FormField
              control={form.control}
              name="types"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.type")}</FormLabel>
                  {multiTypeEnabled ? (
                    // Flag on — chip-style checkbox group (≥1 required). Matches
                    // docs/design/constituents/new.html's `.type-multiselect`.
                    <FormControl>
                      <TypeChipGroup
                        value={field.value ?? []}
                        onChange={field.onChange}
                        invalid={Boolean(form.formState.errors.types)}
                        labels={{
                          group: t("fields.type"),
                          option: (type: ConstituentType) => tType(type),
                        }}
                      />
                    </FormControl>
                  ) : (
                    // Flag off — single Select, identical to today. The value is
                    // still stored as a one-element `types` array so the submit
                    // path is uniform.
                    <Select
                      value={field.value?.[0] ?? "donor"}
                      onValueChange={(next) => field.onChange([next as ConstituentType])}
                    >
                      <FormControl>
                        <SelectTrigger aria-invalid={Boolean(form.formState.errors.types)}>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CONSTITUENT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {tType(type)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {multiTypeEnabled ? (
                    <p className="text-xs text-on-surface-variant">{t("fields.typesHint")}</p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 md:grid-cols-2">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("fields.firstName")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="given-name"
                        placeholder={t("fields.firstNamePlaceholder")}
                        aria-invalid={Boolean(form.formState.errors.firstName)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t("fields.lastName")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="family-name"
                        placeholder={t("fields.lastNamePlaceholder")}
                        aria-invalid={Boolean(form.formState.errors.lastName)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </FormSection>

          <FormSection
            title={t("sections.contact.title")}
            description={t("sections.contact.description")}
          >
            <div className="grid gap-5 md:grid-cols-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.email")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="email"
                        autoComplete="email"
                        placeholder={t("fields.emailPlaceholder")}
                        aria-invalid={Boolean(form.formState.errors.email)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.phone")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="tel"
                        autoComplete="tel"
                        placeholder={t("fields.phonePlaceholder")}
                        aria-invalid={Boolean(form.formState.errors.phone)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </FormSection>

          <FormSection
            title={t("sections.address.title")}
            description={t("sections.address.description")}
          >
            <div className="grid gap-5 md:grid-cols-2">
              <FormField
                control={form.control}
                name="addressLine1"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("fields.addressLine1")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="address-line1"
                        placeholder={t("fields.addressLine1Placeholder")}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="addressLine2"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("fields.addressLine2")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="address-line2"
                        placeholder={t("fields.addressLine2Placeholder")}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.postalCode")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="postal-code"
                        placeholder={t("fields.postalCodePlaceholder")}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.city")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="address-level2"
                        placeholder={t("fields.cityPlaceholder")}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="countryCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fields.countryCode")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="country"
                        maxLength={2}
                        placeholder="FR"
                        // ISO 3166-1 alpha-2; uppercased on save by the
                        // payload builder so case-insensitive input stays
                        // forgiving for the operator.
                        className="uppercase"
                      />
                    </FormControl>
                    <p className="text-xs text-on-surface-variant">{t("fields.countryCodeHint")}</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
              {isSubmitting
                ? t("actions.submitting")
                : mode === "create"
                  ? t("actions.submitCreate")
                  : t("actions.submitEdit")}
            </Button>
          </div>
        </form>
      </Form>

      <DuplicateDialog
        open={duplicateState.open}
        candidates={duplicateState.candidates}
        onClose={() => setDuplicateState({ open: false, candidates: [], pendingValues: null })}
        onForceCreate={mode === "create" ? forceCreate : undefined}
      />
    </>
  );
}

interface TypeChipGroupProps {
  value: ConstituentType[];
  onChange: (next: ConstituentType[]) => void;
  invalid?: boolean;
  labels: {
    group: string;
    option: (type: ConstituentType) => string;
  };
}

/**
 * Chip-style multiselect for constituent `types` (issue #465). A toggle-button
 * group — each known type is a pill the operator clicks to add/remove. At least
 * one is required (enforced on submit). Mirrors the `.type-multiselect` /
 * `.type-chip` art in `docs/design/constituents/new.html`. Each chip IS the
 * toggle `<button>`, so the box uses the presentational `CheckboxVisual`
 * (a `<span>`, not a Radix `<button>`) — a real `Checkbox` would nest
 * `<button>` in `<button>` and crash with a focus-scope update loop (#465).
 */
function TypeChipGroup({ value, onChange, invalid, labels }: TypeChipGroupProps) {
  const selected = new Set(value);
  const toggle = (type: ConstituentType) => {
    const next = new Set(selected);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onChange(CONSTITUENT_TYPES.filter((t) => next.has(t)));
  };

  return (
    <fieldset
      aria-label={labels.group}
      aria-invalid={invalid}
      className="flex flex-wrap gap-2 rounded-[var(--radius-md)] border border-outline-variant bg-surface-container p-3 aria-[invalid=true]:border-error"
    >
      {CONSTITUENT_TYPES.map((type) => {
        const checked = selected.has(type);
        return (
          <button
            key={type}
            type="button"
            onClick={() => toggle(type)}
            aria-pressed={checked}
            className={cn(
              "inline-flex items-center gap-2 rounded-[var(--radius-pill)] border px-3 py-1 text-sm",
              "transition-colors duration-normal ease-out",
              "focus-visible:outline-none focus-visible:shadow-ring",
              checked
                ? "border-primary bg-primary/10 text-primary"
                : "border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary",
            )}
          >
            <CheckboxVisual checked={checked} />
            <span>{labels.option(type)}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

function DuplicateDialog({
  open,
  candidates,
  onClose,
  onForceCreate,
}: {
  open: boolean;
  candidates: DuplicateCandidate[];
  onClose: () => void;
  onForceCreate?: () => void;
}) {
  const t = useTranslations("constituentForm.duplicate");

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2 text-tertiary">
            <AlertTriangle size={18} aria-hidden="true" />
            <DialogTitle>{t("title")}</DialogTitle>
          </div>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>

        <ul className="space-y-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-outline-variant bg-surface-container-low px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-on-surface">
                  {candidate.firstName || candidate.lastName
                    ? `${candidate.firstName} ${candidate.lastName}`.trim()
                    : t("unnamed")}
                </p>
                <p className="truncate text-xs text-on-surface-variant">{candidate.email ?? "—"}</p>
              </div>
              <Button asChild variant="secondary" size="sm">
                <a href={`/constituents/${candidate.id}`}>{t("viewExisting")}</a>
              </Button>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          {onForceCreate ? (
            <Button variant="primary" onClick={onForceCreate}>
              {t("createAnyway")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Build the API payload from form values.
 *
 * Edit vs create matters for empty optional fields:
 * - **create**: empty email/phone → `undefined` (omitted from request →
 *   server never tries to set them; column gets the default NULL).
 * - **edit**: empty email/phone → `null` (sent as explicit clear → server
 *   maps to `SET email = NULL`). Without this, the client's `toRequestBody`
 *   would drop the key and the user couldn't ever delete a previously-set
 *   value through the UI.
 *
 * The resolver upstream (`buildResolver`) already trims and normalises
 * empty optionals to `undefined` for validation, but the runtime values
 * passed to this function may still be undefined — `?.` guards them.
 */
function toApiPayload(
  values: ConstituentFormValues,
  mode: "create" | "edit",
): ConstituentCreateInput {
  const emptyOptional = mode === "edit" ? null : undefined;
  // Country code is a special case: the form defaults to "FR" but the
  // operator may legitimately want to clear it (international donors who
  // didn't disclose nationality). Treat empty string as "no value" for
  // both create and edit so the API receives `undefined` (create) /
  // `null` (edit) rather than a 1-char string that fails the validator.
  const trimmedCountry = values.countryCode?.trim().toUpperCase() ?? "";
  return {
    // Issue #465 — submit the canonical `types` array. Deduped + non-empty
    // (the form guards against an empty selection before reaching here). The
    // API derives the legacy `type` mirror from `types[0]` server-side.
    types: Array.from(new Set(values.types ?? [])),
    firstName: values.firstName?.trim() ?? "",
    lastName: values.lastName?.trim() ?? "",
    email: values.email?.trim() || emptyOptional,
    phone: values.phone?.trim() || emptyOptional,
    addressLine1: values.addressLine1?.trim() || emptyOptional,
    addressLine2: values.addressLine2?.trim() || emptyOptional,
    postalCode: values.postalCode?.trim() || emptyOptional,
    city: values.city?.trim() || emptyOptional,
    countryCode: trimmedCountry.length === 2 ? trimmedCountry : emptyOptional,
  };
}

function parseDuplicates(raw: unknown): DuplicateCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is DuplicateCandidate =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as DuplicateCandidate).id === "string",
  );
}

const MAPPED_FIELDS = [
  "types",
  "firstName",
  "lastName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
] as const;

function applyFieldErrors(form: UseFormReturn<ConstituentFormValues>, raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  let applied = false;
  for (const name of MAPPED_FIELDS) {
    const value = (raw as Record<string, unknown>)[name];
    const message = typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
    if (typeof message !== "string") continue;
    form.setError(name, { type: "server", message });
    applied = true;
  }
  return applied;
}

type TypeboxSchema = Parameters<typeof typeboxResolver>[0];

/**
 * Build a resolver that coerces empty-string optional fields to undefined
 * before handing off to typeboxResolver. Without this, an empty email input
 * fails the `format: email` constraint and blocks submission.
 */
function buildResolver(schema: TypeboxSchema): Resolver<ConstituentFormValues> {
  const innerResolver = typeboxResolver(schema) as unknown as Resolver<ConstituentFormValues>;
  return async (values, context, options) => {
    const cleaned = { ...values } as Record<string, unknown>;
    for (const key of [
      "firstName",
      "lastName",
      "email",
      "phone",
      "addressLine1",
      "addressLine2",
      "postalCode",
      "city",
      "countryCode",
    ] as const) {
      const v = cleaned[key];
      if (typeof v !== "string") continue;

      const trimmed = v.trim();
      if (trimmed === "") {
        cleaned[key] = key === "firstName" || key === "lastName" ? "" : undefined;
        continue;
      }

      cleaned[key] = trimmed;
    }
    return innerResolver(cleaned as unknown as ConstituentFormValues, context, options);
  };
}

type SetDuplicateState = (state: {
  open: boolean;
  candidates: DuplicateCandidate[];
  pendingValues: ConstituentFormValues | null;
}) => void;

interface ErrorMessages {
  validation: string;
  generic: string;
}

function handleApiError(
  err: unknown,
  form: UseFormReturn<ConstituentFormValues>,
  submittedValues: ConstituentFormValues,
  setDuplicateState: SetDuplicateState,
  messages: ErrorMessages,
) {
  if (err instanceof ApiProblem) {
    if (err.status === 409) {
      const candidates = parseDuplicates(err.extensions.duplicates);
      setDuplicateState({ open: true, candidates, pendingValues: submittedValues });
      return;
    }
    if (err.status === 422 || err.status === 400) {
      const applied = applyFieldErrors(form, err.extensions.fieldErrors);
      if (applied) {
        form.setError("root", { type: "server", message: messages.validation });
        return;
      }
    }
    form.setError("root", {
      type: "server",
      message: err.detail ?? err.title ?? messages.generic,
    });
    return;
  }
  form.setError("root", { type: "server", message: messages.generic });
}

export type { ConstituentFormValues };
