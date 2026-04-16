import Link from "next/link";

/**
 * 404 Not Found page — matches GLO-002 mockup (docs/design/global/404.html).
 * Features a CSS compass illustration, error label, and dual actions.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-[500px] text-center">
        {/* Logo */}
        <div className="mb-10 flex items-center justify-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-xl font-bold text-on-primary">
            G
          </div>
          <span className="font-heading text-2xl text-text">Givernance</span>
        </div>

        {/* Compass illustration */}
        <div className="relative mx-auto mb-8 h-[150px] w-[150px]">
          {/* Outer ring */}
          <div className="absolute inset-0 rounded-full border-3 border-neutral-200 bg-white shadow-card" />
          {/* Inner dashed ring */}
          <div className="absolute left-5 top-5 h-[110px] w-[110px] rounded-full border-2 border-dashed border-neutral-200" />
          {/* Cardinal markers */}
          <span className="absolute left-1/2 top-2 -translate-x-1/2 text-xs font-semibold text-primary">
            N
          </span>
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs font-semibold text-neutral-400">
            S
          </span>
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-neutral-400">
            E
          </span>
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-neutral-400">
            W
          </span>
          {/* Needle */}
          <div className="absolute left-1/2 top-1/2 h-[52px] w-1 origin-center -translate-x-1/2 -translate-y-1/2 rotate-[35deg]">
            <div className="absolute left-1/2 top-0 -translate-x-1/2 border-x-[6px] border-b-[24px] border-x-transparent border-b-primary" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 border-x-[5px] border-t-[22px] border-x-transparent border-t-neutral-300" />
          </div>
          {/* Center pivot */}
          <div className="absolute left-1/2 top-1/2 z-[2] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber shadow-[0_0_0_3px_var(--color-white)]" />
          {/* Wandering path */}
          <div className="absolute -bottom-2 -right-5 h-10 w-[60px] rounded-br-[30px] border-2 border-l-0 border-t-0 border-dashed border-primary-light opacity-70">
            <div className="absolute -bottom-[3px] -right-[3px] h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_0_3px_var(--color-primary-50)]" />
          </div>
          {/* Question mark */}
          <span className="absolute -right-3.5 -top-2.5 font-heading text-xl italic text-amber opacity-80">
            ?
          </span>
        </div>

        {/* Error label */}
        <div className="mb-3 font-mono text-sm font-semibold uppercase tracking-wider text-primary">
          Error 404
        </div>

        {/* Title */}
        <h1 className="mb-4 font-heading text-3xl font-normal leading-tight text-text">
          Page not found
        </h1>

        {/* Message */}
        <p className="mx-auto mb-8 max-w-[380px] text-sm leading-relaxed text-text-secondary">
          The page you are looking for does not exist or has been moved. Don&apos;t worry,
          we&apos;ll get you back on the right path.
        </p>

        {/* Primary CTA */}
        <div className="mb-6 flex items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex h-[var(--btn-height-lg)] items-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary shadow-button transition-[background-color] hover:bg-primary-hover focus-visible:shadow-ring"
          >
            Back to dashboard
          </Link>
        </div>

        {/* Divider */}
        <div className="mb-5 flex items-center gap-3 text-xs text-text-muted">
          <span className="h-px flex-1 bg-neutral-200" />
          or
          <span className="h-px flex-1 bg-neutral-200" />
        </div>

        {/* Search placeholder */}
        <div className="mx-auto mb-8 max-w-[320px]">
          <input
            type="search"
            placeholder="Search in Givernance…"
            aria-label="Search in Givernance"
            readOnly
            className="h-[var(--input-height)] w-full rounded-input border border-border bg-white px-4 text-center text-sm text-text placeholder:text-text-muted focus-visible:shadow-ring"
          />
        </div>

        {/* Footer */}
        <footer className="text-xs text-text-muted">
          If the problem persists, contact our{" "}
          <a
            href="mailto:support@givernance.org"
            className="font-medium text-primary hover:text-primary-dark hover:underline"
          >
            support
          </a>
          .
        </footer>
      </div>
    </div>
  );
}
