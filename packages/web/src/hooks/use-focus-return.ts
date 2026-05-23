import { useEffect, useRef } from "react";

/**
 * Hook to return focus to a trigger element when a component unmounts
 * or when a boolean state changes from true to false.
 */
export function useFocusReturn(isOpen: boolean) {
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Capture the element that currently has focus when opening
    if (isOpen && !triggerRef.current) {
      triggerRef.current = document.activeElement as HTMLElement;
    }

    // Return focus when closing
    if (!isOpen && triggerRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        triggerRef.current?.focus();
        triggerRef.current = null;
      });
    }
  }, [isOpen]);

  return triggerRef;
}
