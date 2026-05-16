"use client";

/**
 * Live notifications hook (Epic #363, GLO-004).
 *
 * Owns the topbar bell's unread count + the panel's list. Real-time
 * delivery falls back through three layers:
 *
 *   1. **SSE** — `GET /v1/notifications/stream` (`text/event-stream`).
 *      First-choice transport. EventSource auto-reconnects with
 *      `Last-Event-ID` so a brief network blip resumes from the last
 *      delivered row's `created_at` ISO.
 *   2. **Polling** — `GET /v1/notifications/unread-count` every 30s
 *      when the tab is focused. Engaged on SSE error, or unconditionally
 *      when EventSource is unavailable (jsdom test env, old browsers).
 *   3. **Manual refresh** — `refetch()` exposed for the click-to-open
 *      panel so opening it always shows fresh data even if the
 *      transport is unhealthy.
 *
 * The hook returns the unread count (capped at "9+" for the badge),
 * the list of recent rows (most recent N=20), loading/error flags, and
 * the imperative mutators (`markRead`, `markAllRead`, `deleteOne`,
 * `loadMore`).
 *
 * Polling cadence (30s) was chosen over a tighter cycle so the
 * background tab cost is low; SSE is the real "fast path" so we don't
 * burn CPU polling on focused tabs that are already streaming.
 */

import type { NotificationType } from "@givernance/shared/constants";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClientApiClient } from "@/lib/api/client-browser";
import {
  type NotificationDto,
  type NotificationListResponse,
  NotificationsService,
} from "@/services/NotificationsService";

interface UseNotificationsLiveOptions {
  /** Disable everything (e.g. flag is off — won't even mount the hook). */
  enabled: boolean;
  /** Polling cadence in ms when SSE is unavailable. */
  pollingMs?: number;
}

interface UseNotificationsLiveResult {
  unread: number;
  rows: NotificationDto[];
  nextCursor: string | null;
  isLoading: boolean;
  error: string | null;
  /** SSE active = green dot in the panel header. */
  liveConnected: boolean;
  refetch: () => Promise<void>;
  loadMore: (filter?: NotificationType | "all") => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  deleteOne: (id: string) => Promise<void>;
  reset: (filter: NotificationType | "all") => Promise<void>;
}

const DEFAULT_POLLING_MS = 30_000;

