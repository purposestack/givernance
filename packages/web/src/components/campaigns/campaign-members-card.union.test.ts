import { unionQueries } from "./campaign-members-card";

/**
 * The campaign members card accumulates filters across successive
 * applications: each "apply" ADDS the matching constituents, so the summary
 * must show EVERY filter used — not just the last (the reported bug: applying
 * LYBUNT, then MAJOR_DONOR, then LYBUNT again showed only the last chip).
 */
describe("unionQueries", () => {
  const q = (patterns: string[], conditions: unknown[] = []) =>
    ({ operator: "AND", patterns, conditions }) as never;

  it("unions pattern flags across applications and dedupes", () => {
    let acc = unionQueries(null, q(["LYBUNT"]));
    acc = unionQueries(acc, q(["MAJOR_DONOR"]));
    acc = unionQueries(acc, q(["LYBUNT"])); // re-apply — must not duplicate
    expect(acc.patterns?.sort()).toEqual(["LYBUNT", "MAJOR_DONOR"]);
  });

  it("dedupes conditions by content, not by id", () => {
    const condA = { id: "1", field: "address.city", operator: "eq", value: "Paris" };
    const condAdiffId = { id: "999", field: "address.city", operator: "eq", value: "Paris" };
    const condB = { id: "2", field: "donations.count", operator: "gte", value: 3 };
    let acc = unionQueries(null, q([], [condA]));
    acc = unionQueries(acc, q([], [condB, condAdiffId]));
    // condA (re-applied with a different id) collapses; condB is added.
    expect(acc.conditions).toHaveLength(2);
  });

  it("treats a null base as the first application", () => {
    const acc = unionQueries(null, q(["RECURRING"], []));
    expect(acc.patterns).toEqual(["RECURRING"]);
  });
});
