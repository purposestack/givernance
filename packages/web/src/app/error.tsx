"use client";

import { AlertTriangle } from "lucide-react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-error" />
        <h1 className="mt-6 font-heading text-section-title text-text">Something went wrong</h1>
        <p className="mt-2 text-md text-text-secondary">
          An unexpected error occurred. Please try again.
        </p>
        {error.digest && <p className="mt-1 text-xs text-text-muted">Reference: {error.digest}</p>}
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex h-[var(--btn-height-md)] items-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary shadow-button transition-colors hover:bg-primary-hover focus-visible:shadow-ring"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
