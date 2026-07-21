/**
 * DataTable entrance-choreography tests (ADR-035, rules A2 / A4 / B12
 * in docs/adrs/adr-035-loading-motion-choreography.md). The contract
 * under test:
 *
 * - `animateEntrance` is opt-in — without it, rows carry no animation
 *   classes (every existing consumer is byte-identical).
 * - With it, the first ENTRANCE_ROW_CAP (6) rows cascade via the
 *   fade-only `.row-reveal` utility (opacity only — no translateY on
 *   `<tr>`, WebKit collapsed-border quirk) with
 *   `--cascade-i = entranceCascadeOffset + index` and a local
 *   `--stagger-step: 25ms`; rows past the cap share the last step
 *   (1 s budget, rule A4).
 * - The gate is the mount-time `data` reference AND the mount-time
 *   sorting state: any new array (filter/pagination/refetch round-trip)
 *   or any sort change (uncontrolled header click included) renders
 *   animation-free — entrances never replay on data swaps (rule B12).
 */

import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";

import { fireEvent, render } from "@/tests/test-utils";

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
      expect(row.classList.contains("row-reveal")).toBe(false);
      expect(row.style.getPropertyValue("--cascade-i")).toBe("");
    }
  });

  it("cascades rows with --cascade-i = offset + index and a 25ms local stagger", () => {
    const { container } = render(
      <DataTable columns={columns} data={makeRows(3)} animateEntrance entranceCascadeOffset={2} />,
    );
    const rows = bodyRows(container);
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(row.classList.contains("row-reveal")).toBe(true);
      expect(row.style.getPropertyValue("--cascade-i")).toBe(String(2 + index));
      // Local rhythm — rows tick at half the page-level stagger so the
      // invisible-but-clickable window stays short (rule A4).
      expect(row.style.getPropertyValue("--stagger-step")).toBe("25ms");
    });
  });

  it("caps the cascade at 6 steps — rows past the cap share the last delay (rule A4)", () => {
    const { container } = render(
      <DataTable columns={columns} data={makeRows(8)} animateEntrance />,
    );
    const rows = bodyRows(container);
    expect(rows[5]?.style.getPropertyValue("--cascade-i")).toBe("5");
    expect(rows[6]?.style.getPropertyValue("--cascade-i")).toBe("5");
    expect(rows[7]?.style.getPropertyValue("--cascade-i")).toBe("5");
  });

  it("never replays the entrance when a data swap delivers a new array (rule B12)", () => {
    const initial = makeRows(3);
    const { container, rerender } = render(
      <DataTable columns={columns} data={initial} animateEntrance />,
    );
    expect(bodyRows(container)[0]?.classList.contains("row-reveal")).toBe(true);

    // Filter/sort/pagination/refetch round-trips always produce a new
    // array reference — the entrance classes must drop.
    rerender(<DataTable columns={columns} data={makeRows(3)} animateEntrance />);
    for (const row of bodyRows(container)) {
      expect(row.classList.contains("row-reveal")).toBe(false);
    }
  });

  it("keeps the entrance classes across re-renders with the SAME array reference", () => {
    const initial = makeRows(3);
    const { container, rerender } = render(
      <DataTable columns={columns} data={initial} animateEntrance />,
    );
    // Client-only re-render (e.g. parent state) with an unchanged data
    // reference keeps the same DOM nodes + classes (backwards fill means
    // the finished animation does not restart).
    rerender(<DataTable columns={columns} data={initial} animateEntrance />);
    for (const row of bodyRows(container)) {
      expect(row.classList.contains("row-reveal")).toBe(true);
    }
  });

  it("renders the emptyState in a full-width cell with vertical breathing room", () => {
    // Regression: the empty cell only had `px-5`, so the empty state sat
    // flush against the thead border above and the container edge below
    // (the pagination footer is hidden when there are no rows). The fix
    // is `py-5` on the shared cell — one place for every consumer.
    const { container, getByText } = render(
      <DataTable columns={columns} data={[]} emptyState={<div>No results here</div>} />,
    );
    expect(getByText("No results here")).toBeTruthy();
    const cell = container.querySelector<HTMLTableCellElement>("tbody td");
    expect(cell).not.toBeNull();
    expect(cell?.colSpan).toBe(columns.length);
    expect(cell?.classList.contains("px-5")).toBe(true);
    expect(cell?.classList.contains("py-5")).toBe(true);
  });

  it("never animates the empty-state row, even with animateEntrance (ADR-035)", () => {
    // Only DATA rows join the `.row-reveal` cascade — the empty row is
    // not an interactive target and must not fade in behind the shell.
    const { container } = render(
      <DataTable
        columns={columns}
        data={[]}
        animateEntrance
        entranceCascadeOffset={1}
        emptyState={<div>No results here</div>}
      />,
    );
    const emptyRow = bodyRows(container)[0];
    expect(emptyRow).toBeTruthy();
    expect(emptyRow?.classList.contains("row-reveal")).toBe(false);
    expect(emptyRow?.style.getPropertyValue("--cascade-i")).toBe("");
  });

  it("drops the entrance classes when a sortable header is clicked (sort gate, rule B12)", () => {
    // Uncontrolled sorting reorders rows locally WITHOUT changing the
    // `data` reference — without the sorting gate the entrance would
    // replay on the re-keyed row order.
    const { container } = render(
      <DataTable columns={columns} data={makeRows(3)} animateEntrance />,
    );
    expect(bodyRows(container)[0]?.classList.contains("row-reveal")).toBe(true);

    const sortButton = container.querySelector<HTMLButtonElement>("thead th button");
    expect(sortButton).not.toBeNull();
    if (sortButton) fireEvent.click(sortButton);

    for (const row of bodyRows(container)) {
      expect(row.classList.contains("row-reveal")).toBe(false);
    }
  });
});
