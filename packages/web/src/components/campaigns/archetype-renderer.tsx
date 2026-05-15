"use client";

import { isPublicPageStyleKey, type PublicPageStyleKey } from "@givernance/shared/constants";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { loadArchetype } from "@/archetypes/registry";
import type { ArchetypeModule, ArchetypePageData } from "@/archetypes/types";

/**
 * Donor-side renderer that lazy-loads an archetype slot bundle and
 * stitches its `Hero` / `Progress` / `AmountPicker` / `Footer` into
 * a layout-aware grid (Epic #362, ADR-030 § Decision).
 *
 * **Why a client component**: the dynamic `import()` keyed on a value
 * known only at render time (URL `?style=` param OR API
 * `publicPageStyle`) is a runtime choice; we want webpack/turbopack
 * to keep each archetype as its own chunk that the donor's browser
 * only fetches if it's the chosen archetype. SSR loading them all up-
 * front would defeat the chunk graph. The shell still renders the
 * loading placeholder server-side; the archetype's React tree mounts
 * on hydration.
 *
 * **Why no fallback render path here**: if `styleKey` is the closed-
 * enum `PublicPageStyleKey`, `ARCHETYPES[key]` is always defined
 * (the registry is closed over `PublicPageStyleKey`). Un-implemented
 * archetypes fall back to Foundation via the registry's soft-rollout
 * posture (see `registry.ts` JSDoc) — that decision lives in the
 * registry, not here.
 */
interface ArchetypeRendererProps {
  styleKey: PublicPageStyleKey;
  data: ArchetypePageData;
  /**
   * The Stripe-bearing donation form, pre-built by the shell so the
   * security-sensitive code lives in one place across all 10
   * archetypes (ADR-030 § Why not full per-archetype pages). The
   * archetype's `AmountPicker` slot embeds it wherever its picker
   * UI calls for the form. **Must be a `ReactNode`, not a `() => …`
   * callback** — Next.js RSC cannot serialize functions across the
   * server→client boundary.
   */
  formNode: ReactNode;
  /**
   * Pre-rendered "loading the archetype bundle" placeholder shown
   * between hydration start and the lazy-imported module landing.
   * Defaults to a minimal skeleton; callers can pass the hardcoded
   * pre-Epic-362 layout for the best fallback experience.
   */
  fallback?: ReactNode;
}

export function ArchetypeRenderer({
  styleKey,
  data,
  formNode,
  fallback = null,
}: ArchetypeRendererProps) {
  const [archetype, setArchetype] = useState<ArchetypeModule | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Load the archetype's slot bundle whenever the operator-picked or
  // URL-overridden style changes. `data` / `formNode` are NOT in
  // the deps because they don't influence which module to load — the
  // effect only triggers on style key.
  useEffect(() => {
    if (!isPublicPageStyleKey(styleKey)) {
      setLoadError(true);
      return;
    }
    let cancelled = false;
    loadArchetype(styleKey)
      .then((mod) => {
        if (!cancelled) {
          setArchetype(mod);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [styleKey]);

  if (loadError) {
    // Hard fail — slot bundle couldn't load. Fall through to the
    // shell's hardcoded layout (the `fallback` prop) so the donor
    // can still complete a donation. Logging telemetry on this event
    // is a PR-6 follow-up; the shell-level fallback is the immediate
    // donor-protection mechanism.
    return <>{fallback}</>;
  }

  if (!archetype) {
    // Module still loading — render the shell's fallback briefly so
    // the donor sees real content immediately, not a flash of blank.
    return <>{fallback}</>;
  }

  const { Hero, Progress, AmountPicker, Footer } = archetype;

  // Outer wrapper owns the container-query context so each archetype's
  // CSS can use `@container (min-width: ...)` instead of viewport-
  // based `@media`. This matters because the renderer is used in TWO
  // contexts:
  //   1. The donor page `/p/[id]` — full-viewport-width.
  //   2. The campaign editor preview pane — narrow column (~340–420px)
  //      inside a wide viewport.
  // Without container queries, the desktop 2-column grid was firing
  // inside the narrow preview pane (because the viewport was wide),
  // squeezing the hero/progress column to ~0–20px and rendering them
  // invisible. Container queries fix this by responding to the
  // wrapper's own width.
  //
  // The renderer is a `<div>` rather than a `<main>` so the caller
  // (which may itself be inside a campaign-editor preview pane)
  // doesn't end up with nested-main landmarks.
  //
  // `--brand-primary` is set once on the archetype wrapper so every
  // descendant CSS rule can read it via `var(--brand-primary)` without
  // each slot threading `data.colorPrimary` through inline styles.
  return (
    <div style={{ containerType: "inline-size" }}>
      <div
        data-archetype={styleKey}
        style={{ "--brand-primary": data.colorPrimary } as CSSProperties}
      >
        <Hero data={data} />
        <Progress data={data} />
        <AmountPicker data={data} formNode={formNode} />
        <Footer data={data} />
      </div>
    </div>
  );
}
