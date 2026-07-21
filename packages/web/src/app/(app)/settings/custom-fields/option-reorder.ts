/**
 * Pure splice-and-renumber planner for picklist option reordering
 * (Epic #539, PR #550 review MAJOR-5).
 *
 * `PATCH /v1/custom-fields/:id/options/:optId` persists exactly the
 * `sortOrder` it is given — it never renumbers siblings. A single
 * moved-option PATCH therefore produces duplicate sortOrders and a visual
 * no-op on every consumer surface (they all stable-sort by sortOrder). The
 * fix: the client owns the splice-and-renumber contract — renumber the whole
 * list to contiguous `0..n-1` in the new visual order and persist every
 * option whose stored sortOrder changed (exactly two PATCHes for an adjacent
 * move on a clean list).
 *
 * Self-healing: a list already carrying duplicate or gappy sortOrders
 * (pre-fix corruption) comes out fully renumbered on the next move.
 */

import type { CustomFieldOption } from "@/models/custom-field";

export interface OptionReorderPlan {
  /** The full list in its new visual order, renumbered `0..n-1`. */
  ordered: CustomFieldOption[];
  /** Options whose persisted sortOrder must change, in apply order. */
  changed: { id: string; sortOrder: number }[];
}

/**
 * Plan an arrow move of the option at `index` by `delta`. Returns `null`
 * when the move is out of bounds (already first/last).
 */
export function planOptionMove(
  options: readonly CustomFieldOption[],
  index: number,
  delta: -1 | 1,
): OptionReorderPlan | null {
  const target = index + delta;
  if (index < 0 || index >= options.length) return null;
  if (target < 0 || target >= options.length) return null;
  const next = [...options];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return null;
  next.splice(target, 0, moved);
  const ordered = next.map((option, position) => ({ ...option, sortOrder: position }));
  const previousById = new Map(options.map((option) => [option.id, option.sortOrder]));
  const changed = ordered
    .filter((option) => previousById.get(option.id) !== option.sortOrder)
    .map((option) => ({ id: option.id, sortOrder: option.sortOrder }));
  return { ordered, changed };
}

/** Display order for options everywhere: ascending persisted sortOrder. */
export function sortOptionsByOrder(options: readonly CustomFieldOption[]): CustomFieldOption[] {
  return [...options].sort((a, b) => a.sortOrder - b.sortOrder);
}
