import { ReceiptPreviewButton } from "@/components/donations/receipt-preview-button";
import { ApiProblem } from "@/lib/api";
import { DonationService } from "@/services/DonationService";
import { mockApiClient, mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

describe("ReceiptPreviewButton", () => {
  const donationId = "11111111-1111-4111-8111-111111111111";

  it("opens the resolved download URL in a new tab on click", async () => {
    const user = userEvent.setup();
    // The synchronous popup-blocker workaround opens about:blank in the
    // click tick, then redirects when the metadata fetch resolves —
    // mirror that here.
    const popup = { location: { href: "" }, close: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    vi.spyOn(DonationService, "getDonationReceiptDownloadUrl").mockResolvedValue(
      `/api/v1/donations/${donationId}/receipt/download`,
    );

    render(<ReceiptPreviewButton donationId={donationId} />);
    await user.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(DonationService.getDonationReceiptDownloadUrl).toHaveBeenCalledWith(
        mockApiClient,
        donationId,
      ),
    );
    // Resolved URL must include the configured `/api` prefix — proves
    // the component doesn't reconstruct it (issue #214 review).
    await waitFor(() =>
      expect(popup.location.href).toBe(`/api/v1/donations/${donationId}/receipt/download`),
    );
    // Lock the placeholder-tab signature: NO `noopener` / `noreferrer`
    // — those features cause window.open to return null per spec,
    // which would strand the user on about:blank (the bug shipped on
    // the first cut of this PR). We rely on the same-origin PDF
    // response not executing JS to neutralize the tabnabbing risk
    // that `noopener` normally guards against.
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(openSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("noopener"),
    );
  });

  it("shows a 'pending' warning toast when the receipt is not ready (404)", async () => {
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    vi.spyOn(DonationService, "getDonationReceiptDownloadUrl").mockRejectedValue(
      new ApiProblem({
        type: "https://httpproblems.com/http-status/404",
        title: "Not Found",
        status: 404,
        detail: "Receipt not generated yet",
      }),
    );

    render(<ReceiptPreviewButton donationId={donationId} />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalled());
    expect(mockToast.error).not.toHaveBeenCalled();
    // Placeholder tab must be cleaned up — leaving an about:blank
    // hanging would be a UX leak.
    expect(popup.close).toHaveBeenCalled();
  });

  it("shows a generic error toast when the popup is blocked", async () => {
    const user = userEvent.setup();
    // Popup blocker fires → window.open returns null. Without an
    // explicit toast the user has no signal that anything happened.
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(DonationService, "getDonationReceiptDownloadUrl").mockResolvedValue(
      `/api/v1/donations/${donationId}/receipt/download`,
    );

    render(<ReceiptPreviewButton donationId={donationId} />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  });

  it("shows a generic error toast on unexpected errors (5xx, network)", async () => {
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    vi.spyOn(DonationService, "getDonationReceiptDownloadUrl").mockRejectedValue(
      new Error("network down"),
    );

    render(<ReceiptPreviewButton donationId={donationId} />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(popup.close).toHaveBeenCalled();
  });
});
