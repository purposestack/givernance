/**
 * Notification centre routes (Epic #363, GLO-004).
 *
 * RBAC: every authenticated tenant member sees their OWN notifications and
 * their OWN preferences. No role restriction beyond auth — viewers,
 * users, and org_admins all get the panel. The service layer enforces
 * `user_id = currentUserId` so a tenant member can never read another
 * member's notifications even within the same tenant.
 *
 * Identifier discipline: `notifications.user_id` and
 * `notification_preferences.user_id` are FK'd to `users.id` (row UUID),
 * NOT `users.keycloak_id`. Routes must pass `request.auth.userRowId`
 * (the resolved `users.id`) to the service — passing
 * `request.auth.userId` (= Keycloak `sub`) silently returns zero rows
 * for any real user since `users.id != keycloak_id` in production seeds.
 * A null `userRowId` means the caller has no `users` row (super-admin,
 * or DB blip in the active-row resolver) and the panel is not
 * applicable: respond 401 rather than leaking that distinction.
 *
 * Wire format: `{ data: ... }` envelope (consistent with every other
 * Givernance module). RFC 9457 problem+json on every error path.
 */

import { NOTIFICATION_TYPE_VALUES, type NotificationType } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import {
  DataResponse,
  ErrorResponses,
  IdParams,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  getUnreadCount,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  markReadByLink,
  softDeleteNotification,
  streamNotifications,
  updatePreference,
} from "./service.js";

// ─── Schemas ────────────────────────────────────────────────────────

const NotificationTypeSchema = Type.Union(NOTIFICATION_TYPE_VALUES.map((v) => Type.Literal(v)));

const NotificationResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  userId: Type.Union([UuidSchema, Type.Null()]),
  type: NotificationTypeSchema,
  titleKey: Type.String(),
  bodyKey: Type.String(),
  params: Type.Record(Type.String(), Type.Unknown()),
  linkUrl: Type.Union([Type.String(), Type.Null()]),
  readAt: Type.Union([Type.String(), Type.Null()]),
  archivedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

const NotificationListQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  type: Type.Optional(NotificationTypeSchema),
  onlyUnread: Type.Optional(Type.Boolean()),
});

