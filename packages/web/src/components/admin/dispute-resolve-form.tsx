"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useId, useState } from "react";
import { type DisputeResolution, resolveDisputeApi } from "@/services/DisputesService";

/**
 * Super-admin resolution form for a dispute (issue #113 / doc 22 §4.3).
 *
 * Three outcomes: `kept` (first admin stays), `replaced` (disputer becomes
 * the new admin, former admin demoted to `user`), or `escalated_to_support`
 * (manual follow-up outside the app).
 */
export function DisputeResolveForm({ disputeId }: { disputeId: string }) {
  const t = useTranslations("admin.disputes.detail.resolve");
  const router = useRouter();

  const groupId = useId();
  const [choice, setChoice] = useState<DisputeResolution>("kept");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const options: Array<{
    value: DisputeResolution;
    label: "options.kept.label" | "options.replaced.label" | "options.escalated_to_support.label";
    hint: "options.kept.hint" | "options.replaced.hint" | "options.escalated_to_support.hint";
  }> = [
    { value: "kept", label: "options.kept.label", hint: "options.kept.hint" },
    { value: "replaced", label: "options.replaced.label", hint: "options.replaced.hint" },
    {
      value: "escalated_to_support",
      label: "options.escalated_to_support.label",
      hint: "options.escalated_to_support.hint",
    },
  ];

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setSubmitting(true);
      setError(undefined);
      try {
        await resolveDisputeApi(disputeId, choice);
        router.refresh();
      } catch (err) {
        // Log every failure so silent TypeErrors don't disappear into the
        // generic toast — matches the pattern in constituent-form,
        // donation-form, and fund-form. This form has only one field so
        // the only realistic failure modes are network or API problems,
        // but the breadcrumb is cheap and prevents the next regression
        // from being invisible.
        // biome-ignore lint/suspicious/noConsole: intentional breadcrumb for unexpected client-side failures
        console.error("DisputeResolveForm submit failed:", err);
        setError(t("errors.generic"));
      } finally {
        setSubmitting(false);
      }
    },
    [choice, disputeId, router, t],
  );

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
    >
      <h2 className="text-sm font-semibold text-text-secondary">{t("title")}</h2>
      <fieldset aria-labelledby={`${groupId}-label`} className="space-y-2">
        <legend id={`${groupId}-label`} className="sr-only">
          {t("title")}
        </legend>
        {options.map((opt) => (
          <label
            key={opt.value}
            htmlFor={`${groupId}-${opt.value}`}
            className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm transition-colors duration-normal ease-out focus-within:ring-2 focus-within:ring-primary ${
              choice === opt.value
                ? "border-primary bg-primary-50"
                : "border-outline-variant hover:border-primary"
            }`}
          >
            <input
              id={`${groupId}-${opt.value}`}
              type="radio"
              name={groupId}
              value={opt.value}
              checked={choice === opt.value}
              onChange={() => setChoice(opt.value)}
              className="sr-only"
            />
            <div>
              <p className="font-medium text-text">{t(opt.label)}</p>
              <p className="mt-0.5 text-xs text-text-muted">{t(opt.hint)}</p>
            </div>
          </label>
        ))}
      </fieldset>

      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex h-[var(--btn-height-md)] items-center justify-center gap-2 rounded-button bg-primary px-6 text-sm font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
        ) : null}
        {t("submit")}
      </button>
    </form>
  );
}
