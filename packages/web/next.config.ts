import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Consume shared workspace packages via TypeScript source. */
  transpilePackages: ["@givernance/shared"],

  /** ADR-013: Prevent exposing internal architecture via client-side source maps. */
  productionBrowserSourceMaps: false,
};

export default nextConfig;
