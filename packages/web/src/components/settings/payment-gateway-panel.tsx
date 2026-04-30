"use client";

import { CheckCircle2, CreditCard, Lock, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
import type { PaymentGatewayKey } from "@/models/public-page";
import {
  PaymentGatewayService,
  type PaymentGatewaySettings,
} from "@/services/PaymentGatewayService";

interface PaymentGatewayPanelProps {
  canManageTenant: boolean;
}

type Stage = "loading" | "idle" | "saving" | "error";

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiProblem) {
    return error.detail ?? error.title ?? fallback;
  }
  return fallback;
}

/**
 * Org-admin gateway selector (issue #62). Lets the operator switch between
 * Stripe / Mollie / Manual reconciliation, and paste a Mollie API key when
 * Mollie is selected. Mollie is gated by `ff.payments.mollie` — when the
 * flag is off the option is disabled in the dropdown so the operator sees
 * "why this isn't an option for me" rather than a silent omission.
 *
 * The Mollie API key field is intentionally an `<Input type="password">`
 * — the existing-stored key is NEVER pre-filled (the API only echoes a
 * `mollieConfigured` boolean), and we treat it as a write-only credential.
 * Storage at rest is plaintext today (see schema comment); rotating the
 * key from this UI is the operator's documented remediation path.
 */
export function PaymentGatewayPanel({ canManageTenant }: PaymentGatewayPanelProps) {
  const t = useTranslations("settings.paymentGateway");
  const [settings, setSettings] = useState<PaymentGatewaySettings | null>(null);
  const [selected, setSelected] = useState<PaymentGatewayKey>("stripe");
  const [mollieKey, setMollieKey] = useState("");
  const [stage, setStage] = useState<Stage>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canManageTenant) {
      setStage("idle");
      return;
    }
    let active = true;
    async function load() {
      try {
        const next = await PaymentGatewayService.getSettings(createClientApiClient());
        if (!active) return;
        setSettings(next);
        setSelected(next.paymentGateway);
        setStage("idle");
      } catch (err) {
        if (!active) return;
        setErrorMessage(resolveErrorMessage(err, t("errors.load")));
        setStage("error");
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [canManageTenant, t]);

  if (!canManageTenant) {
    return (
      <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
        <PanelHeader t={t} />
        <div className="mt-4 inline-flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
          <Lock size={16} aria-hidden="true" />
          <span>{t("adminOnly")}</span>
        </div>
      </section>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    setStage("saving");
    setErrorMessage(null);

    try {
      const updated = await PaymentGatewayService.updateSettings(createClientApiClient(), {
        paymentGateway: selected,
        // Only send the key field when the user actually typed something OR
        // when they switched off Mollie (so we leave the existing key alone
        // and don't accidentally clear it). When switching TO Mollie, a
        // typed key is required by the API; we surface the 400 if missing.
        ...(mollieKey ? { mollieApiKey: mollieKey } : {}),
      });
      setSettings(updated);
      setSelected(updated.paymentGateway);
      setMollieKey("");
      setStage("idle");
      toast.success(t("success.saved"));
    } catch (err) {
      const message = resolveErrorMessage(err, t("errors.save"));
      setErrorMessage(message);
      toast.error(message);
      setStage("idle");
    }
  }

  const flagOn = settings?.flags["ff.payments.mollie"] ?? false;
  const requiresMollieKey =
    selected === "mollie" && (settings?.paymentGateway !== "mollie" || !settings.mollieConfigured);

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
      <PanelHeader t={t} />
      {stage === "loading" ? (
        <p className="mt-4 text-sm text-on-surface-variant">{t("loading")}</p>
      ) : settings ? (
        <form className="mt-4 space-y-5" onSubmit={handleSubmit}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={settings.paymentGateway === "manual" ? "neutral" : "info"}>
              {t(`current.${settings.paymentGateway}`)}
            </Badge>
            {settings.paymentGateway === "mollie" && settings.mollieConfigured ? (
              <span className="inline-flex items-center gap-1 text-xs text-on-surface-variant">
                <CheckCircle2 size={12} aria-hidden="true" />
                {t("mollieKeyConfigured")}
              </span>
            ) : null}
            {!flagOn ? (
              <span className="text-xs text-on-surface-variant">{t("flagOffHint")}</span>
            ) : null}
          </div>

          <div className="space-y-2">
            <label htmlFor="payment-gateway-select" className="text-sm font-medium text-on-surface">
              {t("fields.gateway")}
            </label>
            <Select
              value={selected}
              onValueChange={(next) => setSelected(next as PaymentGatewayKey)}
            >
              <SelectTrigger id="payment-gateway-select" className="max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stripe">{t("options.stripe")}</SelectItem>
                <SelectItem value="mollie" disabled={!flagOn}>
                  {t("options.mollie")}
                </SelectItem>
                <SelectItem value="manual">{t("options.manual")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs leading-5 text-on-surface-variant">
              {t(`descriptions.${selected}`)}
            </p>
          </div>

          {selected === "mollie" ? (
            <div className="space-y-2">
              <label
                htmlFor="payment-gateway-mollie-key"
                className="text-sm font-medium text-on-surface"
              >
                {t("fields.mollieApiKey")}
                {requiresMollieKey ? <span className="ml-1 text-error">*</span> : null}
              </label>
              <Input
                id="payment-gateway-mollie-key"
                type="password"
                autoComplete="off"
                value={mollieKey}
                onChange={(e) => setMollieKey(e.target.value)}
                placeholder={t("fields.mollieApiKeyPlaceholder")}
                className="max-w-md"
              />
              <p className="text-xs leading-5 text-on-surface-variant">
                {t("fields.mollieApiKeyHint")}
              </p>
            </div>
          ) : null}

          {errorMessage ? <p className="text-sm text-error">{errorMessage}</p> : null}

          <Button type="submit" disabled={stage === "saving"}>
            <Wallet size={16} aria-hidden="true" />
            {stage === "saving" ? t("actions.saving") : t("actions.save")}
          </Button>
        </form>
      ) : errorMessage ? (
        <p className="mt-4 text-sm text-error">{errorMessage}</p>
      ) : null}
    </section>
  );
}

function PanelHeader({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div>
      <div className="inline-flex items-center gap-2 rounded-full bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
        <CreditCard size={12} aria-hidden="true" />
        {t("badge")}
      </div>
      <h2 className="mt-4 font-heading text-2xl leading-tight text-on-surface">{t("title")}</h2>
      <p className="mt-2 text-sm leading-6 text-on-surface-variant">{t("subtitle")}</p>
    </div>
  );
}
