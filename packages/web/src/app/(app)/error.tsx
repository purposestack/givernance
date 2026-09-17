"use client";

import { RotateCcw, Wrench } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Error boundary INSIDE the operator shell (issue #614). Without it, any
 * page-level throw under `(app)` bubbled to the root `app/error.tsx`, which
 * replaces the whole viewport — sidebar, topbar and the operator's bearings
 * included. Here the shell stays mounted and only the content area shows the
 * failure, with a retry and a way back to the dashboard.
 *
 * Same tone and copy structure as the root 500 page (`errors.server.*`,
 * GLO-003): apology, "team notified", error-digest badge, Try again.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");
  const tCommon = useTranslations("common.actions");

  return (
    <div role="alert">
      <EmptyState
        icon={Wrench}
        title={t("app.title")}
        description={
          <>
            {t("app.description")}
            {error.digest ? (
              <span className="mt-4 block">
                <span className="inline-block rounded-pill bg-surface-container px-4 py-1 font-mono text-xs tracking-wide text-on-surface-variant">
                  {t("server.errorId", { digest: error.digest })}
                </span>
              </span>
            ) : null}
          </>
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" variant="primary" size="sm" onClick={reset}>
              <RotateCcw size={16} aria-hidden="true" />
              {tCommon("tryAgain")}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard">{tCommon("backToDashboard")}</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
