"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { PlatformAdminService } from "@/services/PlatformAdminService";

interface FormValues {
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * Invite-a-platform-admin form (issue #254). Behind the `(admin)/layout.tsx`
 * super_admin gate. The submit:
 *   1) provisions a Keycloak user with the `super_admin` realm role,
 *   2) attaches them to the "Givernance Platform" Keycloak Organization,
 *   3) triggers a UPDATE_PASSWORD email so the new admin sets their own
 *      password on first login,
 *   4) writes a `platform_admin.created` audit row under the platform tenant.
 *
 * Identity invariant (ADR-022): the API refuses with 409 if the email
 * already belongs to a tenant `users` row — the form maps that to a
 * targeted field error instead of a generic toast.
 */
export function NewPlatformAdminForm() {
  const t = useTranslations("admin.platformAdmins.new");
  const router = useRouter();
  const form = useForm<FormValues>({
    mode: "onBlur",
    defaultValues: { firstName: "", lastName: "", email: "" },
  });

  async function onSubmit(values: FormValues) {
    const client = createClientApiClient();
    try {
      await PlatformAdminService.create(client, {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
      });
      toast.success(t("success"));
      router.push("/admin/platform-admins");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiProblem) {
        const detail = err.detail ?? "";
        if (err.status === 409) {
          if (/tenant member/i.test(detail)) {
            form.setError("email", { type: "server", message: t("errors.emailTakenByTenant") });
            return;
          }
          if (/Keycloak user with this email/i.test(detail)) {
            form.setError("email", {
              type: "server",
              message: t("errors.emailTakenByKeycloak"),
            });
            return;
          }
          form.setError("email", { type: "server", message: t("errors.emailTakenByAdmin") });
          return;
        }
        if (err.status === 502) {
          toast.error(t("errors.keycloakMisconfig"));
          return;
        }
      }
      toast.error(t("errors.generic"));
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="firstName"
            rules={{ required: true, minLength: 1, maxLength: 255 }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.firstName")}</FormLabel>
                <FormControl>
                  <Input {...field} autoComplete="given-name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="lastName"
            rules={{ required: true, minLength: 1, maxLength: 255 }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fields.lastName")}</FormLabel>
                <FormControl>
                  <Input {...field} autoComplete="family-name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="email"
          rules={{
            required: true,
            pattern: {
              value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
              message: "",
            },
            maxLength: 255,
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("fields.email")}</FormLabel>
              <FormControl>
                <Input {...field} type="email" autoComplete="email" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t("submitting") : t("submit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.back()}
            disabled={form.formState.isSubmitting}
          >
            {t("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
