"use client";

import { LOCALE_NATIVE_NAMES, type Locale, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { MULTI_CURRENCY_VALUES } from "@givernance/shared/validators";
import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { LogoUploadCard } from "@/components/branding/logo-upload-card";
import { Button } from "@/components/ui/button";
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
import type { TenantCurrency } from "@/models/tenant";
import { TenantService } from "@/services/TenantService";

const TENANT_CURRENCIES = MULTI_CURRENCY_VALUES;

function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiProblem) {
    return error.detail ?? error.title ?? fallback;
  }
  return fallback;
}

interface TenantSettingsFormProps {
  orgId?: string;
  canManageTenant: boolean;
  /**
   * Org name used as the seed for the initial-letter fallback when no
   * logo has been uploaded yet. Resolved server-side in the page so the
   * fallback paints with the right glyph on first frame.
   */
  orgName?: string;
  /**
   * Org-admin gate for the embedded logo upload subsection. Same role
   * as `canManageTenant` today; kept as a separate prop so a future
   * fine-grained `branding_admin` role doesn't bleed back into the
   * currency / locale form.
   */
  canManageBranding?: boolean;
}

export function TenantSettingsForm({
  orgId,
  canManageTenant,
  orgName,
  canManageBranding,
}: TenantSettingsFormProps) {
  const t = useTranslations("settings.tenant");
  const router = useRouter();
  const tenantOrgId = orgId;
  const [baseCurrency, setBaseCurrency] = useState<TenantCurrency>("EUR");
  const [initialCurrency, setInitialCurrency] = useState<TenantCurrency>("EUR");
  const [defaultLocale, setDefaultLocale] = useState<Locale>("fr");
  const [initialDefaultLocale, setInitialDefaultLocale] = useState<Locale>("fr");
  const [mission, setMission] = useState<string>("");
  const [initialMission, setInitialMission] = useState<string>("");
  const [tenantName, setTenantName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantOrgId || !canManageTenant) {
      setLoading(false);
      return;
    }

    let active = true;

    async function loadTenant(nextOrgId: string) {
      try {
        const tenant = await TenantService.getTenant(createClientApiClient(), nextOrgId);
        if (!active) return;
        setTenantName(tenant.name);
        setBaseCurrency(tenant.baseCurrency);
        setInitialCurrency(tenant.baseCurrency);
        setDefaultLocale(tenant.defaultLocale);
        setInitialDefaultLocale(tenant.defaultLocale);
        const tenantMission = tenant.mission ?? "";
        setMission(tenantMission);
        setInitialMission(tenantMission);
      } catch (error) {
        if (!active) return;
        setErrorMessage(resolveApiErrorMessage(error, t("errors.load")));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadTenant(tenantOrgId);

    return () => {
      active = false;
    };
  }, [canManageTenant, t, tenantOrgId]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantOrgId || !canManageTenant || saving) return;

    setSaving(true);
    setErrorMessage(null);

    try {
      // Send only the changed fields so a future audit on this PATCH
      // surfaces just the operator's intent, not a no-op of every field.
      const patch: {
        baseCurrency?: TenantCurrency;
        defaultLocale?: Locale;
        mission?: string | null;
      } = {};
      if (baseCurrency !== initialCurrency) patch.baseCurrency = baseCurrency;
      if (defaultLocale !== initialDefaultLocale) patch.defaultLocale = defaultLocale;
      if (mission !== initialMission) {
        // Empty string ⇒ explicit clear (NULL on the API side); non-empty
        // string ⇒ set. Trim before send so a stray whitespace-only edit
        // doesn't pollute the audit trail with a no-op-ish change.
        const trimmed = mission.trim();
        patch.mission = trimmed.length > 0 ? trimmed : null;
      }
      const tenant = await TenantService.updateTenant(createClientApiClient(), tenantOrgId, patch);
      setTenantName(tenant.name);
      setBaseCurrency(tenant.baseCurrency);
      setInitialCurrency(tenant.baseCurrency);
      setDefaultLocale(tenant.defaultLocale);
      setInitialDefaultLocale(tenant.defaultLocale);
      const nextMission = tenant.mission ?? "";
      setMission(nextMission);
      setInitialMission(nextMission);
      toast.success(t("success.updated"));
      // Issue #153: re-run server components so the new tenant default
      // takes effect for users with `users.locale = NULL` without a
      // manual reload. The org_admin themselves only sees a UI shift
      // when they don't have a personal override.
      router.refresh();
    } catch (error) {
      const message = resolveApiErrorMessage(error, t("errors.save"));
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const isDirty =
    baseCurrency !== initialCurrency ||
    defaultLocale !== initialDefaultLocale ||
    mission !== initialMission;

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
      <div className="max-w-3xl">
        <h2 className="font-heading text-2xl leading-tight text-on-surface">{t("title")}</h2>
        <p className="mt-2 text-sm leading-6 text-on-surface-variant">{t("description")}</p>
      </div>

      {/* Visual identity (Epic #286) — sits at the top of the Organisation
          card alongside currency / locale / mission, rather than floating
          as a separate hero. Anchors `/settings#branding` from the
          dashboard "Add your logo" banner. */}
      {tenantOrgId ? (
        <div id="branding" className="mt-6 border-b border-outline-variant pb-6">
          <LogoUploadCard
            orgName={orgName ?? tenantName}
            tenantId={tenantOrgId}
            canManageBranding={canManageBranding ?? canManageTenant}
            variant="embedded"
          />
        </div>
      ) : null}

      {canManageTenant && tenantOrgId ? (
        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="tenant-base-currency" className="text-sm font-medium text-on-surface">
                {t("fields.baseCurrency")}
              </label>
              <Select
                value={baseCurrency}
                onValueChange={(value) => setBaseCurrency(value as TenantCurrency)}
                disabled={loading || saving}
              >
                <SelectTrigger id="tenant-base-currency" aria-label={t("fields.baseCurrency")}>
                  <SelectValue placeholder={t("fields.baseCurrencyPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {TENANT_CURRENCIES.map((currency) => (
                    <SelectItem key={currency} value={currency}>
                      {currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-on-surface-variant">
                {tenantName
                  ? t("fields.baseCurrencyHintWithName", { name: tenantName })
                  : t("fields.baseCurrencyHint")}
              </p>
            </div>

            {/*
             * Issue #153 — tenant default locale. Changing this does NOT
             * touch any user's `users.locale`: members with an explicit
             * personal preference keep it; members with NULL follow the
             * new default on next read.
             */}
            <div className="space-y-2">
              <label
                htmlFor="tenant-default-locale"
                className="text-sm font-medium text-on-surface"
              >
                {t("fields.defaultLocale")}
              </label>
              <Select
                value={defaultLocale}
                onValueChange={(value) => setDefaultLocale(value as Locale)}
                disabled={loading || saving}
              >
                <SelectTrigger id="tenant-default-locale" aria-label={t("fields.defaultLocale")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_LOCALES.map((locale) => (
                    // Endonym — name in its own script so the picker
                    // stays readable even when the app is in a language
                    // the org_admin doesn't speak.
                    <SelectItem key={locale} value={locale}>
                      {LOCALE_NATIVE_NAMES[locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-on-surface-variant">{t("fields.defaultLocaleHint")}</p>
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="tenant-mission" className="text-sm font-medium text-on-surface">
              {t("fields.mission")}
            </label>
            <Textarea
              id="tenant-mission"
              value={mission}
              onChange={(event) => setMission(event.target.value)}
              disabled={loading || saving}
              maxLength={1000}
              rows={4}
              placeholder={t("fields.missionPlaceholder")}
            />
            <p className="text-xs text-on-surface-variant">{t("fields.missionHint")}</p>
          </div>

          {errorMessage ? <p className="text-sm text-error">{errorMessage}</p> : null}

          <div className="flex items-center justify-end gap-3">
            <Button type="submit" disabled={loading || saving || !isDirty}>
              {saving ? t("actions.saving") : t("actions.save")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-6 inline-flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
          <Lock size={16} aria-hidden="true" />
          <span>{t("readOnly")}</span>
        </div>
      )}
    </section>
  );
}
