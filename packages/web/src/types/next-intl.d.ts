import type messages from "../../messages/fr.json";

/**
 * ADR-015: Type-safe translation keys.
 * French is the source language — all keys must exist in fr.json first.
 * TypeScript will error if a translation key doesn't exist.
 */
type Messages = typeof messages;

declare module "next-intl" {
  interface AppConfig {
    Locale: "fr" | "en";
    Messages: Messages;
  }
}
