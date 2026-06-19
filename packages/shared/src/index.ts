/** @givernance/shared — shared types, schemas, events, and validators */

export * from "./constants/index.js";
export * from "./custom-fields/index.js";
export * from "./events/index.js";
// NOTE: ./finance is deliberately NOT re-exported here. The FX business layer
// (ExchangeRateService, FxRateService) touches Drizzle queries + ioredis and is
// reachable only via the `@givernance/shared/finance` subpath export so it never
// leaks into the @givernance/web (Next.js) browser bundle (ADR-013, issue #480).
export * from "./i18n/locales.js";
export * from "./jobs/index.js";
export * from "./mobilisation/score.js";
export * from "./postal-export-mode.js";
export * from "./postal-print-layout.js";
export * from "./schema/index.js";
export * from "./types/index.js";
export * from "./validators/index.js";
