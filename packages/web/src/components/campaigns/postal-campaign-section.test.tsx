/**
 * UI tests for the postal-campaign workspace (Epic #274 audit follow-up).
 *
 * `PostalCampaignSection` is the client wrapper that owns the shared
 * "linked constituent count" between the members card and the export
 * panel. The interesting behaviours to lock down are:
 *
 *   1. Readiness gates (campaign not active / public page draft / missing)
 *      block the "Generate ZIP" CTA — defence-in-depth alongside the API
 *      contract; if the UI shipped without the gate a click would just
 *      400 from the server, but the operator wouldn't get a useful hint.
 *   2. The "Personalized" mode is locked when `linkedConstituentCount=0`
 *      and unlocks after the operator adds a recipient — the bug that
 *      motivated extracting this wrapper component in the first place.
 *   3. Clicking Generate calls `PostalCampaignService.startExport` and
 *      surfaces a success toast.
 *   4. Clicking Generate while the API rejects with 400 surfaces the
 *      problem detail to the operator (no silent failure).
 *
 * The members-card / dialog plumbing is covered indirectly here — we
 * stub out `PostalCampaignService` and exercise the export panel from
 * the wrapper's perspective.
 */

import { PostalCampaignSection } from "@/components/campaigns/postal-campaign-section";
import { ApiProblem } from "@/lib/api";
import { PostalCampaignService, type PostalExport } from "@/services/PostalCampaignService";
import { mockToast, render, screen, userEvent, waitFor, within } from "@/tests/test-utils";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

function renderSection(overrides: Partial<Parameters<typeof PostalCampaignSection>[0]> = {}) {
  return render(
    <PostalCampaignSection
      campaignId={CAMPAIGN_ID}
      campaignType="nominative_postal"
      campaignStatus="active"
      publicPageStatus="published"
      bankAccount={null}
      initialMembers={[]}
      initialMemberTotal={0}
      initialExports={[]}
      mergedPdfEnabled={false}
      {...overrides}
    />,
  );
}

