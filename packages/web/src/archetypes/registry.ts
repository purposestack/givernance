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
 * Only implemented archetypes are listed; everything else falls back
 * to Foundation via `loadArchetype()` below. The picker UI reads
 * `IMPLEMENTED_ARCHETYPE_KEYS` (derived from the registry's keys, so
 * there's a single source of truth) to mark unshipped tiles "Coming
 * soon" — operator-side signal that the pick will render as
 * Foundation until the dedicated implementation lands.
 */

import type { PublicPageStyleKey } from "@givernance/shared/constants";
import type { ArchetypeModule } from "./types";

const loadFoundation = () => import("./foundation").then((m) => m.default);

const ARCHETYPES: Partial<Record<PublicPageStyleKey, () => Promise<ArchetypeModule>>> = {
  foundation: loadFoundation,
  activist: () => import("./activist").then((m) => m.default),
  "calm-wellness": () => import("./calm-wellness").then((m) => m.default),
  "cosmic-gradient": () => import("./cosmic-gradient").then((m) => m.default),
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
