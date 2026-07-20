/**
 * (app) route template tests — the once-per-navigation replay boundary
 * (ADR-035 rule B12 in docs/adrs/adr-035-loading-motion-choreography.md).
 * Next.js remounts a template on immediate-child segment change; the
 * remount semantics live in the framework. What we own — and pin here —
 * is the wrapper contract: it does NOT animate (pages own their
 * choreography per rule A1 — regression guard for the double-fade where
 * the template's entrance stacked on top of each page's own cascade),
 * and it carries the AppShell spacing scale so fragment-rooted pages
 * keep their vertical rhythm (zero layout shift, rule A6).
 */

import { describe, expect, it } from "vitest";

import { render, screen } from "@/tests/test-utils";

import AppTemplate from "./template";

describe("AppTemplate", () => {
  it("does not animate the wrapper — no .reveal-item double-fade over page choreography", () => {
    const { container } = render(
      <AppTemplate>
        <p>page content</p>
      </AppTemplate>,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.classList.contains("reveal-item")).toBe(false);
    expect(wrapper.classList.contains("reveal")).toBe(false);
    expect(wrapper.classList.contains("cascade")).toBe(false);
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("carries the AppShell vertical rhythm (space-y) so fragments keep their spacing", () => {
    const { container } = render(
      <AppTemplate>
        <p>a</p>
      </AppTemplate>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("space-y-6");
    expect(wrapper.className).toContain("sm:space-y-8");
  });
});
