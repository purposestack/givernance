import type React from "react";
import { vi } from "vitest";
import { render, screen } from "@/tests/test-utils";

vi.mock("next-intl", async () => {
  const messages = (await import("../../../messages/en.json")).default as Record<string, unknown>;

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
  it("keeps the workspace URL field on a single column for readability", () => {
    render(<SignupForm />);

    const wrapper = screen.getByText("givernance.app/").parentElement;
    expect(wrapper).toHaveClass("flex-col");
    expect(wrapper).not.toHaveClass("sm:flex-row");
  });
});