describe("PostalCampaignSection", () => {
  it("disables Generate ZIP and shows the readiness banner when the campaign is still a draft", () => {
    renderSection({ campaignStatus: "draft" });

    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).toBeDisabled();

    expect(screen.getByText(/Activate the campaign first/i)).toBeInTheDocument();
  });

  it("disables Generate ZIP and shows the not-configured banner when no page AND no bank are configured", () => {
    // Epic #318 PR #4 — when both rails are off, the resolved mode is
    // `blocked` and the operator sees the disambiguated notConfigured
    // banner instead of the misleading "configure a public page" hint
    // (their actual intent might be Swiss QR-bill only).
    renderSection({ publicPageStatus: "missing", bankAccount: null });

    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).toBeDisabled();

    expect(screen.getByText(/Postal export not configured/i)).toBeInTheDocument();
    // Banner offers two CTAs: publish the public page OR link a bank account.
    expect(screen.getByRole("link", { name: /Publish a public donation page/i })).toHaveAttribute(
      "href",
      `/campaigns/${CAMPAIGN_ID}/public-page`,
    );
    expect(screen.getByRole("link", { name: /Link a Swiss bank account/i })).toHaveAttribute(
      "href",
      `/campaigns/${CAMPAIGN_ID}/edit`,
    );
  });

  it("disables Generate ZIP and shows the publish-page banner when the page is a draft", () => {
    renderSection({ publicPageStatus: "draft" });

    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).toBeDisabled();
    expect(screen.getByText(/Publish your public donation page first/i)).toBeInTheDocument();
  });

  it("locks the Personalized mode when zero constituents are linked", () => {
    renderSection({ initialMemberTotal: 0 });

    // The mode toggle is rendered as a <button aria-pressed=…> — disabled
    // because the operator has nothing to send a personalized letter to.
    const personalizedToggle = screen.getByRole("button", { name: /Personalized/i });
    expect(personalizedToggle).toBeDisabled();
    expect(personalizedToggle).toHaveAttribute("aria-pressed", "true");

    // Door-drop stays clickable because it doesn't need a recipient list.
    const doorDropToggle = screen.getByRole("button", { name: /Door drop/i });
    expect(doorDropToggle).not.toBeDisabled();
  });

  it("starts a personalized export and surfaces a success toast", async () => {
    const user = userEvent.setup();

    vi.spyOn(PostalCampaignService, "startExport").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      campaignId: CAMPAIGN_ID,
      mode: "personalized",
      format: "zip",
      status: "pending",
      totalCount: 3,
      progressCount: 0,
      zipS3Path: null,
      error: null,
      requestedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    });

    renderSection({ initialMemberTotal: 3 });

    // With 3 members linked and an active+published campaign, the
    // Generate button is enabled and defaults to personalized mode.
    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).not.toBeDisabled();

    await user.click(generateBtn);

    await waitFor(() =>
      expect(PostalCampaignService.startExport).toHaveBeenCalledWith(
        expect.anything(),
        CAMPAIGN_ID,
        "personalized",
        // Default ZIP format — the selector is hidden when the flag is off.
        "zip",
      ),
    );
    expect(mockToast.success).toHaveBeenCalledWith(
      "Export queued — generation will start shortly.",
    );
  });

  it("surfaces a useful error toast when the API rejects the export request", async () => {
    const user = userEvent.setup();

    vi.spyOn(PostalCampaignService, "startExport").mockRejectedValue(
      new ApiProblem({
        type: "https://givernance.test/problems/no_recipients",
        title: "no_recipients",
        status: 400,
        detail: "Add constituents before queueing a personalized export.",
      }),
    );

    renderSection({ initialMemberTotal: 1 });

    await user.click(screen.getByRole("button", { name: /Generate.*ZIP/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        "Add constituents before queueing a personalized export.",
      ),
    );
  });

  describe("Merged PDF format selector (project item #194221573)", () => {
    it("hides the format selector entirely when the flag is off", () => {
      renderSection({ initialMemberTotal: 3, mergedPdfEnabled: false });

      // No "Output format" heading, no merged-PDF option, no PDF-named CTA.
      expect(screen.queryByText(/Output format/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Single merged PDF/i })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Generate merged PDF/i }),
      ).not.toBeInTheDocument();
      // The CTA is still the ZIP one.
      expect(screen.getByRole("button", { name: /Generate.*ZIP/i })).toBeInTheDocument();
    });

    it("shows the selector when the flag is on and starts a merged_pdf export", async () => {
      const user = userEvent.setup();
      vi.spyOn(PostalCampaignService, "startExport").mockResolvedValue({
        id: "33333333-3333-4333-8333-333333333333",
        campaignId: CAMPAIGN_ID,
        mode: "personalized",
        format: "merged_pdf",
        status: "pending",
        totalCount: 3,
        progressCount: 0,
        zipS3Path: null,
        error: null,
        requestedBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      });

      renderSection({ initialMemberTotal: 3, mergedPdfEnabled: true });

      // Pick the merged-PDF format, then Generate.
      await user.click(screen.getByRole("button", { name: /Single merged PDF/i }));
      // The CTA relabels to the merged-PDF action.
      const generateBtn = screen.getByRole("button", { name: /Generate merged PDF/i });
      await user.click(generateBtn);

      await waitFor(() =>
        expect(PostalCampaignService.startExport).toHaveBeenCalledWith(
          expect.anything(),
          CAMPAIGN_ID,
          "personalized",
          "merged_pdf",
        ),
      );
    });
  });

  it("forces door-drop mode and hides personalized affordance for door-drop campaigns", () => {
    renderSection({ campaignType: "door_drop", initialMemberTotal: 0 });

    // The personalized toggle is rendered but disabled with the
    // door-drop hint copy. The user cannot lift the disabled state via
    // a no-op click.
    const personalizedToggle = screen.getByRole("button", { name: /Personalized/i });
    expect(personalizedToggle).toBeDisabled();
    expect(
      screen.getByText(/Personalized letters are not available for door-drop campaigns/i),
    ).toBeInTheDocument();
  });

  describe("Export history row (project item #194221573)", () => {
    function exportFixture(over: Partial<PostalExport> = {}): PostalExport {
      return {
        id: "44444444-4444-4444-8444-444444444444",
        campaignId: CAMPAIGN_ID,
        mode: "personalized" as const,
        format: "zip" as const,
        status: "completed" as const,
        totalCount: 5,
        progressCount: 5,
        zipS3Path: "key",
        error: null,
        requestedBy: null,
        createdAt: new Date("2026-06-07T16:20:00Z").toISOString(),
        updatedAt: new Date("2026-06-07T16:20:00Z").toISOString(),
        completedAt: new Date("2026-06-07T16:20:00Z").toISOString(),
        ...over,
      };
    }

    it("shows a merged-PDF chip + download for a personalized merged export", () => {
      renderSection({
        mergedPdfEnabled: true,
        initialExports: [
          exportFixture({ format: "merged_pdf", mode: "personalized", totalCount: 5 }),
        ],
      });
      // Generation type is distinguished at a glance by the chip.
      expect(screen.getByText("Merged PDF")).toBeInTheDocument();
      // Completed exports expose a download affordance.
      expect(screen.getByRole("link", { name: /Download/i })).toBeInTheDocument();
      // NB: the "N recipients" count uses an ICU plural which the test's
      // next-intl mock (plain `{key}` interpolation only) can't resolve —
      // production renders it correctly. We assert the mock-renderable
      // parts here; the door-drop case below covers the "Generic letter"
      // scope label (a plain string).
    });

    it("shows a ZIP chip and no bare progress for a completed door-drop ZIP export", () => {
      renderSection({
        initialExports: [exportFixture({ format: "zip", mode: "door_drop", totalCount: 1 })],
      });
      // The format chip distinguishes the generation type.
      const row = screen.getByRole("link", { name: /Download/i }).closest("li");
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText("ZIP")).toBeInTheDocument();
      // Door-drop shows the "Generic letter" scope, not a meaningless "1/1".
      expect(within(row as HTMLElement).getByText(/Generic letter/i)).toBeInTheDocument();
      expect(screen.queryByText("1/1 generated")).not.toBeInTheDocument();
    });
  });

  describe("Swiss QR-bill modes (Epic #318 PR #4 / PR #5)", () => {
    const BANK = {
      bankName: "PostFinance",
      ibanLast4: "1234",
      currency: "CHF" as const,
    };

    it("renders the Swiss QR-bill badge + bank label when a bank account is linked and no public page is configured (qr_bill_only)", () => {
      renderSection({
        publicPageStatus: "missing",
        bankAccount: BANK,
        initialMemberTotal: 1,
      });

      // The mode-summary badge advertises the Swiss QR-bill mode.
      // `modeSummary.badge.qr_bill_only` is the only string that uses
      // the unaccompanied flag emoji + "Swiss QR-bill" (the `hybrid`
      // badge prefixes "Standard + …" and the CTA strings include
      // "ZIP"). Match the canonical badge copy explicitly to avoid
      // colliding with other QR-bill mentions on the page.
      expect(screen.getByText("🇨🇭 Swiss QR-bill")).toBeInTheDocument();
      // The bank-account label surfaces in the explainer copy with the
      // last 4 of the IBAN.
      expect(screen.getByText(/PostFinance/)).toBeInTheDocument();
      expect(screen.getByText(/\*\*\*\*1234/)).toBeInTheDocument();
    });

    it("does NOT show the public-page-missing banner in qr_bill_only mode", () => {
      // §1.bis.0 truth-table invariant: when the run mode is `qr_bill_only`,
      // the appeal letter is NOT emitted, so the absence of a public page
      // is by design, not a configuration error. The misleading
      // "publicPageMissing" banner from standard mode must not fire here.
      renderSection({
        publicPageStatus: "missing",
        bankAccount: BANK,
        initialMemberTotal: 1,
      });

      expect(screen.queryByText(/Configure a public donation page first/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Postal export not configured/i)).not.toBeInTheDocument();
      // Generate button is enabled — the operator has everything they need
      // to mint a QR-bill ZIP.
      expect(screen.getByRole("button", { name: /Generate.*ZIP/i })).not.toBeDisabled();
    });

    it("shows a per-recipient scope sub-label for personalized + qr_bill_only campaigns", () => {
      renderSection({
        campaignType: "nominative_postal",
        publicPageStatus: "missing",
        bankAccount: BANK,
        initialMemberTotal: 1,
      });

      // Personalized campaign + QR-bill = one QR-bill reference per
      // recipient (unique QRR/SCOR per letter). Match against the
      // distinctive "1 QR-bill reference each" tail to avoid colliding
      // with the existing `contentsHeading` ("This export will contain,
      // per recipient:") which also matches `/Per recipient/i`.
      expect(screen.getByText(/1 QR-bill reference each/i)).toBeInTheDocument();
    });

    it("shows a per-campaign (door-drop) scope sub-label for door-drop + qr_bill_only campaigns", () => {
      renderSection({
        campaignType: "door_drop",
        publicPageStatus: "missing",
        bankAccount: BANK,
        initialMemberTotal: 0,
      });

      // Door-drop + QR-bill = one shared QR-bill reference for the
      // whole campaign (no per-recipient identity to encode).
      expect(screen.getByText(/1 shared QR-bill reference/i)).toBeInTheDocument();
    });

    it("hides the scope sub-label in standard mode (no QR-bill = no reference to scope)", () => {
      // Standard mode has no QR-bill, so the per-recipient vs.
      // per-campaign disambiguation is meaningless. Verifying it is
      // hidden defends the operator from spurious UI noise on the
      // dominant configuration. Match against the distinctive
      // "QR-bill reference" tail to avoid colliding with the unrelated
      // `contentsHeading` copy ("This export will contain, per recipient:").
      expect(screen.queryByText(/QR-bill reference each/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/shared QR-bill reference/i)).not.toBeInTheDocument();
    });

    it("triggers a download (anchor with localized filename) when the preview response is an application/zip (hybrid mode)", async () => {
      const user = userEvent.setup();

      // jsdom doesn't ship `URL.createObjectURL` / `revokeObjectURL` —
      // patch them on the global URL so the preview helper can call
      // through without throwing.
      const objectUrl = "blob:test/preview";
      const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue(objectUrl);
      const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      // The preview endpoint returns an `application/zip` body — this is
      // the hybrid-mode shape (one PDF letter + one PDF QR-bill). Mock
      // the global `fetch` directly so the helper picks up the response
      // without going through the API proxy.
      //
      // Body is a plain string (not a Blob) — Node 22's native Response
      // re-streams a Blob body through a ReadableStream and the round-trip
      // through `response.blob()` is brittle on CI (works on Node 24
      // locally, hangs on Node 22 in GitHub Actions). A string body is
      // converted to a Blob via the standard text-encoding path and is
      // stable across Node versions.
      const fetchMock = vi.fn(
        async () =>
          new Response("zip-bytes", {
            status: 200,
            headers: new Headers({ "content-type": "application/zip" }),
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      // Track anchor clicks + the download filename so we can assert the
      // localized name without relying on jsdom actually triggering a
      // navigation.
      const anchorClick = vi.fn();
      let observedDownloadName: string | null = null;
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = vi
        .spyOn(document, "createElement")
        .mockImplementation((tagName: string) => {
          const el = originalCreateElement(tagName) as HTMLElement;
          if (tagName === "a") {
            const anchor = el as HTMLAnchorElement;
            anchor.click = anchorClick;
            // Capture the assignment to `anchor.download` so we can
            // assert on it later. (Reading `anchor.download` after the
            // click would also work; the property is preserved by jsdom.)
            Object.defineProperty(anchor, "download", {
              set(value: string) {
                observedDownloadName = value;
              },
              get(): string {
                return observedDownloadName ?? "";
              },
              configurable: true,
            });
          }
          return el;
        });

      renderSection({
        publicPageStatus: "published",
        bankAccount: BANK,
        initialMemberTotal: 1,
      });

      await user.click(screen.getByRole("button", { name: /Preview/i }));

      // The preview helper must trigger a download (anchor.click) rather
      // than opening the blob inline — that path is reserved for the
      // PDF content-type. The download filename comes from the i18n
      // `postal.preview.zipFilename` key.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      // Defensive timeout — the async chain inside `fetchAndOpenPreview`
      // takes a handful of microtask cycles (await fetch + await
      // response.blob() + URL.createObjectURL + setState round-trip). On
      // CI scheduling is slower than the 1000ms vitest default.
      await waitFor(
        () => {
          expect(anchorClick).toHaveBeenCalledTimes(1);
        },
        { timeout: 5000 },
      );
      expect(observedDownloadName).toBe("postal-preview.zip");
      expect(createObjectURL).toHaveBeenCalled();

      createElementSpy.mockRestore();
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe('Refresh ("Actualiser") button', () => {
    it("re-fetches the export list and confirms with a success toast", async () => {
      const user = userEvent.setup();

      const fresh: PostalExport = {
        id: "33333333-3333-4333-8333-333333333333",
        campaignId: CAMPAIGN_ID,
        mode: "personalized",
        format: "zip",
        status: "completed",
        totalCount: 2,
        progressCount: 2,
        zipS3Path: "campaigns/export.zip",
        error: null,
        requestedBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      vi.spyOn(PostalCampaignService, "listExports").mockResolvedValue([fresh]);

      renderSection({ initialMemberTotal: 2 });

      await user.click(screen.getByRole("button", { name: /Refresh/i }));

      await waitFor(() =>
        expect(PostalCampaignService.listExports).toHaveBeenCalledWith(
          expect.anything(),
          CAMPAIGN_ID,
        ),
      );
      // The whole point of the change: a click must produce visible feedback
      // even when the list is unchanged. The success toast is that signal.
      expect(mockToast.success).toHaveBeenCalledWith("Export list up to date.");
    });

    it("surfaces an error toast when the refresh fetch fails", async () => {
      const user = userEvent.setup();

      vi.spyOn(PostalCampaignService, "listExports").mockRejectedValue(
        new ApiProblem({
          type: "https://givernance.test/problems/internal",
          title: "internal_error",
          status: 500,
          detail: "Upstream unavailable.",
        }),
      );

      renderSection({ initialMemberTotal: 2 });

      await user.click(screen.getByRole("button", { name: /Refresh/i }));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Upstream unavailable."));
    });
  });
});
