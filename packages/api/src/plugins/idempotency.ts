/**
 * Idempotency-Key enforcement (issue #56 API #2).
 *
 * Routes that mutate financial state (`POST /donations`, `POST /pledges`,
 * `POST /campaigns`, `POST /campaigns/:id/documents`) accept an
 * `Idempotency-Key` header so clients can safely retry on flaky networks
 * without double-charging / double-enqueueing. Before this plugin the header
 * was parsed in TypeBox but ignored — a retry would produce duplicate rows.
 *
 * Design:
 *   • Storage: Redis, TTL 24h (matches Stripe's idempotency window — clients
 *     that retry later than a day are treated as net-new requests).
 *   • Key namespace: `idem:<orgId>:<method>:<route>:<clientKey>` so the same
 *     client key used on two different endpoints (or two different tenants)
 *     never collides.
 *   • Two-phase lifecycle:
 *       (1) `preHandler` SET NX places a sentinel `__pending__` on first
 *           sighting. If the key already has a response, replay it with an
 *           `Idempotency-Replayed: true` hint and short-circuit the route.
 *       (2) `onSend` overwrites the sentinel with the serialised response
 *           envelope `{status, body, headers}` — but only for 2xx responses.
 *           4xx and 5xx both skip caching (PR #142 review H1): 4xx bodies
 *           often echo donor PII from validation context, so holding them in
 *           Redis for 24h would create a PII store outside the docs/17
 *           retention model, and 5xx caching would pin transient faults as a
 *           permanent reply. The tradeoff: a client retrying after a 400/409
 *           gets the route to re-run — deliberate, matches Stripe's
 *           end-result (they cache 4xx but within a compliance envelope we
 *           don't have).
 *       (3) Headers that matter for "create + follow" retries (`Location`,
 *           `ETag`, `Content-Type`, `retry-after`) are snapshot alongside the
 *           body so a replay re-emits them (PR #142 review O1). Without this,
 *           replayed 201s would lose their `Location` and clients following
 *           the header on retry would break silently.
 *   • Scope: `addIdempotency()` opts routes in explicitly. The plugin is a
 *     no-op for routes not configured, so existing GETs and non-financial
 *     POSTs pay zero cost.
 *
 * Known limitations (accepted for Phase 1, to revisit in a follow-up):
 *   • No request-fingerprint check. If a client sends the same key with a
 *     different body, we still replay the original response. Stripe detects
 *     this and 422s — we'll add it when we see real misuse.
 *   • Concurrent first-attempt collisions return "request already in flight"
 *     (409) rather than blocking. A client that issues two parallel requests
 *     with the same key deserves this.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type Redis from "ioredis";
import { redis as sharedRedis } from "../lib/redis.js";
import { problemDetail } from "../lib/schemas.js";

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h
const PENDING_SENTINEL = "__pending__";

interface CachedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Allowlist of response headers we snapshot + replay. Keep intentionally
 * narrow — we don't want to leak Set-Cookie, auth hints, or rate-limit state
 * across replays.
 */
const REPLAYED_HEADERS = ["location", "etag", "content-type", "retry-after"];

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set by `addIdempotency(app, { routes: [...] })`. */
    idempotency?: {
      /** Stable identifier for this route so the cache key doesn't collide. */
      routeKey: string;
    };
  }
  interface FastifyRequest {
    /** Populated after `preHandler`; `onSend` reads this to know where to cache. */
    idempotencyCacheKey?: string | null;
  }
}

function buildKey(orgId: string, routeKey: string, clientKey: string): string {
  return `idem:${orgId}:${routeKey}:${clientKey}`;
}

async function idempotency(app: FastifyInstance, opts: { redis?: Redis } = {}) {
  const redis = opts.redis ?? sharedRedis;

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const idemConfig = request.routeOptions.config?.idempotency;
    if (!idemConfig) return;

    const clientKey = (request.headers as Record<string, string | undefined>)["idempotency-key"];
    if (!clientKey) return; // header is optional — no key means no dedup

    const orgId = request.auth?.orgId;
    if (!orgId) return; // unauthenticated routes handle their own dedup (e.g. public/donate uses Stripe's)

    const cacheKey = buildKey(orgId, idemConfig.routeKey, clientKey);
    request.idempotencyCacheKey = cacheKey;

    // SET NX so only the first requestor "wins" and stores the sentinel.
    // EX ensures the sentinel expires even if the onSend hook crashes.
    const acquired = await redis.set(
      cacheKey,
      PENDING_SENTINEL,
      "EX",
      IDEMPOTENCY_TTL_SECONDS,
      "NX",
    );

    if (acquired === "OK") {
      // First time seeing this key — let the handler run; onSend will overwrite.
      return;
    }

    // Key already exists. Either a cached response or an in-flight duplicate.
    const cached = await redis.get(cacheKey);

    if (!cached || cached === PENDING_SENTINEL) {
      // In flight from another connection. Returning 409 is friendlier than a
      // blocking wait — the client can back off and retry. `retry-after: 2`
      // (PR #142 review Y7) gives slow handlers (e.g. PDF generation) a
      // chance to finish so the next retry lands on the cached response.
      return reply
        .status(409)
        .header("retry-after", "2")
        .send(
          problemDetail(
            409,
            "Conflict",
            "A request with this Idempotency-Key is already in progress. Retry shortly.",
          ),
        );
    }

    try {
      const { status, body, headers } = JSON.parse(cached) as CachedResponse;
      reply.header("idempotency-replayed", "true");
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          reply.header(name, value);
        }
      }
      // Skip the rest of the handler — the cached body IS the response.
      request.idempotencyCacheKey = null;
      return reply.status(status).send(body);
    } catch (err) {
      // Malformed cache entry — delete it, let the handler run fresh.
      request.log.warn(
        { err, cacheKey },
        "idempotency cache entry malformed; dropping and re-running handler",
      );
      await redis.del(cacheKey);
    }
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const cacheKey = request.idempotencyCacheKey;
    if (!cacheKey) return payload;

    // Only cache 2xx. 4xx bodies often contain echoed donor PII from
    // validation errors — Redis is not in the docs/17 PII retention model,
    // so we let 4xx re-execute on retry. 5xx never caches so transient
    // faults stay retryable. The pending sentinel still expires via TTL.
    // (PR #142 review H1.)
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      await redis.del(cacheKey);
      return payload;
    }

    let body: unknown;
    if (typeof payload === "string") {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    } else {
      body = payload;
    }

    // Snapshot the allowlisted headers so a replay re-emits `Location`,
    // `ETag`, etc. Without this, a retried `POST /donations` 201 loses its
    // `Location` header and clients relying on `Location: /v1/donations/:id`
    // to follow up break silently (PR #142 review O1).
    const capturedHeaders: Record<string, string> = {};
    for (const name of REPLAYED_HEADERS) {
      const value = reply.getHeader(name);
      if (typeof value === "string") {
        capturedHeaders[name] = value;
      } else if (typeof value === "number") {
        capturedHeaders[name] = String(value);
      }
    }

    const cached: CachedResponse = {
      status: reply.statusCode,
      body,
      ...(Object.keys(capturedHeaders).length > 0 ? { headers: capturedHeaders } : {}),
    };
    await redis.set(cacheKey, JSON.stringify(cached), "EX", IDEMPOTENCY_TTL_SECONDS);
    return payload;
  });
}

export const idempotencyPlugin = fp(idempotency, {
  name: "idempotency",
  dependencies: ["auth"],
});
