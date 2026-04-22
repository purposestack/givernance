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
};

export const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
};
