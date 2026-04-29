"use client";

import { AlertTriangle, CreditCard, ExternalLink, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { StripeConnectService, type StripeConnectStatus } from "@/services/StripeConnectService";

interface StripeConnectPanelProps {
  canManageTenant: boolean;
}

type Stage = "idle" | "loading" | "starting" | "error";

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiProblem) {
    return error.detail ?? error.title ?? fallback;
  }
  return fallback;
}

export function StripeConnectPanel({ canManageTenant }: StripeConnectPanelProps) {
  const t = useTranslations("settings.stripeConnect");
  const [status, setStatus] = useState<StripeConnectStatus | null>(null);
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
        const next = await StripeConnectService.getStatus(createClientApiClient());
        if (!active) return;
        setStatus(next);
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

  async function handleStart() {
    if (!canManageTenant || stage === "starting") return;
    setStage("starting");
    setErrorMessage(null);

    try {
      const here = window.location.href;
      const link = await StripeConnectService.startOnboarding(createClientApiClient(), {
        // Stripe loops back to `refreshUrl` if the operator abandons the
        // hosted form, and to `returnUrl` after they finish (success or not —
        // we re-fetch status to know which).
        refreshUrl: here,
        returnUrl: here,
      });
      // Open in the same tab — the GET status call on return reflects the
      // new account state, so the operator sees the resolved badge without
      // a manual reload.
      window.location.assign(link.url);
    } catch (err) {
      const message = resolveErrorMessage(err, t("errors.start"));
      setErrorMessage(message);
      toast.error(message);
      setStage("idle");
    }
  }

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
            <CreditCard size={12} aria-hidden="true" />
            {t("badge")}
          </div>
          <h2 className="mt-4 font-heading text-2xl leading-tight text-on-surface">{t("title")}</h2>
          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            {t(`description.${describeState(status)}`)}
          </p>

          {status ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusBadge status={status} t={t} />
              {status.accountId ? (
                <span className="font-mono text-xs text-on-surface-variant">
                  {status.accountId}
                </span>
              ) : null}
            </div>
          ) : null}

          {status && status.accountId && !status.chargesEnabled ? (
            <RequirementsList status={status} />
          ) : null}

          {errorMessage ? <p className="mt-3 text-sm text-error">{errorMessage}</p> : null}
        </div>

        <div className="flex shrink-0 flex-col items-start gap-3">
          {canManageTenant ? (
            <Button onClick={handleStart} disabled={stage !== "idle" || !status}>
              <ExternalLink size={16} aria-hidden="true" />
              {stage === "starting"
                ? t("actions.starting")
                : status?.chargesEnabled
                  ? t("actions.manage")
                  : status?.accountId
                    ? t("actions.continue")
                    : t("actions.connect")}
            </Button>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
              <Lock size={16} aria-hidden="true" />
              <span>{t("adminOnly")}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: StripeConnectStatus;
  t: ReturnType<typeof useTranslations>;
}) {
  if (status.chargesEnabled) {
    return <Badge variant="success">{t("status.connected")}</Badge>;
  }
  if (status.accountId) {
    return <Badge variant="warning">{t("status.pending")}</Badge>;
  }
  return <Badge variant="neutral">{t("status.notConnected")}</Badge>;
}

/**
 * Map the live status to the i18n key suffix that drives the descriptive
 * copy. Falls back to the not-connected description while the status fetch
 * is in flight — the operator sees the right call-to-action immediately
 * rather than "loading…", and once the GET resolves the copy swaps to
 * "Connected" if applicable. Issue #192 follow-up.
 */
function describeState(
  status: StripeConnectStatus | null,
): "notConnected" | "pending" | "connected" {
  if (!status || !status.accountId) return "notConnected";
  if (status.chargesEnabled) return "connected";
  return "pending";
}

/**
 * Render the remediation list when an account is onboarded but charges
 * are disabled. Stripe gives us machine-readable requirement keys (e.g.
 * `external_account`, `individual.id_number`); we translate them via
 * i18n to human-readable labels and fall back to the raw key for
 * requirement keys we haven't translated yet (so the operator at least
 * sees what's missing rather than a localised "?"). Issue #201.
 */
function RequirementsList({ status }: { status: StripeConnectStatus }) {
  const t = useTranslations("settings.stripeConnect.requirements");
  const tFields = useTranslations("settings.stripeConnect.requirements.fields");

  if (status.requirementsCurrentlyDue.length === 0 && !status.disabledReason) {
    return null;
  }

  return (
    // `tertiary` is the design-system's amber/warning tone — the right
    // palette here precisely *because* this is a remediation state the
    // operator needs to act on, contrast with the test-mode banner which
    // is informational and uses `secondary-fixed`.
    <div className="mt-4 rounded-2xl border border-tertiary bg-tertiary-container px-4 py-3 text-sm text-on-tertiary-container">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <div className="space-y-2">
          <p className="font-semibold">{t("title")}</p>
          {status.requirementsCurrentlyDue.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {status.requirementsCurrentlyDue.map((key) => {
                // Translate known requirement keys; fall back to the raw key
                // for ones we haven't covered yet (Stripe ships ~20 of them).
                let label: string;
                try {
                  label = tFields(key as never);
                } catch {
                  label = key;
                }
                return (
                  <li key={key}>
                    <span>{label}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {status.disabledReason ? (
            <p className="text-xs">
              {t("disabledReason")}: <code>{status.disabledReason}</code>
            </p>
          ) : null}
          <p className="text-xs">{t("hint")}</p>
        </div>
      </div>
    </div>
  );
}
