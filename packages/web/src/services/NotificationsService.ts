import type { ApiClient } from "@/lib/api";

/**
 * Notifications service (Epic #363, GLO-004) — ADR-011 Layer 2.
 *
 * Wraps `/v1/notifications*` + `/v1/notification-preferences*`. The
 * REST surface is per-recipient: every call resolves the current
 * user from the session cookie, so there are no `userId` arguments
 * here.
 *
 * SSE endpoint (`/v1/notifications/stream`) is consumed via the
 * `useNotificationsLive` hook — not exposed as a method here because
 * EventSource has different cookie semantics (auto-attaches the
 * session cookie when `withCredentials: true`) and the lifecycle is
 * subscription-shaped, not request/response.
 */

import type { NotificationType } from "@givernance/shared/constants";

export interface NotificationDto {
  id: string;
  orgId: string;
  userId: string | null;
  type: NotificationType;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  linkUrl: string | null;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  data: NotificationDto[];
  nextCursor: string | null;
}

export interface NotificationPreferenceDto {
  type: NotificationType;
  inApp: boolean;
  emailDigest: boolean;
  /** True when no explicit row exists — `inApp`/`emailDigest` are the registry default. */
  isDefault: boolean;
}

export interface ListNotificationsOptions {
  cursor?: string;
  limit?: number;
  type?: NotificationType;
  onlyUnread?: boolean;
  signal?: AbortSignal;
}

export const NotificationsService = {
  async list(
    client: ApiClient,
    options: ListNotificationsOptions = {},
  ): Promise<NotificationListResponse> {
    return client.get<NotificationListResponse>("/v1/notifications", {
      signal: options.signal,
      params: {
        cursor: options.cursor,
        limit: options.limit,
        type: options.type,
        onlyUnread: options.onlyUnread,
      },
    });
  },

  async unreadCount(client: ApiClient, signal?: AbortSignal): Promise<number> {
    const response = await client.get<{ data: { unread: number } }>(
      "/v1/notifications/unread-count",
      { signal },
    );
    return response.data.unread;
  },

  async markRead(client: ApiClient, id: string): Promise<NotificationDto> {
    const response = await client.patch<{ data: NotificationDto }>(`/v1/notifications/${id}/read`);
    return response.data;
  },

  async markAllRead(client: ApiClient): Promise<number> {
    const response = await client.post<{ data: { marked: number } }>("/v1/notifications/read-all");
    return response.data.marked;
  },

  /**
   * Auto-mark-read every unread, panel-visible notification pointing at
   * `linkUrl` for the current user. The web shell fires this on every
   * pathname change so the bell badge stays in sync with what the user
   * has actually looked at — see doc 27 § "Auto-mark-read on
   * consumption". Idempotent; returns 0 when no row matches.
   */
  async markReadByLink(client: ApiClient, linkUrl: string): Promise<number> {
    const response = await client.post<{ data: { marked: number } }>(
      "/v1/notifications/mark-read-by-link",
      { linkUrl },
    );
    return response.data.marked;
  },

  async deleteOne(client: ApiClient, id: string): Promise<NotificationDto> {
    const response = await client.delete<{ data: NotificationDto }>(`/v1/notifications/${id}`);
    return response.data;
  },

  async listPreferences(client: ApiClient): Promise<NotificationPreferenceDto[]> {
    const response = await client.get<{ data: NotificationPreferenceDto[] }>(
      "/v1/notification-preferences",
    );
    return response.data;
  },

  async updatePreference(
    client: ApiClient,
    type: NotificationType,
    body: { inApp: boolean; emailDigest: boolean },
  ): Promise<NotificationPreferenceDto> {
    const response = await client.patch<{ data: NotificationPreferenceDto }>(
      `/v1/notification-preferences/${encodeURIComponent(type)}`,
      body,
    );
    return response.data;
  },

  /**
   * Resolve the SSE URL on the browser. The hook does its own
   * `new EventSource(url, { withCredentials: true })` — we just give
   * it the host-correct path. Mirrors `client.resolveBrowserUrl`
   * convention from Epic #214.
   */
  resolveStreamUrl(client: ApiClient): string {
    return client.resolveBrowserUrl("/v1/notifications/stream");
  },
};
