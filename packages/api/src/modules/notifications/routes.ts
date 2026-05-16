/**
 * Notification centre routes (Epic #363, GLO-004).
 *
 * Every route is gated by `requireFlag(COMMUNICATION_NOTIFICATIONS_CENTER)`
 * as the FIRST preHandler — a disabled tenant gets a 404, indistinguishable
 * from a typo'd URL. Auth runs second.
 *
 * RBAC: every authenticated tenant member sees their OWN notifications and
 * their OWN preferences. No role restriction beyond auth — viewers,
 * users, and org_admins all get the panel. The service layer enforces
 * `user_id = currentUserId` so a tenant member can never read another
 * member's notifications even within the same tenant.
 *
 * Wire format: `{ data: ... }` envelope (consistent with every other
 * Givernance module). RFC 9457 problem+json on every error path.
 */

import {
  FEATURE_FLAG_KEYS,
  NOTIFICATION_TYPE_VALUES,
  type NotificationType,
} from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireFlag } from "../../lib/flags/flag-guard.js";
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
  // Flag gate FIRST so an unauthenticated scanner cannot enumerate
  // gated routes by their auth requirement. See `requireFlag` JSDoc.
  app.get(
    "/notifications",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
      schema: {
        tags: ["Notifications"],
        querystring: NotificationListQuery,
        response: { 200: NotificationListResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const query = request.query as {
        cursor?: string;
        limit?: number;
        type?: NotificationType;
        onlyUnread?: boolean;
      };
      const result = await listNotifications(orgId, userId, query);
      return {
        data: result.data.map(serializeNotification),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get(
    "/notifications/unread-count",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
      schema: {
        tags: ["Notifications"],
        response: { 200: UnreadCountResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const unread = await getUnreadCount(orgId, userId);
      return { data: { unread } };
    },
  );

  app.patch(
    "/notifications/:id/read",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
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
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const updated = await markRead(orgId, userId, id);
      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Notification not found"));
      }
      return { data: serializeNotification(updated) };
    },
  );

  app.post(
    "/notifications/read-all",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
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
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const marked = await markAllRead(orgId, userId);
      return { data: { marked } };
    },
  );

  app.delete(
    "/notifications/:id",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
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
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const deleted = await softDeleteNotification(orgId, userId, id);
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
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      // Set headers BEFORE hijacking. Disable Fastify's reply
      // serialization once headers are flushed.
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      // Some proxies (nginx default) buffer event-stream; disable
      // explicitly so the first event reaches the client without
      // waiting for the buffer to fill.
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.hijack();
      reply.raw.flushHeaders();

      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        // SSE comment frame — ignored by the EventSource client but
        // keeps the TCP connection alive across idle proxies.
        try {
          reply.raw.write(": heartbeat\n\n");
        } catch {
          controller.abort();
        }
      }, 25_000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        controller.abort();
      });

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

        const stream = streamNotifications(orgId, userId, {
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
        clearInterval(heartbeat);
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
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
      schema: {
        tags: ["Notifications"],
        response: { 200: PreferenceListResponse, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      return listPreferences(orgId, userId);
    },
  );

  app.patch(
    "/notification-preferences/:type",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER), requireAuth],
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
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { type } = request.params as { type: NotificationType };
      const body = request.body as { inApp: boolean; emailDigest: boolean };
      const updated = await updatePreference(orgId, userId, type, body);
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
