import "@testing-library/jest-dom/vitest";

import React from "react";
import { afterEach, beforeEach, vi } from "vitest";

import messages from "../../messages/en.json";
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
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) =>
    interpolate(lookupMessage(namespace ? `${namespace}.${key}` : key), values),
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
