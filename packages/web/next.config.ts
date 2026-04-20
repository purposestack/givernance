import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Env vars are loaded from the monorepo root .env by dotenv-cli in the dev
// script (see packages/web/package.json). For `next build` in CI, env vars
// come from the CI runner directly.

const nextConfig: NextConfig = {
  /** Consume shared workspace packages via TypeScript source. */
  transpilePackages: ["@givernance/shared"],

  /** ADR-013: Prevent exposing internal architecture via client-side source maps. */
  productionBrowserSourceMaps: false,
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
