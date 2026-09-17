"use client";

import { isPublicPageStyleKey, type PublicPageStyleKey } from "@givernance/shared/constants";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { loadArchetype } from "@/archetypes/registry";
import type { ArchetypeModule, ArchetypePageData } from "@/archetypes/types";

// Shared shell — layout + padding ramp common to every archetype.
// Loaded eagerly via the renderer (not lazily with each archetype
// chunk) so the layout is in place before the archetype JS lands.
import "@/archetypes/_shell.css";

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
   * A complete, working donation page (the donor page passes the
   * hardcoded pre-Epic-362 layout, with its own live form). It is the
   * server-rendered output and the donor-protection path (issue #615):
   *
   * - **Slot bundle failed to load** (or the key is invalid) → shown
   *   immediately; the donor can still give.
   * - **Slot bundle still loading** → in the DOM but held invisible by
   *   `.archetype-fallback-pending` (`_shell.css`) for a few seconds, so
   *   the common fast path doesn't flash one design and then swap to
   *   another. The reveal is a pure-CSS delay: if hydration itself never
   *   happens, the donor still ends up on a visible page.
   *
   * Omitted by the campaign-editor preview, which renders nothing until
   * the bundle lands.
   */
  fallback?: ReactNode;
}

/** Stripe appends this to `return_url` after a 3DS / bank redirect. */
const STRIPE_RETURN_PARAM = "payment_intent_client_secret";

export function ArchetypeRenderer({
  styleKey,
  data,
  formNode,
  fallback = null,
}: ArchetypeRendererProps) {
  const [archetype, setArchetype] = useState<ArchetypeModule | null>(null);
  // True once the fallback IS the page for this visit — never swapped
  // out afterwards.
  const [fallbackSettled, setFallbackSettled] = useState(false);
  const fallbackEngagedRef = useRef(false);
  const hasFallback = fallback !== null;

  // Load the archetype's slot bundle whenever the operator-picked or
  // URL-overridden style changes. `data` / `formNode` are NOT in
  // the deps because they don't influence which module to load — the
  // effect only triggers on style key.
  useEffect(() => {
    if (!isPublicPageStyleKey(styleKey)) {
      setFallbackSettled(true);
      return;
    }
    // The fallback carries its own `<PublicDonationForm>`, and the
    // archetype would mount a SECOND instance in its place. On a Stripe
    // return the first instance resolves the PaymentIntent and strips the
    // redirect params from the URL — the second would then find nothing
    // and show an empty form to a donor who has just paid. So a Stripe
    // return settles on the fallback and never loads the archetype.
    if (hasFallback && new URLSearchParams(window.location.search).has(STRIPE_RETURN_PARAM)) {
      setFallbackSettled(true);
      return;
    }
    let cancelled = false;
    loadArchetype(styleKey)
      .then((mod) => {
        if (cancelled) return;
        // Same double-instance hazard on a slow connection: the fallback
        // was revealed and the donor is already in its form. Swapping now
        // would wipe what they typed and drop their focus — keep them on
        // the page they are using.
        if (hasFallback && fallbackEngagedRef.current) {
          setFallbackSettled(true);
          return;
        }
        setArchetype(mod);
        setFallbackSettled(false);
      })
      .catch(() => {
        // Hard fail — slot bundle couldn't load. Telemetry on this event
        // is not yet wired; the fallback is the donor-protection mechanism.
        if (!cancelled) setFallbackSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [styleKey, hasFallback]);

  if (fallbackSettled || !archetype) {
    if (!hasFallback) return null;
    // One wrapper for both the pending and the settled state so the
    // fallback's form keeps its React state when the class flips.
    return (
      <div
        className={fallbackSettled ? undefined : "archetype-fallback-pending"}
        onFocusCapture={() => {
          fallbackEngagedRef.current = true;
        }}
      >
        {fallback}
      </div>
    );
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
