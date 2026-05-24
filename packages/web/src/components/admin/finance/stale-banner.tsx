// #440 — StaleBanner
import { cn } from "@/lib/utils";

import type { StaleAction, StaleActionVariant, StaleBannerTone } from "./types";

export interface StaleBannerProps {
  /** soon = amber (approaching threshold) · stale = red (past threshold). */
  band: StaleBannerTone;
  /** Already-translated headline. */
  title: string;
  /** Already-translated explanatory body. Can contain ReactNode for inline emphasis. */
  description: React.ReactNode;
  actions: StaleAction[];
  /**
   * Icon glyph. Defaults sensibly per band but a caller can override
   * (e.g. "running_with_errors" vs "schedule").
   */
  icon?: string;
  className?: string;
}

const VARIANT_CLASS: Record<StaleActionVariant, string> = {
  primary: "btn-stale--primary",
  ghost: "btn-stale--ghost",
  text: "btn-stale--text",
};

const DEFAULT_ICON: Record<StaleBannerTone, string> = {
  soon: "schedule",
  stale: "running_with_errors",
};

export function StaleBanner({
  band,
  title,
  description,
  actions,
  icon,
  className,
}: StaleBannerProps) {
  // role="status" (NOT alert) per a11y spec on initial render: this is
  // surfaced as part of the page chrome, not a runtime interruption. An
  // alert role would force a screen-reader to jump immediately, which
  // is the wrong UX for "this is here when you land on the page".
  return (
    <div className={cn("stale-banner", `stale-banner--${band}`, className)} role="status">
      <span className="sb-icon">
        <span className="material-symbols-outlined" aria-hidden="true">
          {icon ?? DEFAULT_ICON[band]}
        </span>
      </span>
      <div className="sb-body">
        <div className="sb-title">{title}</div>
        <div className="sb-text">{description}</div>
        <div className="sb-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={cn("btn-stale", VARIANT_CLASS[action.variant])}
              aria-label={action.ariaLabel}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.icon ? (
                <span className="material-symbols-outlined" aria-hidden="true">
                  {action.icon}
                </span>
              ) : null}
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
