import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Env vars are loaded from the monorepo root .env by dotenv-cli in the dev
// script (see packages/web/package.json). For `next build` in CI, env vars
// come from the CI runner directly.

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.API_URL || "http://localhost:4000"}/v1/:path*`,
      },
    ];
  },
  /** Consume shared workspace packages via TypeScript source. */
  transpilePackages: ["@givernance/shared"],

  /** ADR-013: Prevent exposing internal architecture via client-side source maps. */
  productionBrowserSourceMaps: false,

  /**
   * Allow-list of remote hosts that may serve org-branding images
   * (Epic #286). Each hostname here corresponds to a deployment target
   * for the object-storage-backed logo variants:
   *   - `s3.fr-par.scw.cloud`    Scaleway Paris region direct S3 endpoint
   *                              (production + staging — both buckets sit
   *                              under this exact subdomain)
   *   - `localhost:9000`         dev MinIO via host networking
   *   - `minio`                  dev MinIO inside docker-compose network
   *
   * The previous `**.scw.cloud` wildcard was rejected in PR #287 review
   * (major 5): Scaleway is multi-tenant, so a wildcard match would let
   * any other Scaleway customer's bucket pass `next/image`'s host check.
   * If a future bug let an attacker influence a stored variant URL,
   * the wildcard would compound into a stored-payload attack surface.
   *
   * If/when we front the buckets with a CDN (e.g. `cdn.givernance.eu`
   * or `cdn.givernance.org`), add the exact hostname here — never go
   * back to wildcards.
   *
   * The public donation page (`/p/[id]`) uses `unoptimized` to skip the
   * Next image proxy entirely — donor traffic must not pay for proxying
   * an already-content-addressed asset. Authenticated surfaces (sidebar,
   * settings, org-picker) keep optimisation on.
   */
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "s3.fr-par.scw.cloud", pathname: "/**" },
      // Future: { protocol: "https", hostname: "cdn.givernance.eu", pathname: "/**" },
      { protocol: "http", hostname: "localhost", port: "9000", pathname: "/**" },
      { protocol: "http", hostname: "minio", pathname: "/**" },
    ],
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
