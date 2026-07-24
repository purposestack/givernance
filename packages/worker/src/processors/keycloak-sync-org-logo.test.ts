/**
 * Unit tests for `processKeycloakSyncOrgLogo` — focused on the
 * `brandingPipeline` end-to-end latency discriminator (issue #290).
 *
 * No DB / Keycloak: `db`, `updateOrganization`, `brandingPublicUrl`
 * and `jobLogger` are mocked so the tests pin down (a) when the
 * discriminator is emitted (upload path only, first delivery only —
 * never on clear/delete, not-ready, missing hero variant, soft-deleted
 * asset, at-least-once re-delivery, or KC PATCH failure), (b) that
 * `e2eLatencyMs` is measured AFTER the KC PATCH — the mock advances
 * the fake clock while the PATCH is in flight, so a computation hoisted
 * above the `await` yields a detectably smaller delta — and (c) the
 * 0-clamp under pathological clock skew.
 */

import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sequential result queue: first shift = tenants SELECT, second = asset SELECT.
const selectResults: unknown[][] = [];
vi.mock("../lib/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selectResults.shift() ?? []),
      }),
    }),
  },
}));

const updateOrganization = vi.fn();
vi.mock("../lib/keycloak-admin.js", () => ({
  updateOrganization: (...args: unknown[]) => updateOrganization(...args),
}));

vi.mock("../lib/s3.js", () => ({
  brandingPublicUrl: (key: string) => `https://cdn.test/${key}`,
}));

