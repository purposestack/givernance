import type { ReactNode } from "react";

/**
 * Full-screen centred shell used by standalone error pages (404, 500, etc.).
 * Renders a vertically/horizontally centred column of up to 500 px wide.
 */
export function ErrorPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-[500px] text-center">{children}</div>
    </div>
  );
}
