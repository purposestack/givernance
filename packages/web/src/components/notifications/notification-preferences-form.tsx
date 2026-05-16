"use client";

/**
 * Notification preferences form (Epic #363, GLO-004).
 *
 * One row per registered notification type × two checkboxes (in-app,
 * email digest). Optimistic update — toggle fires the PATCH and rolls
 * back the local row on error. No global "Save" button: each row is
 * an immediate, idempotent upsert (matches the `/settings/feature-flags`
 * pattern shipped in Epic #365).
 *
 * a11y:
 *   - Each row is a `<fieldset>` with the type label as `<legend>` so
 *     screen readers announce "Donation received — in-app on,
 *     email digest off".
 *   - Toggles use native checkboxes with descriptive `aria-label`s.
 *   - The "default" badge clarifies that no explicit row exists yet,
 *     so a user who has never touched the page sees what they'd
 *     receive today rather than an empty grid.
 */

import { NOTIFICATION_TYPE_REGISTRY, type NotificationType } from "@givernance/shared/constants";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { createClientApiClient } from "@/lib/api/client-browser";
import {
  type NotificationPreferenceDto,
  NotificationsService,
} from "@/services/NotificationsService";

/**
 * next-intl statically validates message keys at compile-time and the
 * template-literal builder we use below produces a `string` type that
 * can't be narrowed to the strict `NamespacedMessageKeys<...>` union.
 * Cast through `unknown` once at the call site — the integration test
 * in `packages/api/src/tests/integration/notifications.test.ts` checks
 * every key resolves at runtime, so this is a type-system papercut
 * not a runtime risk.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(
  t: StrictTranslator,
  key: string,
  values?: Record<string, string | number>,
): string {
  return (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
}

interface NotificationPreferencesFormProps {
  initial: NotificationPreferenceDto[];
}

interface RowState {
  type: NotificationType;
  inApp: boolean;
  emailDigest: boolean;
  isDefault: boolean;
  saving: boolean;
  error: string | null;
}

export function NotificationPreferencesForm({ initial }: NotificationPreferencesFormProps) {
  const t = useTranslations("notifications.preferencesPage");
  const tTypes = useTranslations("notifications.types");
  const [client] = useState(() => createClientApiClient());

  // Seed local state from the server snapshot. Every notification
  // type in the registry has a row — the API merges defaults so the
  // shape is closed.
  const [rows, setRows] = useState<RowState[]>(() =>
    NOTIFICATION_TYPE_REGISTRY.map((descriptor) => {
      const seed = initial.find((row) => row.type === descriptor.key);
      return {
        type: descriptor.key,
        inApp: seed?.inApp ?? descriptor.defaultInApp,
        emailDigest: seed?.emailDigest ?? descriptor.defaultEmailDigest,
        isDefault: seed?.isDefault ?? true,
        saving: false,
        error: null,
      };
    }),
  );

  const toggle = useCallback(
    async (type: NotificationType, field: "inApp" | "emailDigest", next: boolean) => {
      // Snapshot the row state INSIDE the functional setter so two
      // rapid toggles don't roll back to a stale value (Frontend M4).
      // The functional setter runs against the latest committed state
      // — capturing `previous` via `rows.find` from closure would read
      // pre-first-click state on the second double-click.
      let previous: RowState | null = null;
      setRows((current) =>
        current.map((row) => {
          if (row.type !== type) return row;
          previous = row;
          return { ...row, [field]: next, isDefault: false, saving: true, error: null };
        }),
      );
      if (!previous) return;
      const previousRow: RowState = previous;

      const payload = {
        inApp: field === "inApp" ? next : previousRow.inApp,
        emailDigest: field === "emailDigest" ? next : previousRow.emailDigest,
      };

      try {
        const updated = await NotificationsService.updatePreference(client, type, payload);
        setRows((current) =>
          current.map((row) =>
            row.type === type
              ? {
                  ...row,
                  inApp: updated.inApp,
                  emailDigest: updated.emailDigest,
                  isDefault: false,
                  saving: false,
                  error: null,
                }
              : row,
          ),
        );
      } catch (err) {
        setRows((current) =>
          current.map((row) =>
            row.type === type
              ? {
                  ...row,
                  inApp: previousRow.inApp,
                  emailDigest: previousRow.emailDigest,
                  isDefault: previousRow.isDefault,
                  saving: false,
                  error: err instanceof Error ? err.message : "Update failed",
                }
              : row,
          ),
        );
      }
    },
    [client],
  );

  return (
    <div className="rounded-lg border border-border bg-surface-container-lowest">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold text-text">{t("sectionTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t("sectionSubtitle")}</p>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.type}>
            <fieldset className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
              <legend className="sr-only">{trDynamic(tTypes, `${typeKey(row.type)}.label`)}</legend>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-text">
                    {trDynamic(tTypes, `${typeKey(row.type)}.label`)}
                  </p>
                  {row.isDefault ? (
                    <span className="rounded-pill border border-border bg-surface-container-low px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                      {t("defaultBadge")}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {trDynamic(tTypes, `${typeKey(row.type)}.description`)}
                </p>
                {row.error ? (
                  <p role="alert" className="mt-1 text-xs text-error">
                    {row.error}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-6">
                <ToggleCheckbox
                  checked={row.inApp}
                  disabled={row.saving}
                  onChange={(next) => void toggle(row.type, "inApp", next)}
                  label={t("inApp")}
                  hint={t("inAppHint")}
                />
                <ToggleCheckbox
                  checked={row.emailDigest}
                  disabled={row.saving}
                  onChange={(next) => void toggle(row.type, "emailDigest", next)}
                  label={t("emailDigest")}
                  hint={t("emailDigestHint")}
                />
              </div>
            </fieldset>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ToggleCheckboxProps {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
}

function ToggleCheckbox({ checked, disabled, onChange, label, hint }: ToggleCheckboxProps) {
  return (
    <label className="flex items-center gap-2 text-sm text-text">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={`${label} — ${hint}`}
        className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:shadow-ring"
      />
      <span className="select-none">{label}</span>
    </label>
  );
}

function typeKey(type: NotificationType): string {
  return type.replace(/\./g, "_");
}
