import { getTranslations } from "next-intl/server";
import { BrandLogo } from "@/components/brand-logo";
import { ErrorPageShell } from "@/components/error-page-shell";
import { PrimaryLink } from "@/components/primary-button";

/**
 * 404 Not Found page — matches GLO-002 mockup (docs/design/global/404.html).
 * Features an animated CSS compass with erratic needle and floating question marks.
 */
export default async function NotFound() {
  const t = await getTranslations("errors");
  const tCommon = await getTranslations("common");

  return (
    <ErrorPageShell>
      <BrandLogo appName={tCommon("appName")} />

      {/* Compass illustration with animations */}
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

        {/* Erratic needle — disturbed by magnetic fields */}
        <div
          className="absolute left-1/2 top-1/2 h-[52px] w-1 origin-center"
          style={{ animation: "needle-lost 6s cubic-bezier(0.4, 0, 0.2, 1) infinite" }}
        >
          <div className="absolute left-1/2 top-0 -translate-x-1/2 border-x-[6px] border-b-[24px] border-x-transparent border-b-primary" />
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 border-x-[5px] border-t-[22px] border-x-transparent border-t-neutral-300" />
        </div>

        {/* Center pivot with pulse */}
        <div
          className="absolute left-1/2 top-1/2 z-[2] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber"
          style={{ animation: "pivot-pulse 2s ease-in-out infinite" }}
        />

        {/* Floating question marks — curved paths from center outward */}
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 font-heading text-lg italic text-amber"
          style={{ animation: "q-float-1 3.2s ease-out infinite", animationDelay: "0s" }}
        >
          ?
        </span>
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 font-heading text-sm italic text-primary-light"
          style={{ animation: "q-float-2 3.8s ease-out infinite", animationDelay: "0.6s" }}
        >
          ?
        </span>
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 font-heading text-xl italic text-amber/60"
          style={{ animation: "q-float-3 4.1s ease-out infinite", animationDelay: "1.2s" }}
        >
          ?
        </span>
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 font-heading text-base italic text-primary/40"
          style={{ animation: "q-float-4 3.5s ease-out infinite", animationDelay: "2.0s" }}
        >
          ?
        </span>
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 font-heading text-lg italic text-amber/70"
          style={{ animation: "q-float-5 4.4s ease-out infinite", animationDelay: "0.9s" }}
        >
          ?
        </span>
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 font-heading text-xs italic text-primary-light/50"
          style={{ animation: "q-float-6 3.0s ease-out infinite", animationDelay: "1.8s" }}
        >
          ?
        </span>

        {/* Wandering path */}
        <div className="absolute -bottom-2 -right-5 h-10 w-[60px] rounded-br-[30px] border-2 border-l-0 border-t-0 border-dashed border-primary-light opacity-70">
          <div className="absolute -bottom-[3px] -right-[3px] h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_0_3px_var(--color-primary-50)]" />
        </div>
      </div>

      {/* Error label */}
      <div className="mb-3 font-mono text-sm font-semibold uppercase tracking-wider text-primary">
        {t("notFound.label")}
      </div>

      {/* Title */}
      <h1 className="mb-4 font-heading text-3xl font-normal leading-tight text-text">
        {t("notFound.title")}
      </h1>

      {/* Message */}
      <p className="mx-auto mb-8 max-w-[380px] text-sm leading-relaxed text-text-secondary">
        {t("notFound.description")}
      </p>

      {/* Primary CTA */}
      <div className="mb-6 flex items-center justify-center gap-3">
        <PrimaryLink href="/" size="lg">
          {tCommon("actions.backToDashboard")}
        </PrimaryLink>
      </div>

      {/* Divider */}
      <div className="mb-5 flex items-center gap-3 text-xs text-text-muted">
        <span className="h-px flex-1 bg-neutral-200" />
        {tCommon("actions.or")}
        <span className="h-px flex-1 bg-neutral-200" />
      </div>

      {/* Search placeholder */}
      <div className="mx-auto mb-8 max-w-[320px]">
        <input
          type="search"
          placeholder={t("notFound.searchPlaceholder")}
          aria-label={t("notFound.searchLabel")}
          readOnly
          className="h-[var(--input-height)] w-full rounded-input border border-border bg-white px-4 text-center text-sm text-text placeholder:text-text-muted focus-visible:shadow-ring"
        />
      </div>

      {/* Footer */}
      <footer className="text-xs text-text-muted">
        {t.rich("notFound.persistsMessage", {
          link: (chunks) => (
            <a
              href="mailto:support@givernance.org"
              className="font-medium text-primary hover:text-primary-dark hover:underline"
            >
              {chunks}
            </a>
          ),
        })}
      </footer>
    </ErrorPageShell>
  );
}