type CapturedLine = { obj: Record<string, unknown>; msg: string };
const logLines: CapturedLine[] = [];
const capture = (obj: Record<string, unknown>, msg: string) => {
  logLines.push({ obj, msg });
};
vi.mock("../lib/logger.js", () => ({
  jobLogger: () => ({ info: capture, warn: capture, error: capture }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

const { processKeycloakSyncOrgLogo } = await import("./keycloak-sync-org-logo.js");

const ORG_ID = "11111111-1111-7111-8111-111111111111";
const ASSET_ID = "22222222-2222-7222-8222-222222222222";

/** Simulated KC PATCH round-trip duration burned on the fake clock. */
const KC_PATCH_MS = 500;

function jobFor(): Job<{ orgId: string; traceparent?: string }> {
  return { id: "test-job", data: { orgId: ORG_ID } } as unknown as Job<{
    orgId: string;
    traceparent?: string;
  }>;
}

function tenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: ORG_ID, keycloakOrgId: "kc-org-1", logoAssetId: ASSET_ID, ...overrides };
}

function assetRow(createdAt: Date, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ASSET_ID,
    status: "ready",
    variants: { "public-hero": { key: `${ORG_ID}/logo/${ASSET_ID}/public-hero.webp` } },
    deletedAt: null,
    createdAt,
    ...overrides,
  };
}

function syncedLine(): CapturedLine | undefined {
  return logLines.find((l) => l.msg === "KC organization logo_url synced");
}

function noDiscriminatorEmitted(): boolean {
  return logLines.every((l) => l.obj.brandingPipeline === undefined);
}

describe("processKeycloakSyncOrgLogo — brandingPipeline latency discriminator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:10.000Z"));
    logLines.length = 0;
    selectResults.length = 0;
    // Default mock: the PATCH burns KC_PATCH_MS on the fake clock before
    // resolving, so a latency computation hoisted ABOVE the await would
    // produce a delta short of KC_PATCH_MS and fail the exact-value
    // assertions below (the "measured AFTER the PATCH" contract).
    updateOrganization.mockImplementation(async () => {
      vi.advanceTimersByTime(KC_PATCH_MS);
      return { changed: true };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("ready asset → syncs hero URL and emits kc_synced measured AFTER the KC PATCH", async () => {
    // Upload accepted 4.2s before the job starts; the PATCH burns another
    // 500ms on the fake clock → the emitted delta must be 4700, not 4200.
    const createdAt = new Date("2026-07-23T12:00:05.800Z");
    selectResults.push([tenantRow()], [assetRow(createdAt)]);

    const result = await processKeycloakSyncOrgLogo(jobFor());

    expect(result.synced).toBe(true);
    expect(updateOrganization).toHaveBeenCalledWith("kc-org-1", {
      attributes: { logo_url: [`https://cdn.test/${ORG_ID}/logo/${ASSET_ID}/public-hero.webp`] },
    });

    const line = syncedLine();
    expect(line).toBeDefined();
    expect(line?.obj.brandingPipeline).toEqual({
      event: "kc_synced",
      assetId: ASSET_ID,
      uploadAcceptedAt: createdAt.toISOString(),
      e2eLatencyMs: 4200 + KC_PATCH_MS,
    });
  });

  it("clamps e2eLatencyMs at 0 when created_at is ahead of the worker clock", async () => {
    const createdAt = new Date("2026-07-23T12:00:15.000Z"); // 4.5s past "now"+PATCH
    selectResults.push([tenantRow()], [assetRow(createdAt)]);

    await processKeycloakSyncOrgLogo(jobFor());

    const line = syncedLine();
    expect((line?.obj.brandingPipeline as { e2eLatencyMs: number } | undefined)?.e2eLatencyMs).toBe(
      0,
    );
  });

  it("at-least-once re-delivery (KC value unchanged) → NO discriminator", async () => {
    // Relay redelivery / BullMQ stalled re-run: the KC attribute already
    // holds the hero URL, so updateOrganization reports changed: false.
    // Emitting here would re-measure against the ORIGINAL upload's
    // created_at and fire a false SLO-breach alert (review finding).
    updateOrganization.mockImplementation(async () => {
      vi.advanceTimersByTime(KC_PATCH_MS);
      return { changed: false };
    });
    selectResults.push(
      [tenantRow()],
      [assetRow(new Date("2026-07-23T11:30:00.000Z"))], // 30min-old upload
    );

    const result = await processKeycloakSyncOrgLogo(jobFor());

    expect(result.synced).toBe(true);
    expect(syncedLine()).toBeDefined();
    expect(noDiscriminatorEmitted()).toBe(true);
  });

  it("KC PATCH failure → error bubbles for BullMQ retry, NO discriminator", async () => {
    updateOrganization.mockRejectedValue(new Error("KC down"));
    selectResults.push([tenantRow()], [assetRow(new Date("2026-07-23T12:00:05.800Z"))]);

    await expect(processKeycloakSyncOrgLogo(jobFor())).rejects.toThrow("KC down");
    expect(noDiscriminatorEmitted()).toBe(true);
  });

  it("clear path (no logoAssetId) → empty attribute, NO discriminator", async () => {
    selectResults.push([tenantRow({ logoAssetId: null })]);

    const result = await processKeycloakSyncOrgLogo(jobFor());

    expect(result).toEqual({ synced: true, logoUrl: "" });
    expect(updateOrganization).toHaveBeenCalledWith("kc-org-1", {
      attributes: { logo_url: [] },
    });
    const line = syncedLine();
    expect(line).toBeDefined();
    expect(line?.obj.brandingPipeline).toBeUndefined();
    expect(line?.obj.logoUrl).toBe("(cleared)");
  });

  it("not-ready asset → empty attribute, NO discriminator", async () => {
    selectResults.push(
      [tenantRow()],
      [assetRow(new Date("2026-07-23T12:00:00.000Z"), { status: "processing" })],
    );

    await processKeycloakSyncOrgLogo(jobFor());

    expect(updateOrganization).toHaveBeenCalledWith("kc-org-1", {
      attributes: { logo_url: [] },
    });
    expect(noDiscriminatorEmitted()).toBe(true);
  });

  it("ready asset WITHOUT a public-hero variant → empty attribute, NO discriminator", async () => {
    selectResults.push(
      [tenantRow()],
      [assetRow(new Date("2026-07-23T12:00:00.000Z"), { variants: {} })],
    );

    await processKeycloakSyncOrgLogo(jobFor());

    expect(updateOrganization).toHaveBeenCalledWith("kc-org-1", {
      attributes: { logo_url: [] },
    });
    expect(noDiscriminatorEmitted()).toBe(true);
  });

  it("soft-deleted asset → empty attribute, NO discriminator", async () => {
    selectResults.push(
      [tenantRow()],
      [
        assetRow(new Date("2026-07-23T12:00:00.000Z"), {
          deletedAt: new Date("2026-07-23T12:00:04.000Z"),
        }),
      ],
    );

    await processKeycloakSyncOrgLogo(jobFor());

    expect(updateOrganization).toHaveBeenCalledWith("kc-org-1", {
      attributes: { logo_url: [] },
    });
    expect(noDiscriminatorEmitted()).toBe(true);
  });

  it("tenant without keycloakOrgId → skips KC PATCH entirely", async () => {
    selectResults.push([tenantRow({ keycloakOrgId: null })]);

    const result = await processKeycloakSyncOrgLogo(jobFor());

    expect(result).toEqual({ synced: false, logoUrl: "" });
    expect(updateOrganization).not.toHaveBeenCalled();
    expect(noDiscriminatorEmitted()).toBe(true);
  });
});
