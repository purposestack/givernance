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
   *   - `**.scw.cloud`           Scaleway Object Storage (prod & staging)
   *   - `s3.fr-par.scw.cloud`    Scaleway Paris region direct S3 endpoint
   *   - `localhost:9000`         dev MinIO via host networking
   *   - `minio`                  dev MinIO inside docker-compose network
   * The public donation page (`/p/[id]`) uses `unoptimized` to skip the
   * Next image proxy entirely — donor traffic must not pay for proxying
   * an already-content-addressed asset. Authenticated surfaces (sidebar,
   * settings, org-picker) keep optimisation on.
   */
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.scw.cloud", pathname: "/**" },
      { protocol: "https", hostname: "s3.fr-par.scw.cloud", pathname: "/**" },
      { protocol: "http", hostname: "localhost", port: "9000", pathname: "/**" },
      { protocol: "http", hostname: "minio", pathname: "/**" },
    ],
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
