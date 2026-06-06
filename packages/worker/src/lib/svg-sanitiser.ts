/**
 * SVG sanitiser — thin re-export of the shared implementation (issue #480).
 *
 * The single source of truth lives in `@givernance/shared/lib/svg-sanitiser`
 * so the worker rasterisation pipeline and the API upload handler cannot
 * drift. Both `sanitiseSvg` and `SvgSanitiserError` are re-exported for the
 * existing call sites.
 */
export * from "@givernance/shared/lib/svg-sanitiser";
