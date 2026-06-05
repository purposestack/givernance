import type React from "react";
import { vi } from "vitest";
import { render, screen } from "@/tests/test-utils";

vi.mock("next-intl", async () => {
  const messages = (await import("../../messages/en.json")).default as Record<string, unknown>;

  function lookup(path: string): string {
    const parts = path.split(".");
    let current: unknown = messages;
    for (const part of parts) {
      if (
        !current ||
        typeof current === "string" ||
        !(part in (current as Record<string, unknown>))
      ) {
        return path;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" ? current : path;
  }

  function translate(namespace?: string) {
    const base = (key: string) => lookup(namespace ? `${namespace}.${key}` : key);
    return Object.assign(base, {
      rich: (
        key: string,
        values?: Record<string, (chunks: React.ReactNode) => React.ReactNode>,
      ) => {
        const message = base(key);
        if (!values?.link) return message;
        const [before, after] = message.split(/<link>|<\/link>/).filter(Boolean);
        return (
          <>
            {before ?? ""}
            {values.link("link")}
            {after ?? ""}
          </>
        );
      },
    });
  }

  return {
    useLocale: () => "en",
    useTranslations: (namespace?: string) => translate(namespace),
  };
});

import { SignupForm } from "./signup-form";

describe("SignupForm", () => {
  it("renders the workspace URL with an inline .givernance.org suffix on the right of the input", () => {
    render(<SignupForm />);

    const suffix = screen.getByText(".givernance.org");
    const wrapper = suffix.parentElement;

    // The addon is laid out as a horizontal flex row (not a stacked prefix),
    // so the editable input top-aligns with the other fields.
    expect(wrapper).toHaveClass("flex", "items-stretch");
    expect(wrapper).not.toHaveClass("flex-col");

    // The suffix sits AFTER the input (input first, suffix last in DOM order).
    expect(wrapper?.querySelector("input")).not.toBeNull();
    expect(wrapper?.lastElementChild).toBe(suffix);
  });
});
