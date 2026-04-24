"use client";

import { validateTenantSlug } from "@givernance/shared/validators";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
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
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createEnterpriseTenant } from "@/services/TenantAdminService";

interface NewTenantFormValues {
  name: string;
  slug: string;
}

/** Host prefix shown before the slug input. MOCKUP-9 (PR #135 review):
 * parameterised so white-label deployments don't surface `givernance.app/`. */
function resolveWorkspaceHost(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return "givernance.app/";
  try {
    const url = new URL(raw);
    return `${url.host}/`;
  } catch {
    return "givernance.app/";
  }
}

/** Strip accents + special chars → lowercase alnum-dash slug. */
function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Enterprise tenant creation form (issue #111 / doc 22 §6.4). Lives under
 * `/admin/tenants/new`; the layout gate enforces the `super_admin` role.
 *
 * The slug is auto-derived from the organisation name until the operator
 * edits it manually (matches the self-serve signup UX from issue #109).
 * Post-create we route to the tenant detail so the operator can move on
 * to claiming a domain and provisioning the IdP.
 *
 * Plan is fixed to `enterprise` — this is the back-office creation surface;
 * the self-serve signup flow handles Starter/Pro (UX-6 of PR #135 review).
 */
export function NewTenantForm() {
  const t = useTranslations("admin.tenants.new");
  const router = useRouter();
  const hostPrefix = resolveWorkspaceHost();

  const form = useForm<NewTenantFormValues>({
    mode: "onBlur",
    defaultValues: {
      name: "",
      slug: "",
    },
  });

  const nameValue = form.watch("name");
  const slugDirty = form.formState.dirtyFields.slug;

  // FE-2/3: setValue without shouldDirty keeps dirtyFields.slug === false so
  // auto-slug stays active until the user types into the slug input directly.
  useEffect(() => {
    if (!slugDirty) {
      form.setValue("slug", slugify(nameValue), { shouldValidate: false });
    }
  }, [nameValue, slugDirty, form]);

  async function onSubmit(values: NewTenantFormValues) {
    form.clearErrors("root");
    const slugCheck = validateTenantSlug(values.slug);
    if (!slugCheck.ok) {
      const message =
        slugCheck.reason === "reserved"
          ? t("errors.slugReserved")
          : slugCheck.reason === "punycode"
            ? t("errors.slugPunycode")
            : t("errors.slugSyntax");
      form.setError("slug", { type: "validate", message });
      return;
    }

    try {
      const res = await createEnterpriseTenant({
        name: values.name.trim(),
        slug: slugCheck.slug,
        plan: "enterprise",
      });
      toast.success(t("success"));
      router.push(`/admin/tenants/${res.tenantId}`);
      router.refresh();
    } catch (error) {
      handleApiError(error, form, {
        slugTaken: t("errors.slugTaken"),
        slugSyntax: t("errors.slugSyntax"),
        upstream: t("errors.upstream"),
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
          <FormField
            control={form.control}
            name="name"
            rules={{
              required: t("errors.nameRequired"),
              validate: (value) => (value.trim().length >= 2 ? true : t("errors.nameRequired")),
              maxLength: { value: 255, message: t("errors.nameTooLong") },
            }}
            render={({ field }) => (
              <FormItem>
                <FormLabel required>{t("fields.name")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    autoComplete="off"
                    placeholder={t("fields.namePlaceholder")}
                    maxLength={255}
                  />
                </FormControl>
                <FormDescription>{t("fields.nameHint")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="slug"
            rules={{
              required: t("errors.slugSyntax"),
              pattern: {
                value: /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/,
                message: t("errors.slugSyntax"),
              },
            }}
            render={({ field }) => (
              <FormItem>
                <FormLabel required>{t("fields.slug")}</FormLabel>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-on-surface-variant">{hostPrefix}</span>
                  <FormControl>
                    <Input
                      {...field}
                      autoComplete="off"
                      onChange={(e) => field.onChange(e.target.value.toLowerCase().slice(0, 50))}
                      maxLength={50}
                      pattern="^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$"
                    />
                  </FormControl>
                </div>
                <FormDescription>
                  {slugDirty ? t("fields.slugHint") : t("fields.slugAutoGenerated")}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        <div className="flex flex-col gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
          {/* UX-1 (review): announced to AT via role="alert" so screen-reader users
              are notified on upstream/502 without relying on the toast. */}
          <div className="min-h-5 text-sm text-error" role="alert">
            {rootError}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="ghost">
              <Link href="/admin/tenants">{t("actions.cancel")}</Link>
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("actions.submitting") : t("actions.submit")}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

interface ErrorCopy {
  slugTaken: string;
  slugSyntax: string;
  upstream: string;
  generic: string;
}

function handleApiError(
  error: unknown,
  form: ReturnType<typeof useForm<NewTenantFormValues>>,
  copy: ErrorCopy,
) {
  if (error instanceof ApiProblem) {
    if (error.status === 409) {
      form.setError("slug", { type: "server", message: copy.slugTaken });
      toast.error(copy.slugTaken);
      return;
    }
    if (error.status === 422) {
      form.setError("slug", { type: "server", message: copy.slugSyntax });
      toast.error(copy.slugSyntax);
      return;
    }
    if (error.status === 502) {
      form.setError("root", { type: "server", message: copy.upstream });
      toast.error(copy.upstream);
      return;
    }
  }
  form.setError("root", { type: "server", message: copy.generic });
  toast.error(copy.generic);
}
