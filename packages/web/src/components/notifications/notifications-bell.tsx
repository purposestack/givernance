"use client";

/**
 * Topbar notifications bell (Epic #363, GLO-004).
 *
 * Renders the bell button + the dynamic unread badge. Owns the panel
 * open/close state and forwards the live data to `NotificationsPanel`.
 *
 * Mounted ONLY when the `communication.notifications_center` flag is
 * on for this tenant — the wrapper in `topbar.tsx` short-circuits
 * before this component is even loaded by Next.js (off-state QA per
 * `feedback_feature_flag_first`).
 */

import type { NotificationFilterKey } from "@givernance/shared/constants";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { NotificationsPanel } from "./notifications-panel";
import { formatBadgeCount, useNotificationsLive } from "./use-notifications-live";

export function NotificationsBell() {
  const t = useTranslations("notifications.bell");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilterKey>("all");

  const {
    unread,
    rows,
    nextCursor,
    isLoading,
    error,
    liveConnected,
    refetch,
    loadMore,
    markRead,
    markAllRead,
    deleteOne,
    reset,
  } = useNotificationsLive({ enabled: true });

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      // Opening the panel always refetches — closes a polling gap
      // (e.g. a row arrived while the tab was backgrounded).
      if (next) void refetch();
      return next;
    });
  }, [refetch]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleFilterChange = useCallback(
    (next: NotificationFilterKey) => {
      setFilter(next);
      void reset(next === "all" ? "all" : (filterToType(next) ?? "all"));
    },
    [reset],
  );

  const badge = formatBadgeCount(unread);

  return (
    <>
      <button
        type="button"
        onClick={handleToggle}
        aria-label={unread > 0 ? t("triggerWithUnread", { count: unread }) : t("trigger")}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors duration-normal ease-out hover:bg-surface-container-low hover:text-text focus-visible:outline-none focus-visible:shadow-ring data-[state=open]:bg-primary-50 data-[state=open]:text-primary-dark"
        data-state={open ? "open" : "closed"}
      >
        <Bell size={18} aria-hidden="true" />
        {badge ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-primary px-1 text-[10px] font-semibold leading-none text-on-primary"
          >
            {badge}
          </span>
        ) : null}
      </button>
      <NotificationsPanel
        open={open}
        onClose={handleClose}
        rows={rows}
        unread={unread}
        nextCursor={nextCursor}
        isLoading={isLoading}
        error={error}
        liveConnected={liveConnected}
        filter={filter}
        onFilterChange={handleFilterChange}
        onMarkRead={markRead}
        onMarkAllRead={markAllRead}
        onDelete={deleteOne}
        onLoadMore={() => void loadMore()}
      />
    </>
  );
}

/**
 * The filter chips map to `notificationFilterFor()` categories — the
 * server expects a notification `type` though, not a visual category.
 * For now the panel does category filtering CLIENT-side over the
 * already-loaded rows (correct because the API returns all visible
 * types in one call); the chip change therefore doesn't translate to
 * a server `type` argument. Returning `null` here keeps the hook's
 * reset() filter on "all" so subsequent paginated loads cover every
 * type.
 */
function filterToType(_filter: NotificationFilterKey): null {
  return null;
}
