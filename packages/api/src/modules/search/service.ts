/**
 * Global search service — backs `GET /v1/search` (Epic #364, GLO-001).
 *
 * Strategy (full rationale in docs/29-global-search.md §3):
 *
 *   - Postgres FTS via `to_tsvector('simple', …)` + GIN indices on the
 *     concatenated name / description fields (migration 0062). The
 *     'simple' dictionary is intentional: Givernance tenants mix French
 *     and English records and a stemmed dictionary would corrupt
 *     surnames ("Fontaine" → "fontain") and English brand-name campaigns.
 *
 *   - `pg_trgm` similarity for typo tolerance on short fields (donor
 *     names, campaign names). Combined with `ILIKE '%q%'`, this catches
 *     partial typed queries ("mar" → "Marie") that FTS misses because
 *     `plainto_tsquery` needs a full lexeme.
 *
 *   - Three queries per request (one per entity), executed inside a
 *     single transaction with `withTenantContext` set. RLS is the
 *     safety net; the application code carries explicit
 *     `eq(<table>.orgId, orgId)` per the CLAUDE.md §"RLS is the safety
 *     net, never the contract" rule (issue #430).
 *
 *   - Each entity is capped at `PER_GROUP_LIMIT` so a flood of donor
 *     matches can't bury campaigns or donations. Total wire size is
 *     bounded by `3 × PER_GROUP_LIMIT`.
 *
 *   - Ranking inside a group is `ts_rank + trigram-similarity`, tiebroken
 *     on recency. Donations rank by name-similarity + a payment-ref /
 *     receipt-number exact-match boost.
 *
 * Query-injection safety:
 *   - The user's query is NEVER concatenated into SQL. It's bound as a
 *     parameter via Drizzle's `sql` template, both for the FTS arm
 *     (`plainto_tsquery('simple', ${q})`) and the trigram arm
 *     (where `likeQ` is a pre-built `%…%` string bound as a single
 *     parameter).
 *   - We sanitise the raw query (length cap, NUL / C0 / C1 control-byte
 *     strip, whitespace collapse) before binding. Anything else passes
 *     through to the parameter binder unchanged — pg's parameteriser
 *     handles the escape.
 */

import { campaigns, constituents, donations } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

/** Hard cap on result rows per entity group. Keeps the wire payload bounded. */
export const PER_GROUP_LIMIT = 5;

/** Minimum query length before we hit the DB. Anything shorter is too noisy. */
export const MIN_QUERY_LENGTH = 2;

/** Hard cap on accepted query length. Mirrors the route schema. */
export const MAX_QUERY_LENGTH = 200;

export interface SearchHit {
  /** Entity type discriminator — drives the icon + href on the frontend. */
  type: "constituent" | "campaign" | "donation";
  /** Stable entity id (UUID). */
  id: string;
  /** Primary display label (e.g. constituent full name, campaign name, donation reference). */
  title: string;
  /** Secondary line (e.g. "donor · Marseille", "500 EUR · 25 Feb 2026"). May be empty. */
  subtitle: string;
  /** Frontend route to navigate to on selection (no host, no locale prefix). */
  href: string;
}

export interface SearchResult {
  query: string;
  groups: {
    constituents: SearchHit[];
    campaigns: SearchHit[];
    donations: SearchHit[];
  };
}

/**
 * Normalise a raw query string into a form safe to bind as an FTS /
 * trigram parameter. Returns `null` if the result is too short to be
 * useful (covers empty / whitespace-only / control-char-only queries).
 *
 * Length is enforced at the route schema (`MAX_QUERY_LENGTH`) so this
 * is purely defensive — never trust the caller.
 */