const NotificationListResponse = Type.Object({
  data: Type.Array(NotificationResponse),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

const UnreadCountResponse = Type.Object({
  data: Type.Object({ unread: Type.Integer({ minimum: 0 }) }),
});

const PreferenceRowSchema = Type.Object({
  type: NotificationTypeSchema,
  inApp: Type.Boolean(),
  emailDigest: Type.Boolean(),
  isDefault: Type.Boolean(),
});

const PreferenceListResponse = Type.Object({
  data: Type.Array(PreferenceRowSchema),
});

const PreferenceUpdateBody = Type.Object({
  inApp: Type.Boolean(),
  emailDigest: Type.Boolean(),
});

const PreferenceParams = Type.Object({
  type: NotificationTypeSchema,
});

// ─── Routes ─────────────────────────────────────────────────────────

export async function notificationRoutes(app: FastifyInstance) {
  app.get(
    "/notifications",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        querystring: NotificationListQuery,
        response: { 200: NotificationListResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const query = request.query as {
        cursor?: string;
        limit?: number;
        type?: NotificationType;
        onlyUnread?: boolean;
      };
      const result = await listNotifications(orgId, userRowId, query);
      return {
        data: result.data.map(serializeNotification),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get(
    "/notifications/unread-count",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        response: { 200: UnreadCountResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const unread = await getUnreadCount(orgId, userRowId);
      return { data: { unread } };
    },
  );

  app.patch(
    "/notifications/:id/read",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        params: IdParams,
        response: {
          200: DataResponse(NotificationResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const updated = await markRead(orgId, userRowId, id);
      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Notification not found"));
      }
      return { data: serializeNotification(updated) };
    },
  );

  app.post(
    "/notifications/read-all",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        response: {
          200: Type.Object({ data: Type.Object({ marked: Type.Integer({ minimum: 0 }) }) }),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const marked = await markAllRead(orgId, userRowId);
      return { data: { marked } };
    },
  );

  // ─── Auto-mark-read by link_url ─────────────────────────────────────
  //
  // POSTed by the web shell whenever the caller's pathname changes —
  // the convention is "landing on a notification's link_url means the
  // user has consumed the linked resource and the bell ping is stale".
  // The endpoint is idempotent and returns 0 in the common case (no
  // unread notif points at the current path), so the layout-level hook
  // can fire it unconditionally without worrying about noise.
  //
  // Mirrors `docs/27-notifications.md` § "Auto-mark-read on consumption".
  app.post(
    "/notifications/mark-read-by-link",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        body: Type.Object({
          // Match the schema's CHECK on `notifications.link_url`: must
          // be a relative path starting with `/` and not `//` (which a
          // browser resolves as protocol-relative).
          linkUrl: Type.String({
            minLength: 2,
            maxLength: 2048,
            pattern: "^/(?!/).*$",
          }),
        }),
        response: {
          200: Type.Object({ data: Type.Object({ marked: Type.Integer({ minimum: 0 }) }) }),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { linkUrl } = request.body as { linkUrl: string };
      const marked = await markReadByLink(orgId, userRowId, linkUrl);
      return { data: { marked } };
    },
  );

  app.delete(
    "/notifications/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        params: IdParams,
        response: {
          200: DataResponse(NotificationResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const deleted = await softDeleteNotification(orgId, userRowId, id);
      if (!deleted) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Notification not found"));
      }
      return { data: serializeNotification(deleted) };
    },
  );

  // ─── SSE stream (Phase 4) ──────────────────────────────────────────
  //
  // text/event-stream — no swagger schema (binary-ish content). The
  // route handler hijacks the raw response stream and writes SSE
  // frames directly. Heartbeat every 25s keeps Cloudflare / Kamal
  // proxy from idling-out the connection.
  app.get(
    "/notifications/stream",
    {
      preHandler: requireAuth,
      // Rate-limit the SSE handshake (not the long-lived stream
      // itself — `@fastify/rate-limit` only sees the initial request).
      // 5 opens / minute / IP is plenty for the ordinary "swap polling
      // for SSE" path and prevents a single authenticated user from
      // bursting hundreds of streams (Security M1).
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      // SSE open / close audit — the audit plugin only fires on
      // POST/PUT/PATCH/DELETE, so a long-lived authenticated GET
      // exfiltration would otherwise have no row. Emit an explicit
      // `notifications.stream.opened` before hijack so SIEM has the
      // signal even if the stream is short-lived. Mirrors the
      // PATCH/DELETE shape the existing audit plugin records.
      //
      // Audit attribution keys on the Keycloak `sub` (matches the
      // `audit_logs.user_id` column elsewhere in the codebase); the row
      // id we later hand to the streaming service is logged separately
      // so a SIEM correlator can join the two without ambiguity.
      request.log.info(
        {
          event: "audit.notifications.stream.opened",
          orgId,
          userId,
          userRowId,
          impersonationSessionId: request.auth?.impersonation?.sessionId,
        },
        "SSE stream opened",
      );

      // Set headers BEFORE hijacking. Disable Fastify's reply
      // serialization once headers are flushed.
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      // Some proxies (nginx default) buffer event-stream; disable
      // explicitly so the first event reaches the client without
      // waiting for the buffer to fill.
      reply.raw.setHeader("X-Accel-Buffering", "no");
      // Defence-in-depth content-sniffing posture (Security M2). A
      // malformed first frame on a misconfigured proxy could be
      // sniffed as HTML by legacy browsers — `nosniff` shuts the
      // door.
      reply.raw.setHeader("X-Content-Type-Options", "nosniff");
      reply.hijack();
      reply.raw.flushHeaders();

      const controller = new AbortController();
      const cleanup = (reason: string) => {
        clearInterval(heartbeat);
        controller.abort();
        request.log.info(
          {
            event: "audit.notifications.stream.closed",
            orgId,
            userId,
            reason,
          },
          "SSE stream closed",
        );
      };
      const heartbeat = setInterval(() => {
        // SSE comment frame — ignored by the EventSource client but
        // keeps the TCP connection alive across idle proxies.
        try {
          reply.raw.write(": heartbeat\n\n");
        } catch {
          cleanup("heartbeat-write-failed");
        }
      }, 25_000);

      request.raw.on("close", () => cleanup("client-disconnect"));

      try {
        // First event: a `ready` ping so the client knows the
        // stream is open and can downgrade the polling fallback.
        reply.raw.write("event: ready\ndata: {}\n\n");

        // Honour `Last-Event-ID` header for reconnect — the value
        // is the ISO timestamp of the most-recently-delivered row.
        const lastEventId = request.headers["last-event-id"];
        const since =
          typeof lastEventId === "string" && lastEventId.length > 0
            ? new Date(lastEventId)
            : undefined;

        const stream = streamNotifications(orgId, userRowId, {
          signal: controller.signal,
          intervalMs: 5_000,
          since: Number.isNaN(since?.getTime() ?? NaN) ? undefined : since,
        });
        for await (const row of stream) {
          const payload = JSON.stringify(serializeNotification(row));
          reply.raw.write(`id: ${row.createdAt.toISOString()}\n`);
          reply.raw.write(`event: notification\n`);
          reply.raw.write(`data: ${payload}\n\n`);
        }
      } catch (err) {
        request.log.warn({ err }, "SSE stream errored");
      } finally {
        cleanup("stream-end");
        try {
          reply.raw.end();
        } catch {
          // already closed
        }
      }
    },
  );

  // ─── Preferences ────────────────────────────────────────────────────

  app.get(
    "/notification-preferences",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        response: { 200: PreferenceListResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      return listPreferences(orgId, userRowId);
    },
  );

  app.patch(
    "/notification-preferences/:type",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Notifications"],
        params: PreferenceParams,
        body: PreferenceUpdateBody,
        response: {
          200: DataResponse(PreferenceRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { type } = request.params as { type: NotificationType };
      const body = request.body as { inApp: boolean; emailDigest: boolean };
      const updated = await updatePreference(orgId, userRowId, type, body);
      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Unknown notification type"));
      }
      return { data: updated };
    },
  );
}

function serializeNotification(row: {
  id: string;
  orgId: string;
  userId: string | null;
  type: string;
  titleKey: string;
  bodyKey: string;
  params: unknown;
  linkUrl: string | null;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    type: row.type as NotificationType,
    titleKey: row.titleKey,
    bodyKey: row.bodyKey,
    params: (row.params ?? {}) as Record<string, unknown>,
    linkUrl: row.linkUrl,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
