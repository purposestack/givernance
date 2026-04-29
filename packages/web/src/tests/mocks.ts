import { vi } from "vitest";

export const mockRouter = {
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
};

export const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
};

export const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  // Mirrors ApiClient.resolveBrowserUrl — a passthrough is fine for
  // tests since they don't depend on the configured baseUrl.
  resolveBrowserUrl: vi.fn((path: string) => `/api${path}`),
};
