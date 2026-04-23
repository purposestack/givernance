"use client";

import { Building2, ChevronRight, Clock, ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { useForm } from "react-hook-form";

import { Form, FormField, FormItem, FormMessage } from "@/components/shared/form-field";
import { FormSection } from "@/components/shared/form-section";
import { Button } from "@/components/ui/button";
import type { OrgMembership } from "@/services/OrgPickerService";
import { switchOrg } from "@/services/OrgPickerService";

interface Props {
  memberships: OrgMembership[];
  defaultOrgId?: string;
}

interface OrgPickerValues {
  selectedOrgId: string;
}

/** Org picker list — keyboard-navigable cards (issue #112 / doc 22 §6.3). */
export function OrgPickerClient({ memberships, defaultOrgId }: Props) {
  const t = useTranslations("auth.selectOrganization");

  const sorted = useMemo(() => {
    const primary = memberships.find((membership) => membership.orgId === defaultOrgId);
    const rest = memberships.filter((membership) => membership.orgId !== defaultOrgId);
    return primary ? [primary, ...rest] : memberships;
  }, [defaultOrgId, memberships]);

  const form = useForm<OrgPickerValues>({
    defaultValues: {
      selectedOrgId: sorted[0]?.orgId ?? "",
    },
  });

  const selectedOrgId = form.watch("selectedOrgId");
  const currentMembership = sorted.find((membership) => membership.orgId === selectedOrgId);

  const handleSubmit = useCallback(
    async (values: OrgPickerValues) => {
      if (!values.selectedOrgId) {
        form.setError("selectedOrgId", {
          type: "manual",
          message: t("errors.generic"),
        });
        return;
      }

      try {
        form.clearErrors();
        const res = await switchOrg(values.selectedOrgId);
        // Persist the cookie-based "last org" so a future login skips the picker
        // if the user is still solo on it. 30-day lifespan mirrors the picker UX.
        // biome-ignore lint/suspicious/noDocumentCookie: intentional non-httpOnly cookie read server-side to seed the picker default; Cookie Store API has insufficient browser support for our Scaleway target matrix (ADR-011).
        document.cookie = `gv-last-org=${encodeURIComponent(res.targetSlug)}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`;
        // Force a fresh JWT: the server blocklisted the current token, so a
        // naïve `router.push` would get rejected. Round-trip through the
        // login endpoint with a hint so Keycloak emits a token with the
        // target `org_id` claim (#114 wires Keycloak 26 Organizations).
        window.location.href = `/api/auth/login?hint=${encodeURIComponent(res.targetSlug)}`;
      } catch (err) {
        const message =
          err instanceof Error && err.message === "Forbidden"
            ? t("errors.forbidden")
            : t("errors.generic");
        form.setError("root", {
          type: "server",
          message,
        });
      }
    },
    [form, t],
  );

  const rootError = form.formState.errors.root?.message;
  const isSubmitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-0">
        {rootError ? (
          <div
            role="alert"
            aria-live="polite"
            className="mb-6 flex items-start gap-3 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{rootError}</span>
          </div>
        ) : null}

        <FormSection
          title={t("sections.workspace.title")}
          description={t("sections.workspace.description")}
          className="border-b-0 py-0"
        >
          <FormField
            control={form.control}
            name="selectedOrgId"
            render={({ field }) => (
              <FormItem>
                <div role="radiogroup" aria-label={t("title")} className="space-y-3">
                  {sorted.map((membership) => (
                    <label
                      key={membership.orgId}
                      htmlFor={membership.orgId}
                      className={`flex cursor-pointer items-center gap-4 rounded-xl border p-4 transition-colors duration-normal ease-out focus-within:shadow-ring ${
                        field.value === membership.orgId
                          ? "border-primary bg-primary-50"
                          : "border-outline-variant bg-surface-container-lowest hover:border-primary"
                      }`}
                    >
                      <input
                        id={membership.orgId}
                        type="radio"
                        name={field.name}
                        value={membership.orgId}
                        checked={field.value === membership.orgId}
                        onChange={() => field.onChange(membership.orgId)}
                        className="sr-only"
                      />
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container-low text-text">
                        <Building2 size={18} aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-text">{membership.name}</span>
                          <span className="rounded-full bg-surface-container px-2 py-0.5 text-xs text-text-secondary">
                            {membership.role}
                          </span>
                          {membership.firstAdmin && membership.provisionalUntil ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-light px-2 py-0.5 text-xs text-amber-text">
                              <ShieldCheck size={12} aria-hidden="true" />
                              {t("provisional")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-muted">
                          <span className="truncate">{membership.slug}</span>
                          {membership.lastVisitedAt ? (
                            <span className="inline-flex items-center gap-1">
                              <Clock size={12} aria-hidden="true" />
                              {t("lastVisited", {
                                date: new Date(membership.lastVisitedAt).toLocaleDateString(),
                              })}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <ChevronRight size={16} aria-hidden="true" className="text-text-muted" />
                    </label>
                  ))}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        <div className="flex flex-col gap-3 border-t border-outline-variant pt-6">
          <div className="text-sm text-on-surface-variant">
            {currentMembership ? t("currentSelection", { name: currentMembership.name }) : null}
          </div>
          <Button type="submit" size="lg" disabled={isSubmitting} className="w-full sm:w-auto">
            {isSubmitting ? t("submitting") : t("continue")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