export function normaliseQuery(raw: string): string | null {
  // Drop NUL + C0 / C1 control characters before pg's parameter binder
  // sees the string. Postgres rejects NUL in text outright, and the
  // other controls are useless noise in a search box. Codepoint
  // filtering avoids Biome's `noControlCharactersInRegex` rule.
  let scrubbed = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    // Allow tab / LF / CR through as whitespace (collapsed below);
    // strip everything else in C0 (0x00-0x1f) and C1 (0x7f-0x9f).
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      scrubbed += " ";
      continue;
    }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    scrubbed += ch;
  }
  const cleaned = scrubbed.replace(/\s+/g, " ").trim();

  if (cleaned.length < MIN_QUERY_LENGTH) return null;
  if (cleaned.length > MAX_QUERY_LENGTH) return cleaned.slice(0, MAX_QUERY_LENGTH);
  return cleaned;
}

export async function search(orgId: string, rawQuery: string): Promise<SearchResult> {
  const q = normaliseQuery(rawQuery);
  if (!q) {
    return {
      query: rawQuery,
      groups: { constituents: [], campaigns: [], donations: [] },
    };
  }

  // `%q%` for ILIKE / trigram. `plainto_tsquery` handles the FTS arm.
  const likeQ = `%${q}%`;
  const limit = PER_GROUP_LIMIT;

  return withTenantContext(orgId, async (tx) => {
    // ─── Constituents ───────────────────────────────────────────────────
    // Combine FTS (token boundary) + trigram (typo tolerance) + ILIKE
    // (substring). Rank: ts_rank + similarity, tiebreak on recency.
    //
    // RLS provides defence in depth, but the explicit `org_id = ${orgId}`
    // filter is the contract (CLAUDE.md §"RLS is the safety net").
    const constituentRows = await tx.execute<{
      id: string;
      first_name: string;
      last_name: string;
      type: string | null;
      city: string | null;
      score: number;
    }>(sql`
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        c.type,
        c.city,
        (
          ts_rank(
            to_tsvector(
              'simple',
              coalesce(c.first_name, '') || ' ' ||
              coalesce(c.last_name, '') || ' ' ||
              coalesce(c.email, '') || ' ' ||
              coalesce(c.city, '')
            ),
            plainto_tsquery('simple', ${q})
          )
          + similarity(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''), ${q})
        )::float AS score
      FROM ${constituents} c
      WHERE c.org_id = ${orgId}
        AND c.deleted_at IS NULL
        AND (
          to_tsvector(
            'simple',
            coalesce(c.first_name, '') || ' ' ||
            coalesce(c.last_name, '') || ' ' ||
            coalesce(c.email, '') || ' ' ||
            coalesce(c.city, '')
          ) @@ plainto_tsquery('simple', ${q})
          OR (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ILIKE ${likeQ}
          OR coalesce(c.email, '') ILIKE ${likeQ}
        )
      ORDER BY score DESC, c.updated_at DESC
      LIMIT ${limit}
    `);

    // ─── Campaigns ──────────────────────────────────────────────────────
    const campaignRows = await tx.execute<{
      id: string;
      name: string;
      type: string;
      status: string;
      score: number;
    }>(sql`
      SELECT
        c.id,
        c.name,
        c.type,
        c.status,
        (
          ts_rank(
            to_tsvector('simple', coalesce(c.name, '') || ' ' || coalesce(c.description, '')),
            plainto_tsquery('simple', ${q})
          )
          + similarity(coalesce(c.name, ''), ${q})
        )::float AS score
      FROM ${campaigns} c
      WHERE c.org_id = ${orgId}
        AND (
          to_tsvector('simple', coalesce(c.name, '') || ' ' || coalesce(c.description, ''))
            @@ plainto_tsquery('simple', ${q})
          OR c.name ILIKE ${likeQ}
        )
      ORDER BY score DESC, c.updated_at DESC
      LIMIT ${limit}
    `);

    // ─── Donations ──────────────────────────────────────────────────────
    // Donations have no FTS column (free-form text is sparse — only
    // `payment_ref` and `receipt_number`). We search:
    //   - donations whose constituent name matches the query (JOIN +
    //     trigram on the constituent's name) — this is the dominant
    //     use case ("find Marie's donations")
    //   - donations whose payment_ref or receipt_number matches the
    //     literal query (case-insensitive substring) — covers the
    //     "look up D-2026-0142" path
    //
    // The JOIN carries `eq(donations.orgId, orgId)` AND
    // `eq(constituents.orgId, orgId)` so a leaked / guessed constituent
    // UUID cannot smuggle a cross-tenant join hit.
    const donationRows = await tx.execute<{
      id: string;
      amount_cents: number;
      currency: string;
      donated_at: Date;
      payment_ref: string | null;
      receipt_number: string | null;
      first_name: string;
      last_name: string;
      score: number;
    }>(sql`
      SELECT
        d.id,
        d.amount_cents,
        d.currency,
        d.donated_at,
        d.payment_ref,
        d.receipt_number,
        c.first_name,
        c.last_name,
        (
          similarity(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''), ${q})
          + CASE
              WHEN coalesce(d.payment_ref, '') ILIKE ${likeQ} THEN 0.5
              WHEN coalesce(d.receipt_number, '') ILIKE ${likeQ} THEN 0.5
              ELSE 0
            END
        )::float AS score
      FROM ${donations} d
      JOIN ${constituents} c
        ON c.id = d.constituent_id
        AND c.org_id = d.org_id
      WHERE d.org_id = ${orgId}
        AND c.org_id = ${orgId}
        AND c.deleted_at IS NULL
        AND (
          (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ILIKE ${likeQ}
          OR coalesce(d.payment_ref, '') ILIKE ${likeQ}
          OR coalesce(d.receipt_number, '') ILIKE ${likeQ}
        )
      ORDER BY score DESC, d.donated_at DESC
      LIMIT ${limit}
    `);

    return {
      query: q,
      groups: {
        constituents: constituentRows.rows.map((row) => formatConstituent(row)),
        campaigns: campaignRows.rows.map((row) => formatCampaign(row)),
        donations: donationRows.rows.map((row) => formatDonation(row)),
      },
    };
  });
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatConstituent(row: {
  id: string;
  first_name: string;
  last_name: string;
  type: string | null;
  city: string | null;
}): SearchHit {
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  const subtitleParts = [row.type, row.city].filter((v): v is string => Boolean(v && v.length > 0));
  return {
    type: "constituent",
    id: row.id,
    title: fullName || "—",
    subtitle: subtitleParts.join(" · "),
    href: `/constituents/${row.id}`,
  };
}

function formatCampaign(row: {
  id: string;
  name: string;
  type: string;
  status: string;
}): SearchHit {
  const subtitleParts = [row.type, row.status].filter(Boolean);
  return {
    type: "campaign",
    id: row.id,
    title: row.name,
    subtitle: subtitleParts.join(" · "),
    href: `/campaigns/${row.id}`,
  };
}

function formatDonation(row: {
  id: string;
  amount_cents: number;
  currency: string;
  donated_at: Date | string;
  payment_ref: string | null;
  receipt_number: string | null;
  first_name: string;
  last_name: string;
}): SearchHit {
  const donorName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  const amount = formatAmount(row.amount_cents, row.currency);
  const donatedAt = row.donated_at instanceof Date ? row.donated_at : new Date(row.donated_at);
  const dateStr = Number.isNaN(donatedAt.getTime()) ? "" : donatedAt.toISOString().slice(0, 10);
  const title = row.receipt_number
    ? `Don ${row.receipt_number}`
    : row.payment_ref
      ? `Don ${row.payment_ref}`
      : `Don ${row.id.slice(0, 8)}`;
  const subtitleParts = [amount, donorName, dateStr].filter(Boolean);
  return {
    type: "donation",
    id: row.id,
    title,
    subtitle: subtitleParts.join(" · "),
    href: `/donations/${row.id}`,
  };
}

function formatAmount(cents: number, currency: string): string {
  const major = (cents / 100).toFixed(2);
  return `${major} ${currency}`;
}
