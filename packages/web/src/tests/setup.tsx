import "@testing-library/jest-dom/vitest";

import React from "react";
import { afterEach, beforeEach, vi } from "vitest";

import messages from "../messages/en.json";
import { mockApiClient, mockRouter, mockToast } from "./mocks";

type MessageValue = string | Record<string, unknown>;

function lookupMessage(path: string): string {
  const parts = path.split(".");
  let current: MessageValue | undefined = messages as unknown as MessageValue;

  for (const part of parts) {
    if (!current || typeof current === "string" || !(part in current)) {
      return path;
    }
    current = (current as Record<string, MessageValue>)[part];
  }

  return typeof current === "string" ? current : path;
}

function interpolate(message: string, values?: Record<string, unknown>) {
  if (!values) return message;

  return message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/settings/funds",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace?: string) => {
    // Plain string interpolation — drops any function-typed `values`
    // (used by `t.rich` for inline tag formatters like
    // `b: (chunks) => <b>{chunks}</b>`) so a non-rich call doesn't
    // crash trying to coerce a function to a string.
    const scalarValues = (values?: Record<string, unknown>) => {
      if (!values) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (typeof v !== "function") out[k] = v;
      }
      return out;
    };
    const translate = (key: string, values?: Record<string, unknown>) =>
      interpolate(lookupMessage(namespace ? `${namespace}.${key}` : key), scalarValues(values));
    // `t.rich` returns a ReactNode in production — it invokes the
    // formatter functions on the inner text between matching tags
    // (e.g. `<b>foo</b>` → `b("foo")`). The shape here is a
    // best-effort mock: invoke every function-valued formatter with
    // the message string so the rendered tree contains the elements,
    // then just return the string itself for any leftover plain
    // values. Tests rarely assert against rich content directly; this
    // is enough to prevent `t.rich is not a function` crashes during
    // render.
    const rich = (key: string, values?: Record<string, unknown>): React.ReactNode => {
      const raw = interpolate(
        lookupMessage(namespace ? `${namespace}.${key}` : key),
        scalarValues(values),
      );
      if (!values) return raw;
      const fragments: React.ReactNode[] = [];
      let remaining = raw;
      for (const [k, v] of Object.entries(values)) {
        if (typeof v !== "function") continue;
        const tagRegex = new RegExp(`<${k}>(.*?)</${k}>`, "g");
        const matches = [...remaining.matchAll(tagRegex)];
        if (matches.length === 0) continue;
        let lastIndex = 0;
        const formatter = v as (chunks: string) => React.ReactNode;
        for (const match of matches) {
          if (match.index === undefined) continue;
          if (match.index > lastIndex) fragments.push(remaining.slice(lastIndex, match.index));
          fragments.push(formatter(match[1] ?? ""));
          lastIndex = match.index + match[0].length;
        }
        remaining = remaining.slice(lastIndex);
      }
      if (remaining) fragments.push(remaining);
      return fragments.length > 0 ? fragments : raw;
    };
    return Object.assign(translate, { rich });
  },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: mockToast,
  Toaster: () => null,
}));

vi.mock("@/lib/api/client-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client-browser")>();
  return {
    ...actual,
    createClientApiClient: () => mockApiClient,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

if (!window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

if (!window.HTMLElement.prototype.hasPointerCapture) {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
}

if (!window.HTMLElement.prototype.setPointerCapture) {
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
}

if (!window.HTMLElement.prototype.releasePointerCapture) {
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
}
