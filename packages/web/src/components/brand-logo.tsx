import { Logo } from "@/components/shared/logo";

/**
 * Givernance brand mark — the cube logo + wordmark used on standalone pages
 * (error, 404, etc.) that render outside the main app shell.
 */
export function BrandLogo({ appName }: { appName: string }) {
  return (
    <div className="mb-10 flex items-center justify-center gap-3">
      <Logo className="h-12 w-12 shrink-0" />
      <span className="font-heading text-2xl text-text">{appName}</span>
    </div>
  );
}
