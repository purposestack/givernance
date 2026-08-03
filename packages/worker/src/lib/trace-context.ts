/**
 * W3C trace-context helpers — thin re-export of the shared implementation
 * (issue #55, follow-through of issue #56 Platform #4).
 *
 * The single source of truth lives in `@givernance/shared/lib/trace-context`
 * so the worker and the API's regex + trace-id extraction can't drift. Kept
 * as a local module so existing `../lib/trace-context.js` imports don't
 * churn.
 */
export * from "@givernance/shared/lib/trace-context";
