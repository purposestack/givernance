/**
 * Unit tests for `processKeycloakSyncOrgLogo` — focused on the
 * `brandingPipeline` end-to-end latency discriminator (issue #290).
 *
 * No DB / Keycloak: `db`, `updateOrganization`, `brandingPublicUrl`
 * and `jobLogger` are mocked so the tests pin down (a) when the
 * discriminator is emitted (upload path only — never on clear/delete
 * or not-ready syncs), (b) that `e2eLatencyMs` is measured against the
 * asset row's DB `created_at` AFTER the KC PATCH, and (c) the 0-clamp
 * under pathological clock skew.
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

describe("processKeycloakSyncOrgLogo — brandingPipeline latency discriminator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:10.000Z"));
    logLines.length = 0;
    selectResults.length = 0;
    updateOrganization.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("ready asset → syncs hero URL and emits kc_synced with e2eLatencyMs from DB created_at", async () => {
    // Upload accepted 4.2s before "now" (fake clock) — exact delta expected.
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
      e2eLatencyMs: 4200,
    });
  });

  it("clamps e2eLatencyMs at 0 when created_at is ahead of the worker clock", async () => {
    const createdAt = new Date("2026-07-23T12:00:15.000Z"); // 5s in the "future"
    selectResults.push([tenantRow()], [assetRow(createdAt)]);

    await processKeycloakSyncOrgLogo(jobFor());

    const line = syncedLine();
    expect((line?.obj.brandingPipeline as { e2eLatencyMs: number } | undefined)?.e2eLatencyMs).toBe(
      0,
    );
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
    expect(syncedLine()?.obj.brandingPipeline).toBeUndefined();
  });

  it("tenant without keycloakOrgId → skips KC PATCH entirely", async () => {
    selectResults.push([tenantRow({ keycloakOrgId: null })]);

    const result = await processKeycloakSyncOrgLogo(jobFor());

    expect(result).toEqual({ synced: false, logoUrl: "" });
    expect(updateOrganization).not.toHaveBeenCalled();
    expect(logLines.some((l) => l.obj.brandingPipeline !== undefined)).toBe(false);
  });
});