export function useNotificationsLive(
  options: UseNotificationsLiveOptions,
): UseNotificationsLiveResult {
  const [unread, setUnread] = useState(0);
  const [rows, setRows] = useState<NotificationDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);

  // Keep a stable client + refs across renders. The client is
  // browser-safe (per ADR-013) and shouldn't be re-instantiated on
  // every render.
  const clientRef = useRef<ReturnType<typeof createClientApiClient> | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createClientApiClient();
  }
  const client = clientRef.current;
  const filterRef = useRef<NotificationType | "all">("all");

  const fetchList = useCallback(
    async (opts: { reset: boolean; filter?: NotificationType | "all"; cursor?: string }) => {
      const filter = opts.filter ?? filterRef.current;
      filterRef.current = filter;
      try {
        setIsLoading(true);
        const result: NotificationListResponse = await NotificationsService.list(client, {
          cursor: opts.cursor,
          limit: 20,
          type: filter === "all" ? undefined : (filter as NotificationType),
        });
        setRows((current) => (opts.reset ? result.data : [...current, ...result.data]));
        setNextCursor(result.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load notifications");
      } finally {
        setIsLoading(false);
      }
    },
    [client],
  );

  const fetchUnreadCount = useCallback(async () => {
    try {
      const count = await NotificationsService.unreadCount(client);
      setUnread(count);
    } catch {
      // Soft-fail — the badge shows the last known good value rather
      // than flickering to 0 on a network blip.
    }
  }, [client]);

  const refetch = useCallback(async () => {
    await Promise.all([fetchUnreadCount(), fetchList({ reset: true })]);
  }, [fetchList, fetchUnreadCount]);

  const reset = useCallback(
    async (filter: NotificationType | "all") => {
      filterRef.current = filter;
      setRows([]);
      setNextCursor(null);
      await fetchList({ reset: true, filter });
    },
    [fetchList],
  );

  const loadMore = useCallback(
    async (filter?: NotificationType | "all") => {
      if (!nextCursor) return;
      await fetchList({ reset: false, filter, cursor: nextCursor });
    },
    [fetchList, nextCursor],
  );

  const markRead = useCallback(
    async (id: string) => {
      try {
        const updated = await NotificationsService.markRead(client, id);
        setRows((current) =>
          current.map((row) => (row.id === id ? { ...row, readAt: updated.readAt } : row)),
        );
        await fetchUnreadCount();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to mark read");
      }
    },
    [client, fetchUnreadCount],
  );

  const markAllRead = useCallback(async () => {
    try {
      await NotificationsService.markAllRead(client);
      const now = new Date().toISOString();
      setRows((current) => current.map((row) => (row.readAt ? row : { ...row, readAt: now })));
      setUnread(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark all read");
    }
  }, [client]);

  const deleteOne = useCallback(
    async (id: string) => {
      try {
        await NotificationsService.deleteOne(client, id);
        setRows((current) => current.filter((row) => row.id !== id));
        await fetchUnreadCount();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete");
      }
    },
    [client, fetchUnreadCount],
  );

  // Initial fetch + polling fallback when SSE is unavailable.
  useEffect(() => {
    if (!options.enabled) return;
    void refetch();
  }, [options.enabled, refetch]);

  // SSE subscription — falls back to polling if EventSource isn't
  // supported (jsdom test environment, very old browsers) or if the
  // server returns an error within the first few seconds.
  useEffect(() => {
    if (!options.enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      // No SSE — start polling immediately.
      return startPolling();
    }

    const url = NotificationsService.resolveStreamUrl(client);
    let source: EventSource | null = null;
    let pollingCleanup: (() => void) | null = null;

    try {
      // `withCredentials: true` so the session cookie rides along.
      source = new EventSource(url, { withCredentials: true });

      source.addEventListener("ready", () => {
        setLiveConnected(true);
      });

      source.addEventListener("notification", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as NotificationDto;
          setRows((current) => {
            // Dedupe by id — a polling cycle that overlaps an SSE
            // delivery would otherwise show the row twice.
            if (current.some((row) => row.id === payload.id)) return current;
            return [payload, ...current];
          });
          if (!payload.readAt) {
            setUnread((c) => c + 1);
          }
        } catch {
          // Malformed payload — silently ignore. Real errors surface
          // via the `error` handler below.
        }
      });

      source.addEventListener("error", () => {
        setLiveConnected(false);
        // EventSource will auto-reconnect; we just engage polling as
        // a parallel safety net so users see fresh data even if the
        // proxy is rejecting event-stream.
        pollingCleanup ??= startPolling();
      });
    } catch {
      // EventSource construction failed (e.g. CSP block) — polling
      // fallback only.
      pollingCleanup ??= startPolling();
    }

    return () => {
      source?.close();
      setLiveConnected(false);
      pollingCleanup?.();
    };

    function startPolling(): () => void {
      const intervalMs = options.pollingMs ?? DEFAULT_POLLING_MS;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        if (document.visibilityState === "visible") {
          await fetchUnreadCount();
        }
      };
      const intervalId = setInterval(tick, intervalMs);
      const onVisible = () => {
        if (document.visibilityState === "visible") void fetchUnreadCount();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        stopped = true;
        clearInterval(intervalId);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
  }, [client, fetchUnreadCount, options.enabled, options.pollingMs]);

  return {
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
  };
}

export function formatBadgeCount(value: number): string {
  if (value <= 0) return "";
  if (value > 9) return "9+";
  return String(value);
}
