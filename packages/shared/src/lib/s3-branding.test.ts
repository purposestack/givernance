/**
 * Unit tests for the branding S3 helpers used by the nightly orphan-GC
 * sweep (issue #291). The sweep's integration test mocks the worker's
 * `lib/s3.js` boundary, so the pagination logic here is otherwise
 * unexecuted by any test — and a lost page in `newestBrandingObjectMtime`
 * would under-date a prefix and reap it INSIDE its grace window
 * (review M2). The helpers take the S3Client via DI, so a `{ send }`
 * stub is enough.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  deleteBrandingPrefix,
  listBrandingTopLevelPrefixes,
  newestBrandingObjectMtime,
} from "./s3-branding.js";

type CommandLike = { input: Record<string, unknown>; constructor: { name: string } };

/** Stub S3Client whose `send` replays a scripted list of responses. */
function stubClient(responses: unknown[]): { s3: S3Client; calls: CommandLike[] } {
  const calls: CommandLike[] = [];
  const send = vi.fn(async (cmd: CommandLike) => {
    calls.push(cmd);
    const next = responses.shift();
    if (next === undefined) throw new Error("stub exhausted");
    return next;
  });
  return { s3: { send } as unknown as S3Client, calls };
}

describe("listBrandingTopLevelPrefixes", () => {
  it("concatenates CommonPrefixes across pages and threads the continuation token", async () => {
    const { s3, calls } = stubClient([
      {
        CommonPrefixes: [{ Prefix: "aaa/" }, { Prefix: "bbb/" }],
        IsTruncated: true,
        NextContinuationToken: "tok-1",
      },
      { CommonPrefixes: [{ Prefix: "ccc/" }], IsTruncated: false },
    ]);

    const prefixes = await listBrandingTopLevelPrefixes(s3, "branding");

    expect(prefixes).toEqual(["aaa/", "bbb/", "ccc/"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({ Bucket: "branding", Delimiter: "/" });
    expect(calls[0]?.input.ContinuationToken).toBeUndefined();
    expect(calls[1]?.input.ContinuationToken).toBe("tok-1");
  });

  it("returns [] for an empty bucket", async () => {
    const { s3 } = stubClient([{ IsTruncated: false }]);
    expect(await listBrandingTopLevelPrefixes(s3, "branding")).toEqual([]);
  });
});

describe("newestBrandingObjectMtime", () => {
  it("tracks the max LastModified across page boundaries", async () => {
    const older = new Date("2026-01-01T00:00:00Z");
    const newest = new Date("2026-06-01T00:00:00Z");
    const { s3, calls } = stubClient([
      {
        Contents: [{ LastModified: older }, { LastModified: new Date("2026-02-01T00:00:00Z") }],
        IsTruncated: true,
        NextContinuationToken: "tok-2",
      },
      // The newest object sits on the SECOND page — a lost page here
      // is exactly the premature-reap bug this test pins down.
      { Contents: [{ LastModified: newest }], IsTruncated: false },
    ]);

    expect(await newestBrandingObjectMtime(s3, "branding", "gone-org/")).toEqual(newest);
    expect(calls[1]?.input.ContinuationToken).toBe("tok-2");
  });

  it("returns null for an empty prefix listing", async () => {
    const { s3 } = stubClient([{ IsTruncated: false }]);
    expect(await newestBrandingObjectMtime(s3, "branding", "gone-org/")).toBeNull();
  });
});

describe("deleteBrandingPrefix", () => {
  it("refuses empty, root, and slash-less prefixes without touching S3", async () => {
    const { s3, calls } = stubClient([]);
    for (const bad of ["", "/", "not-a-prefix"]) {
      await expect(deleteBrandingPrefix(s3, "branding", bad)).rejects.toThrow(
        /refused suspicious prefix/,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("paginates the listing and batches deletes, returning the total", async () => {
    const page1 = {
      Contents: [{ Key: "o/1" }, { Key: "o/2" }],
      IsTruncated: true,
      NextContinuationToken: "tok-3",
    };
    const page2 = { Contents: [{ Key: "o/3" }], IsTruncated: false };
    const { s3, calls } = stubClient([page1, {}, page2, {}]);

    const total = await deleteBrandingPrefix(s3, "branding", "o/");

    expect(total).toBe(3);
    // list, delete(2), list(with token), delete(1)
    const deletes = calls.filter((c) => c.constructor.name === "DeleteObjectsCommand");
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.input).toMatchObject({
      Delete: { Objects: [{ Key: "o/1" }, { Key: "o/2" }], Quiet: true },
    });
    expect(deletes[1]?.input).toMatchObject({ Delete: { Objects: [{ Key: "o/3" }] } });
  });
});
