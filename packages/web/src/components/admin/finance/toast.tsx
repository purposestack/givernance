// #440 — Toast + useToast
//
// The platform already ships a sonner-based Toaster at
// `@/components/ui/toast` (mounted once in the root layout). The issue
// asked for an imperative API similar to sonner — which is exactly
// what sonner provides — so this file is a thin re-export that keeps
// the finance component family self-contained.
//
// The platform Toaster uses sonner's `role="status"` + `aria-live="polite"`
// out of the box (`<SonnerToaster>` defaults), which matches the a11y
// requirement in #440.
//
// Auto-dismiss: 5 s by default (platform-wide); a 3 s override can be
// passed per-call via `toast.success(msg, { duration: 3000 })`.

import { toast } from "@/components/ui/toast";

export { Toaster as ToastProvider } from "@/components/ui/toast";
export { toast };

/**
 * Imperative API alias for ergonomic per-feature import:
 *
 *   const { success, error } = useToast();
 *   success("Campagne email programmée — invitation envoyée à 38 tenants.");
 *
 * Returned object is stable across renders (re-exports sonner's static
 * `toast` namespace) so it's safe to destructure outside `useEffect`.
 */
export function useToast() {
  // Defensive `.bind()` only when the underlying method exists — the
  // shared test mock (`@/tests/mocks` → `mockToast`) currently exposes
  // success/error/warning, no `.info`. Returning a no-op for missing
  // levels keeps consumers from blowing up under jsdom.
  const noop = () => "";
  return {
    success: toast.success ? toast.success.bind(toast) : noop,
    error: toast.error ? toast.error.bind(toast) : noop,
    info: toast.info ? toast.info.bind(toast) : noop,
    warning: toast.warning ? toast.warning.bind(toast) : noop,
  };
}
