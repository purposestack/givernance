import { LogoUploadCard } from "@/components/branding/logo-upload-card";
import { BrandingService } from "@/services/BrandingService";
import { mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

// next/image's runtime expects the Next image-config context which JSDOM
// can't satisfy. Forward the props onto a plain `<img>` so tests can assert
// on `alt` / `src` for the "ready" preview path (PR #287 review, minor 13).
// `<img>` here is correct for the test mock (no Next runtime to delegate to);
// the `noImgElement` rule is silenced for `**/*.test.{ts,tsx}` via biome.json.
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => (
    <img {...(props as Record<string, string>)} alt={(props.alt as string) ?? ""} />
  ),
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
    // The dropzone is now a single semantic <button> labelled with the
    // dropzone primary copy (PR #287 review, minor 11). The "Select a file"
    // affordance is inline span content, not a separate button.
    expect(screen.getByRole("button", { name: /Drop your logo here/i })).toBeInTheDocument();
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
    const previewUrl = "https://cdn.example/p.webp";
    vi.spyOn(BrandingService, "getOrgLogo")
      .mockResolvedValueOnce(null) // initial fetch
      .mockResolvedValueOnce({
        id: "00000000-0000-4000-8000-000000001001",
        status: "ready",
        assetType: "org_logo",
        originalUrl: "https://cdn.example/orig.png",
        originalContentType: "image/png",
        variants: {
          sidebar: {
            key: "org/logo/asset-1/sidebar.webp",
            url: "https://cdn.example/s.webp",
            contentType: "image/webp",
            width: 128,
            height: 128,
          },
          preview: {
            key: "org/logo/asset-1/preview.webp",
            url: previewUrl,
            contentType: "image/webp",
            width: 240,
            height: 240,
          },
          "public-hero": {
            key: "org/logo/asset-1/public-hero.webp",
            url: "https://cdn.example/h.webp",
            contentType: "image/webp",
            width: 800,
            height: 800,
          },
          "pdf-letterhead": {
            key: "org/logo/asset-1/pdf-letterhead.png",
            url: "https://cdn.example/pdf.png",
            contentType: "image/png",
            width: 360,
            height: 360,
          },
        },
        error: null,
        createdAt: "2026-05-05T10:00:00.000Z",
        updatedAt: "2026-05-05T10:00:01.000Z",
      });
    const uploadSpy = vi.spyOn(BrandingService, "uploadOrgLogo").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000001001",
      status: "pending",
      assetType: "org_logo",
      originalUrl: "https://cdn.example/orig.png",
      originalContentType: "image/png",
      variants: null,
      error: null,
      createdAt: "2026-05-05T10:00:00.000Z",
      updatedAt: "2026-05-05T10:00:00.000Z",
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

    // Once `ready`, the in-card preview <img> renders with the API-provided
    // preview variant URL and the localised alt text seeded with the org name.
    const previewImg = await screen.findByAltText(/Acme logo/i);
    expect(previewImg).toHaveAttribute("src", previewUrl);
  });

  it("hides the upload affordance when the user is not an org admin", async () => {
    vi.spyOn(BrandingService, "getOrgLogo").mockResolvedValue(null);

    render(<LogoUploadCard orgName="Acme" tenantId="org-4" canManageBranding={false} />);

    await waitFor(() => {
      expect(BrandingService.getOrgLogo).toHaveBeenCalled();
    });

    expect(screen.queryByRole("button", { name: /Drop your logo here/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only organisation administrators can change the logo/i),
    ).toBeInTheDocument();
  });
});
