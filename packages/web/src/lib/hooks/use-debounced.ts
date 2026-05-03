import { useEffect, useState } from "react";

/**
 * Trailing-edge debounce — returns the latest `value`, but only after
 * `delay` ms have elapsed since the last update. Drives free-text
 * search inputs (start-impersonation, platform-admin filters, …) so the
 * URL / API isn't churned on every keystroke.
 *
 * Replaces the inline copy that lived inside
 * `start-impersonation-form.tsx`. Keep the implementation tiny — this
 * is the boring 5-line version on purpose; reach for a proper utility
 * (lodash.debounce, react-use's `useDebounce`) only when leading-edge
 * or `cancel()` semantics are actually needed.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
