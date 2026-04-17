/**
 * Givernance brand mark — the "G" badge + wordmark used on standalone pages
 * (error, 404, auth, etc.) that render outside the main app shell.
 */
export function BrandLogo({ appName }: { appName: string }) {
  return (
    <div className="mb-10 flex items-center justify-center gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-xl font-bold text-on-primary">
        G
      </div>
      <span className="font-heading text-2xl text-text">{appName}</span>
    </div>
  );
}
