"use client";

/**
 * Notifications side panel (Epic #363, GLO-004).
 *
 * Matches `docs/design/global/notifications.html`: 400px-wide aside,
 * filter chips (Toutes/Donations/Team/System), per-row icon + accent
 * bar by visual category, unread/read styling, "mark all read" link
 * in the header, footer link to the preferences page.
 *
 * a11y:
 *   - `role="dialog"` with an `aria-label` so screen readers announce
 *     the panel context.
 *   - Filter chips wired as a `role="tablist"`.
 *   - Each item is a `role="listitem"` inside the panel's
 *     `role="list"` container.
 *   - `aria-live="polite"` on the unread badge so a fresh arrival is
 *     announced without stealing focus from typing.
 *   - Esc closes the panel; focus returns to the trigger button.
 */

import {
  getNotificationDescriptor,
  type NotificationFilterKey,
  type NotificationIconKey,
} from "@givernance/shared/constants";
import {
  Bell,
  Check,
  CircleDollarSign,
  Clock,
  ExternalLink,
  FileText,
  type LucideIcon,
  Image,
  Mail,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type RefObject, useCallback, useEffect, useRef } from "react";

import type { NotificationDto } from "@/services/NotificationsService";

/**
 * next-intl statically validates message keys; the dynamic
 * `${typeKey}.{title|body}` lookups below produce a `string` type the
 * compiler can't narrow to the strict union. Cast at the call site —
 * runtime correctness is covered by the i18n parity test in the
 * notifications integration suite.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(
  t: StrictTranslator,
  key: string,
  values?: Record<string, string | number | Date>,
): string {
  return (t as unknown as (k: string, v?: Record<string, string | number | Date>) => string)(
    key,
    values,
  );
}

interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
  rows: NotificationDto[];
  unread: number;
  nextCursor: string | null;
  isLoading: boolean;
  error: string | null;
  liveConnected: boolean;
  filter: NotificationFilterKey;
  onFilterChange: (next: NotificationFilterKey) => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
  /**
   * Element to return focus to when the panel closes. Required by the
   * dialog a11y pattern (WCAG 2.4.3) — without it focus lands on
   * `<body>` after Esc / close-button.
   */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const FILTER_KEYS: NotificationFilterKey[] = ["all", "donation", "team", "system"];

/**
 * Accent bar colour by visual category — matches
 * `docs/design/global/notifications.html` and `docs/27-notifications.md` § 1.
 * Indigo (not tertiary/amber) for the `team` category — the previous
 * mapping shipped amber, which conflicted with the reserved
 * `attention` slot (Frontend C1).
 */
const ACCENT_BY_VISUAL = {
  donation: "border-l-primary",
  team: "border-l-indigo",
  system: "border-l-sky",
  attention: "border-l-amber",
} as const;

const ICON_BG_BY_VISUAL = {
  donation: "bg-primary-fixed text-on-primary-fixed",
  team: "bg-indigo-light text-indigo",
  system: "bg-sky-light text-sky",
  attention: "bg-amber-light text-amber",
} as const;

/**
 * Lucide icon per `NotificationIconKey` (Frontend C2). The shared
 * registry stores a string slug so `@givernance/shared/constants`
 * stays lucide-free (ADR-013 type boundary).
 */
const ICON_COMPONENT: Record<NotificationIconKey, LucideIcon> = {
  donation: CircleDollarSign,
  invitation: UserPlus,
  branding: Image,
  postal_export: FileText,
  bulk_email: Mail,
  deadline: Clock,
};

