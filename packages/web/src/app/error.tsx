"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * 500 Error page — matches GLO-003 mockup (docs/design/global/500.html).
 * Features CSS gear + wrench illustration, error digest badge, and dual actions.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");
  const tCommon = useTranslations("common");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-[500px] flex-col items-center text-center">
        {/* Logo */}
        <div className="mb-10 flex items-center justify-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-xl font-bold text-on-primary">
            G
          </div>
          <span className="font-heading text-2xl text-text">{tCommon("appName")}</span>
        </div>

        {/* Gear + wrench illustration */}
        <div
          className="relative mb-8 h-[150px] w-[180px]"
          role="img"
          aria-label="Gears and wrench illustration indicating maintenance in progress"
        >
          {/* Accent dot */}
          <div className="absolute right-10 top-0 h-3 w-3 rounded-full bg-primary-100" />
          {/* Large gear */}
          <div className="absolute left-6 top-2.5 h-[90px] w-[90px] animate-[spin_12s_linear_infinite] rounded-full border-8 border-neutral-200">
            <div className="absolute left-1/2 top-1/2 h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-200" />
          </div>
          {/* Small gear */}
          <div className="absolute right-6 top-[60px] h-[60px] w-[60px] animate-[spin_8s_linear_infinite_reverse] rounded-full border-6 border-neutral-300">
            <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-300" />
          </div>
          {/* Wrench */}
          <div className="absolute bottom-2 left-1/2 h-20 w-2 -translate-x-1/2 -rotate-[30deg] rounded bg-primary opacity-85">
            <div className="absolute -top-1.5 left-1/2 h-[18px] w-6 -translate-x-1/2 rounded-t-xl border-5 border-b-0 border-primary bg-transparent" />
            <div className="absolute -bottom-0.5 left-1/2 h-2 w-4 -translate-x-1/2 rounded-b bg-primary" />
          </div>
        </div>

        {/* Title */}
        <h1 className="mb-3 font-heading text-2xl font-normal leading-tight text-text">
          {t("server.title")}
        </h1>

        {/* Message */}
        <p className="mb-5 max-w-[420px] text-sm leading-relaxed text-text-secondary">
          {t("server.description")}
        </p>

        {/* Error digest badge */}
        {error.digest && (
          <span className="mb-8 inline-block rounded-pill bg-neutral-100 px-4 py-1 font-mono text-xs tracking-wide text-text-secondary">
            {t("server.errorId", { digest: error.digest })}
          </span>
        )}

        {/* Actions */}
        <div className="mb-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-[var(--btn-height-md)] items-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary shadow-button transition-[background-color] hover:bg-primary-hover focus-visible:shadow-ring"
          >
            {tCommon("actions.tryAgain")}
          </button>
          <a
            href="mailto:support@givernance.org"
            className="inline-flex h-[var(--btn-height-md)] items-center rounded-button border border-border bg-white px-6 text-sm font-medium text-text shadow-sm transition-[background-color] hover:bg-surface-container-low focus-visible:shadow-ring"
          >
            {tCommon("actions.contactSupport")}
          </a>
        </div>

        {/* Footer */}
        <p className="text-xs text-text-muted">
          {t.rich("server.dashboardLink", {
            link: (chunks) => (
              <Link
                href="/"
                className="font-medium text-primary hover:text-primary-dark hover:underline"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </div>
  );
}
