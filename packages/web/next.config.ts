import { loadEnvConfig } from "@next/env";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Load environment variables from the monorepo root (.env)
loadEnvConfig(join(__dirname, "../../"));

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  /** Consume shared workspace packages via TypeScript source. */
  transpilePackages: ["@givernance/shared"],

  /** ADR-013: Prevent exposing internal architecture via client-side source maps. */
  productionBrowserSourceMaps: false,
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
