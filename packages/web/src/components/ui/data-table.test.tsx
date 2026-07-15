/**
 * DataTable entrance-choreography tests (ADR-035, rules A2 / A4 / B12
 * in docs/adrs/adr-035-loading-motion-choreography.md). The contract
 * under test:
 *
 * - `animateEntrance` is opt-in — without it, rows carry no animation
 *   classes (every existing consumer is byte-identical).
 * - With it, the first ENTRANCE_ROW_CAP (10) rows cascade via
 *   `.reveal-item` with `--cascade-i = entranceCascadeOffset + index`;
 *   rows past the cap share the last step (1 s budget, rule A4).
 * - The gate is the mount-time `data` reference: any new array (filter/
 *   sort/pagination/refetch round-trip) renders animation-free —
 *   entrances never replay on data swaps (rule B12).
 */

import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";

import { render } from "@/tests/test-utils";

import { DataTable } from "./data-table";

interface Row {
  id: string;
  name: string;
}

const columns: ColumnDef<Row, unknown>[] = [{ accessorKey: "name", header: "Name" }];

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, name: `Row ${i}` }));
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"));
}

describe("DataTable — entrance choreography (ADR-035)", () => {
  it("renders no animation classes by default (opt-in contract)", () => {
    const { container } = render(<DataTable columns={columns} data={makeRows(3)} />);
    for (const row of bodyRows(container)) {
      expect(row.classList.contains("reveal-item")).toBe(false);
      expect(row.style.getPropertyValue("--cascade-i")).toBe("");
    }
  });

  it("cascades rows with --cascade-i = offset + index when animateEntrance is set", () => {
    const { container } = render(
      <DataTable columns={columns} data={makeRows(3)} animateEntrance entranceCascadeOffset={2} />,
    );
    const rows = bodyRows(container);
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(row.classList.contains("reveal-item")).toBe(true);
      expect(row.style.getPropertyValue("--cascade-i")).toBe(String(2 + index));
    });
  });

  it("caps the cascade at 10 steps — rows past the cap share the last delay (rule A4)", () => {
    const { container } = render(
      <DataTable columns={columns} data={makeRows(12)} animateEntrance />,
    );
    const rows = bodyRows(container);
    expect(rows[9]?.style.getPropertyValue("--cascade-i")).toBe("9");
    expect(rows[10]?.style.getPropertyValue("--cascade-i")).toBe("9");
    expect(rows[11]?.style.getPropertyValue("--cascade-i")).toBe("9");
  });

  it("never replays the entrance when a data swap delivers a new array (rule B12)", () => {
    const initial = makeRows(3);
    const { container, rerender } = render(
      <DataTable columns={columns} data={initial} animateEntrance />,
    );
    expect(bodyRows(container)[0]?.classList.contains("reveal-item")).toBe(true);

    // Filter/sort/pagination/refetch round-trips always produce a new
    // array reference — the entrance classes must drop.
    rerender(<DataTable columns={columns} data={makeRows(3)} animateEntrance />);
    for (const row of bodyRows(container)) {
      expect(row.classList.contains("reveal-item")).toBe(false);
    }
  });

  it("keeps the entrance classes across re-renders with the SAME array reference", () => {
    const initial = makeRows(3);
    const { container, rerender } = render(
      <DataTable columns={columns} data={initial} animateEntrance />,
    );
    // Client-only re-render (e.g. parent state) with an unchanged data
    // reference keeps the same DOM nodes + classes (forwards fill means
    // the finished animation does not restart).
    rerender(<DataTable columns={columns} data={initial} animateEntrance />);
    for (const row of bodyRows(container)) {
      expect(row.classList.contains("reveal-item")).toBe(true);
    }
  });
});
