/**
 * The `ARCHETYPES` registry (Epic #362, ADR-030 § Decision).
 *
 * Every entry is a `() => Promise<ArchetypeModule>` so the archetype
 * bundle is lazy-loaded by `import()` only when its key is selected.
 * A tenant on `foundation` ships ~0 KB of `cosmic-gradient` code.
 *
 * **DO NOT** rewrite this as a template-literal dynamic import
 * (`import(\`./${key}/index.ts\`)`) — Webpack/Turbopack expand the
 * prefix into "anything under `./`", which widens the attack surface
 * to any value `publicPageStyle` could carry. The closed `Record` is
 * the structural fix: an unknown key fails the TypeScript check
 * before reaching the loader. The Rejected alternatives table in
 * ADR-030 spells out why.
 *
 * Every implementation is listed; the `Partial<Record>` shape is kept
 * so a future archetype removal doesn't require a registry rewrite.
 * `IMPLEMENTED_ARCHETYPE_KEYS` is derived from the keys here so the
 * picker UI and the registry can't drift.
 */

import type { PublicPageStyleKey } from "@givernance/shared/constants";
import type { ArchetypeModule } from "./types";

const loadFoundation = () => import("./foundation").then((m) => m.default);

const ARCHETYPES: Partial<Record<PublicPageStyleKey, () => Promise<ArchetypeModule>>> = {
  foundation: loadFoundation,
  activist: () => import("./activist").then((m) => m.default),
  "calm-wellness": () => import("./calm-wellness").then((m) => m.default),
  "cosmic-gradient": () => import("./cosmic-gradient").then((m) => m.default),
  "editorial-story": () => import("./editorial-story").then((m) => m.default),
  "minimal-checkout": () => import("./minimal-checkout").then((m) => m.default),
  "emergency-appeal": () => import("./emergency-appeal").then((m) => m.default),
  "neo-brutalist": () => import("./neo-brutalist").then((m) => m.default),
  "civic-modern": () => import("./civic-modern").then((m) => m.default),
  "retro-print": () => import("./retro-print").then((m) => m.default),
};

/**
 * Resolve a style key to its loader, with the Foundation fallback for
 * unimplemented archetypes baked in. The renderer calls this; archetype
 * authors add a new key to `ARCHETYPES` above and the fallback set
 * shrinks automatically.
 */
export function loadArchetype(key: PublicPageStyleKey): Promise<ArchetypeModule> {
  return (ARCHETYPES[key] ?? loadFoundation)();
}

/**
 * The subset of `PUBLIC_PAGE_STYLE_KEYS` with a real React
 * implementation today — derived from the registry so this can never
 * drift. The campaign-editor picker reads this to render "Coming soon"
 * badges on un-implemented tiles.
 */
export const IMPLEMENTED_ARCHETYPE_KEYS: ReadonlySet<PublicPageStyleKey> = new Set(
  Object.keys(ARCHETYPES) as PublicPageStyleKey[],
);