export function NotificationsPanel({
  open,
  onClose,
  rows,
  unread,
  nextCursor,
  isLoading,
  error,
  liveConnected,
  filter,
  onFilterChange,
  onMarkRead,
  onMarkAllRead,
  onDelete,
  onLoadMore,
  triggerRef,
}: NotificationsPanelProps) {
  const t = useTranslations("notifications.panel");
  const tTypes = useTranslations("notifications.types");
  const locale = useLocale();
  const panelRef = useRef<HTMLElement>(null);

  // Wrap onClose so we always return focus to the trigger (Frontend
  // H1 — WCAG 2.4.3). The trigger ref is owned by the bell.
  const handleClose = useCallback(() => {
    onClose();
    // Use a microtask so React unmounts the panel before the focus
    // returns; otherwise focus-restore races with the unmount path.
    queueMicrotask(() => triggerRef.current?.focus());
  }, [onClose, triggerRef]);

  // Esc closes; Tab is trapped inside the panel so the user can't
  // tab-out into the underlying page (dialog pattern). Click-outside
  // is delegated via the overlay button.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    // Initial focus on the panel container — a screen reader user
    // tabs into the close button next; sighted keyboard users hit
    // Esc immediately.
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  if (!open) return null;

  const filteredRows =
    filter === "all"
      ? rows
      : rows.filter((row) => getNotificationDescriptor(row.type).visual === filter);

  return (
    <>
      {/* Click-outside overlay — transparent, full-viewport. */}
      <button
        type="button"
        className="fixed inset-0 z-[var(--z-overlay)] cursor-default bg-transparent"
        aria-label={t("dismissBackdrop")}
        onClick={handleClose}
        tabIndex={-1}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-label={t("ariaLabel")}
        tabIndex={-1}
        className="fixed right-0 top-0 z-[calc(var(--z-overlay)+1)] flex h-screen w-[400px] max-w-[100vw] flex-col border-l border-border bg-surface-container-lowest shadow-2xl"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 pt-5 pb-4">
          <div className="flex items-center gap-2">
            {/* Mockup specifies the title in heading-serif regular,
                not the body sans semibold (Frontend M1). */}
            <h2 className="font-heading text-xl font-normal text-text">{t("title")}</h2>
            {unread > 0 ? (
              <span
                aria-live="polite"
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-primary px-1.5 text-xs font-semibold text-on-primary"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
            {liveConnected ? (
              <span
                role="status"
                aria-label={t("liveOn")}
                title={t("liveOn")}
                className="inline-flex h-2 w-2 rounded-full bg-success"
              />
            ) : (
              <span
                role="status"
                aria-label={t("liveOff")}
                title={t("liveOff")}
                className="inline-flex h-2 w-2 rounded-full bg-text-muted"
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onMarkAllRead}
              disabled={unread === 0}
              className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary underline-offset-4 transition-colors hover:bg-surface-container-low hover:text-text hover:underline focus-visible:outline-none focus-visible:shadow-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("markAllRead")}
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t("close")}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-container-low hover:text-text focus-visible:outline-none focus-visible:shadow-ring"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Filter tabs */}
        <div
          role="tablist"
          aria-label={t("filtersLabel")}
          className="flex items-center gap-1 border-b border-border px-5 py-3"
        >
          {FILTER_KEYS.map((key) => {
            const active = filter === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => onFilterChange(key)}
                className={[
                  "rounded-pill border px-3 py-1 text-xs font-medium transition-colors duration-normal ease-out focus-visible:outline-none focus-visible:shadow-ring",
                  active
                    ? "border-primary-100 bg-primary-50 text-primary-dark"
                    : "border-transparent text-text-secondary hover:bg-surface-container-low hover:text-text",
                ].join(" ")}
              >
                {t(`filters.${key}`)}
              </button>
            );
          })}
        </div>

        {/* List — semantic <ul> per `lint/a11y/useSemanticElements`. */}
        <ul className="flex-1 overflow-y-auto">
          {error ? (
            <li className="list-none px-5 py-6 text-sm text-error" role="alert">
              {error}
            </li>
          ) : null}

          {filteredRows.length === 0 && !isLoading ? (
            <li className="flex list-none flex-col items-center justify-center gap-3 px-5 py-12 text-center">
              <Bell size={32} aria-hidden="true" className="text-text-muted" />
              <p className="text-sm font-medium text-text">{t("emptyTitle")}</p>
              <p className="max-w-[260px] text-xs text-text-muted">{t("emptyBody")}</p>
            </li>
          ) : null}

          {filteredRows.map((row) => {
            const descriptor = getNotificationDescriptor(row.type);
            const isUnread = !row.readAt;
            const accent = ACCENT_BY_VISUAL[descriptor.visual];
            const iconBg = ICON_BG_BY_VISUAL[descriptor.visual];

            // i18n params — the body uses {donorName}, {amountCents}, etc.
            // The renderer passes the entire `params` jsonb through next-intl
            // ICU; unknown placeholders fall through to the literal token,
            // which is acceptable (an operator running an older locale gets
            // a slightly raw row, not a crash).
            return (
              <li
                key={row.id}
                className={[
                  "flex items-start gap-3 border-b border-surface-container px-5 py-4 transition-colors duration-normal ease-out hover:bg-surface-container-lowest",
                  "border-l-[3px]",
                  isUnread
                    ? `${accent} bg-surface-container-lowest/60`
                    : "border-l-transparent bg-transparent",
                ].join(" ")}
              >
                <div
                  aria-hidden="true"
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${iconBg}`}
                >
                  {(() => {
                    const Icon = ICON_COMPONENT[descriptor.icon];
                    return <Icon size={16} />;
                  })()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className={[
                        "truncate text-sm",
                        isUnread ? "font-semibold text-text" : "font-medium text-text-secondary",
                      ].join(" ")}
                    >
                      {trDynamic(tTypes, `${descriptorMessageKey(descriptor.titleKey)}.title`)}
                    </p>
                    {isUnread ? (
                      <>
                        <span className="sr-only">{t("unreadDot")}</span>
                        <span
                          aria-hidden="true"
                          className="mt-1 inline-flex h-2 w-2 shrink-0 rounded-full bg-primary"
                        />
                      </>
                    ) : null}
                  </div>
                  <p
                    className={[
                      "mt-1 text-sm",
                      isUnread ? "text-text-secondary" : "text-text-muted",
                    ].join(" ")}
                  >
                    {trDynamic(tTypes, `${descriptorMessageKey(descriptor.bodyKey)}.body`, {
                      ...(row.params as Record<string, string | number | Date>),
                    })}
                  </p>
                  <p className="mt-1.5 text-xs text-text-muted">
                    {formatRelativeTimeShort(row.createdAt, locale)}
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    {row.linkUrl ? (
                      <Link
                        href={row.linkUrl}
                        onClick={() => {
                          if (isUnread) onMarkRead(row.id);
                        }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:shadow-ring"
                      >
                        {t("open")} <ExternalLink size={12} aria-hidden="true" />
                      </Link>
                    ) : null}
                    {isUnread ? (
                      <button
                        type="button"
                        onClick={() => onMarkRead(row.id)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:shadow-ring"
                      >
                        <Check size={12} aria-hidden="true" /> {t("markRead")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDelete(row.id)}
                      className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-error focus-visible:outline-none focus-visible:shadow-ring"
                    >
                      {t("delete")}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}

          {nextCursor ? (
            <li className="list-none px-5 py-4 text-center">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isLoading}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:shadow-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? t("loading") : t("loadMore")}
              </button>
            </li>
          ) : null}
        </ul>

        <footer className="border-t border-border px-5 py-3 text-center">
          <Link
            href="/profile/notifications"
            onClick={onClose}
            className="text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:shadow-ring"
          >
            {t("preferences")}
          </Link>
        </footer>
      </aside>
    </>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Convert a registry key like `notifications.types.donation_received.title`
 * to the namespace path next-intl expects:
 *   `donation_received` (consumed under `notifications.types`).
 *
 * The registry stores the full path so the email-digest worker can use
 * the same keys; the panel translator is scoped to
 * `notifications.types` so we strip the prefix.
 */
function descriptorMessageKey(fullKey: string): string {
  const parts = fullKey.split(".");
  // `notifications.types.<x>.{title|body|label|description}` → `<x>`
  return parts[2] ?? fullKey;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

function formatRelativeTimeShort(iso: string, locale: string): string {
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000;
  // Honour the consumer's locale (`useLocale()` from next-intl). A
  // French operator sees "il y a 2 heures"; an English one sees
  // "2 hours ago". Frontend M2 fix.
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= seconds || unit === "second") {
      return formatter.format(-Math.round(diff / seconds), unit);
    }
  }
  return iso;
}
