import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
