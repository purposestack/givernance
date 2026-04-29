/**
 * Service-level tests for `startStripeOnboarding` covering the
 * capability-request branches that the route-level integration test
 * (`tests/integration/payments.test.ts`) skips by mocking the whole
 * service symbol.
 *
 * What we lock:
 *   - `accounts.create` is called with `card_payments`, `transfers`,
 *     `link_payments` requested when the tenant has no stripe account yet.
 *   - The new `acct_…` is persisted to `tenants.stripe_account_id`.
 *   - On the existing-account path, `accounts.update` is called with the
 *     same capability shape so accounts created before any of these
 *     capabilities were requested can be repaired by clicking "Re-open
 *     Stripe onboarding" (issue #192 follow-up).
 *
 * Why this matters: dropping any capability silently produces a working-
 * looking onboarding flow that errors at the FIRST `paymentIntents.create`
 * with "card_payments capability not enabled." A whole-service mock can't
 * catch that — only mocking the Stripe SDK can.
 */

import { tenants } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { ORG_A } from "../../tests/helpers/auth.js";

const { mockAccountsCreate, mockAccountsUpdate, mockAccountLinksCreate } = vi.hoisted(() => ({
  mockAccountsCreate: vi.fn(),
  mockAccountsUpdate: vi.fn(),
  mockAccountLinksCreate: vi.fn(),
}));

// Mock only the Stripe SDK — keep the real DB writes so we can assert
// `tenants.stripe_account_id` is persisted on the create path.
vi.mock("stripe", () => {
  const StripeMock = vi.fn().mockImplementation(() => ({
    accounts: {
      create: mockAccountsCreate,
      update: mockAccountsUpdate,
    },
    accountLinks: {
      create: mockAccountLinksCreate,
    },
  }));
  return { default: StripeMock };
});

// Need the test tenant row to exist for `startStripeOnboarding` to find it.
beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_A}, 'Org A', 'test-org-a') ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  // Reset the fixture so we don't leak a stripe_account_id into other tests.
  await db.update(tenants).set({ stripeAccountId: null }).where(eq(tenants.id, ORG_A));
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Each test starts with a tenant that has no Stripe account yet.
  await db.update(tenants).set({ stripeAccountId: null }).where(eq(tenants.id, ORG_A));
  // Default account-link return so handlers don't NPE.
  mockAccountLinksCreate.mockResolvedValue({
    url: "https://connect.stripe.com/setup/s/abc",
  });
});

describe("startStripeOnboarding — capability requesting", () => {
  it("requests card_payments + transfers + link_payments on `accounts.create` when the tenant has no Stripe account", async () => {
    const { startStripeOnboarding } = await import("./service.js");

    mockAccountsCreate.mockResolvedValueOnce({ id: "acct_test_new_001" });

    await startStripeOnboarding(
      ORG_A,
      "https://app.givernance.test/settings",
      "https://app.givernance.test/settings",
    );

    expect(mockAccountsCreate).toHaveBeenCalledTimes(1);
    expect(mockAccountsUpdate).not.toHaveBeenCalled();

    const [params] = mockAccountsCreate.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      type: "express",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
        link_payments: { requested: true },
      },
    });
  });

  it("persists the new acct_… to tenants.stripe_account_id on the create path", async () => {
    const { startStripeOnboarding } = await import("./service.js");

    mockAccountsCreate.mockResolvedValueOnce({ id: "acct_test_new_002" });

    await startStripeOnboarding(
      ORG_A,
      "https://app.givernance.test/settings",
      "https://app.givernance.test/settings",
    );

    const [row] = await db
      .select({ stripeAccountId: tenants.stripeAccountId })
      .from(tenants)
      .where(eq(tenants.id, ORG_A));
    expect(row?.stripeAccountId).toBe("acct_test_new_002");
  });

  it("re-asserts capabilities via `accounts.update` on the existing-account path (recovery for pre-fix tenants)", async () => {
    // Tenant already has a Stripe account from a previous (pre-fix) onboarding
    await db
      .update(tenants)
      .set({ stripeAccountId: "acct_test_existing_003" })
      .where(eq(tenants.id, ORG_A));

    const { startStripeOnboarding } = await import("./service.js");

    await startStripeOnboarding(
      ORG_A,
      "https://app.givernance.test/settings",
      "https://app.givernance.test/settings",
    );

    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountsUpdate).toHaveBeenCalledTimes(1);
    const [accountId, params] = mockAccountsUpdate.mock.calls[0] ?? [];
    expect(accountId).toBe("acct_test_existing_003");
    expect(params).toMatchObject({
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
        link_payments: { requested: true },
      },
    });
  });
});
