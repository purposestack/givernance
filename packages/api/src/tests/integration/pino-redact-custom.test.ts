/**
 * Redact-coverage test for custom-field values (Epic #539, docs/35 §6).
 *
 * Custom values are unredactable PII by classification — the platform
 * cannot know what an operator puts in a free-text field — so
 * `PINO_REDACT_PATHS` must cover every carrier a `custom` /
 * `donorCustom` blob can ride into a log line. This test builds a pino
 * instance with EXACTLY the shared path list (the same list
 * `createServer`, the worker, and the relay pass to their loggers) and
 * proves a value cannot reach the emitted line for each carrier shape.
 */

import { PINO_REDACT_PATHS } from "@givernance/shared/constants";
import pino from "pino";
import { describe, expect, it } from "vitest";

const SECRET = "custom-secret-a9f3";

function emit(context: Record<string, unknown>): string {
  const lines: string[] = [];
  const logger = pino(
    { level: "info", redact: [...PINO_REDACT_PATHS] },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  logger.info(context, "redact-coverage");
  const line = lines[0];
  if (!line) throw new Error("no log line captured");
  return line;
}

describe("PINO_REDACT_PATHS — custom-field value carriers", () => {
  const carriers: Array<[string, Record<string, unknown>]> = [
    ["top-level custom", { custom: { health: SECRET } }],
    ["body.custom (request body)", { body: { custom: { health: SECRET } } }],
    ["req.body.custom (fastify serializer)", { req: { body: { custom: { health: SECRET } } } }],
    ["one-level nested *.custom", { payload: { custom: { health: SECRET } } }],
    ["entity spread: constituent.custom", { constituent: { custom: { health: SECRET } } }],
    ["body.constituent.custom", { body: { constituent: { custom: { health: SECRET } } } }],
    ["donor join spread: donor.custom", { donor: { custom: { health: SECRET } } }],
    ["projection: donorCustom", { donorCustom: { health: SECRET } }],
    ["nested projection: *.donorCustom", { donation: { donorCustom: { health: SECRET } } }],
    ["snake variant: donor_custom", { donor_custom: { health: SECRET } }],
    ["nested snake variant: *.donor_custom", { row: { donor_custom: { health: SECRET } } }],
    ["campaign-member projection: constituentCustom", { constituentCustom: { health: SECRET } }],
    [
      "nested member projection: *.constituentCustom",
      { member: { constituentCustom: { health: SECRET } } },
    ],
    ["snake member projection: constituent_custom", { constituent_custom: { health: SECRET } }],
    [
      "nested snake member projection: *.constituent_custom",
      { row: { constituent_custom: { health: SECRET } } },
    ],
    ["service-row raw carrier: customRaw", { customRaw: { health: SECRET } }],
    ["nested raw carrier: *.customRaw", { member: { customRaw: { health: SECRET } } }],
    ["donation raw carrier: donorCustomRaw", { donorCustomRaw: { health: SECRET } }],
    [
      "nested donation raw carrier: *.donorCustomRaw",
      { row: { donorCustomRaw: { health: SECRET } } },
    ],
    ["join staging carrier: _constituentCustom", { _constituentCustom: { health: SECRET } }],
    [
      "nested join staging carrier: *._constituentCustom",
      { row: { _constituentCustom: { health: SECRET } } },
    ],
  ];

  for (const [name, context] of carriers) {
    it(`redacts ${name}`, () => {
      const line = emit(context);
      expect(line).not.toContain(SECRET);
      expect(line).toContain("[Redacted]");
    });
  }

  it("keeps non-PII context intact alongside a redacted blob", () => {
    const line = emit({ orgId: "org-1", custom: { health: SECRET } });
    expect(line).toContain("org-1");
    expect(line).not.toContain(SECRET);
  });
});
