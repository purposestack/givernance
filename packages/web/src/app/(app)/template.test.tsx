/**
 * (app) route template tests — the once-per-navigation page entrance
 * (ADR-035 rule A2 in docs/adrs/adr-035-loading-motion-choreography.md).
 * Next.js remounts a template on every navigation, so the entrance
 * semantics live in the framework; what we own — and pin here — is the
 * wrapper contract: the shared `.reveal-item` utility at cascade slot 0
 * (frame leads nested content, rule A3) and the AppShell spacing scale
 * carried over so fragment-rooted pages keep their vertical rhythm
 * (zero layout shift, rule A6).
 */

import { describe, expect, it } from "vitest";

import { render, screen } from "@/tests/test-utils";

import AppTemplate from "./template";

describe("AppTemplate", () => {
  it("wraps routed content in a .reveal-item entrance at cascade slot 0", () => {
    const { container } = render(
      <AppTemplate>
        <p>page content</p>
      </AppTemplate>,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.classList.contains("reveal-item")).toBe(true);
    // No --cascade-i override: the default 0 means the page frame leads
    // any nested .cascade/.reveal-item choreography (rule A3).
    expect(wrapper.style.getPropertyValue("--cascade-i")).toBe("");
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
