import { LogoUploadCard } from "@/components/branding/logo-upload-card";
import { BrandingService } from "@/services/BrandingService";
import { mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

// next/image's runtime expects the Next image-config context which JSDOM
// can't satisfy. Strip it down to a no-op so the upload happy path renders
// without exercising the App Router test harness.
vi.mock("next/image", () => ({
  default: () => null,
}));

describe("LogoUploadCard", () => {
  it("renders the empty state with the dropzone and coaching copy", async () => {
    vi.spyOn(BrandingService, "getOrgLogo").mockResolvedValue(null);

    render(<LogoUploadCard orgName="Solidarité Méd." tenantId="org-1" canManageBranding />);

    await waitFor(() => {
      expect(BrandingService.getOrgLogo).toHaveBeenCalled();
    });

    // Dropzone primary copy from settings.branding.dropzonePrimary
    expect(await screen.findByText(/Drop your logo here/i)).toBeInTheDocument();
    expect(screen.getByText(/Square logos work best/i)).toBeInTheDocument();
    // The "Select a file" button is present (drag-drop AND button affordance).
    expect(screen.getByRole("button", { name: /Select a file/i })).toBeInTheDocument();
  });

  it("rejects an oversized raster file with an inline error", async () => {
    const user = userEvent.setup();
    vi.spyOn(BrandingService, "getOrgLogo").mockResolvedValue(null);
    const uploadSpy = vi.spyOn(BrandingService, "uploadOrgLogo");

    render(<LogoUploadCard orgName="Acme" tenantId="org-2" canManageBranding />);

    await waitFor(() => {
      expect(BrandingService.getOrgLogo).toHaveBeenCalled();
    });

    // 6 MB raster file — exceeds the 5 MB limit.
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "logo.png", {
      type: "image/png",
    });
    const input = screen.getByLabelText(/Select a file/i, { selector: "input" });
    await user.upload(input, big);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("uploads a valid logo and polls until status=ready", async () => {
    const user = userEvent.setup();
    vi.spyOn(BrandingService, "getOrgLogo")
      .mockResolvedValueOnce(null) // initial fetch
      .mockResolvedValueOnce({
        id: "logo-1",
        status: "ready",
        variants: {
          sidebar: "https://cdn.example/s.png",
          preview: "https://cdn.example/p.png",
          "public-hero": "https://cdn.example/h.png",
          "pdf-letterhead": "https://cdn.example/pdf.png",
        },
        originalUrl: "https://cdn.example/orig.png",
        byteSize: 1234,
        sourceWidth: 512,
        sourceHeight: 512,
        uploadedAt: "2026-05-05T10:00:00.000Z",
      });
    const uploadSpy = vi.spyOn(BrandingService, "uploadOrgLogo").mockResolvedValue({
      id: "logo-1",
      status: "pending",
      originalUrl: "https://cdn.example/orig.png",
    });

    render(<LogoUploadCard orgName="Acme" tenantId="org-3" canManageBranding />);

    await waitFor(() => {
      expect(BrandingService.getOrgLogo).toHaveBeenCalledTimes(1);
    });

    const file = new File([new Uint8Array(1024)], "logo.png", { type: "image/png" });
    const input = screen.getByLabelText(/Select a file/i, { selector: "input" });
    await user.upload(input, file);

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(file);
    });

    // Poller fires GET again until status=ready, then surfaces the success toast.
    await waitFor(
      () => {
        expect(mockToast.success).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
  });

  it("hides the upload affordance when the user is not an org admin", async () => {
    vi.spyOn(BrandingService, "getOrgLogo").mockResolvedValue(null);

    render(<LogoUploadCard orgName="Acme" tenantId="org-4" canManageBranding={false} />);

    await waitFor(() => {
      expect(BrandingService.getOrgLogo).toHaveBeenCalled();
    });

    expect(screen.queryByRole("button", { name: /Select a file/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only organisation administrators can change the logo/i),
    ).toBeInTheDocument();
  });
});
