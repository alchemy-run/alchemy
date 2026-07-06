import type { Fetcher } from "@/Cloudflare/Fetcher";
import {
  unwrapWorkerLoader,
  type WorkerLoaderWorkerCode,
} from "@/Cloudflare/Workers/WorkerLoader";
import { describe, expect, test } from "@effect/vitest";

const fetcher = (raw: unknown): Fetcher => ({ raw }) as Fetcher;

const code = (
  overrides: Partial<WorkerLoaderWorkerCode>,
): WorkerLoaderWorkerCode => ({
  compatibilityDate: "2025-01-01",
  mainModule: "index.js",
  modules: { "index.js": "export default { fetch: () => new Response() }" },
  ...overrides,
});

describe("WorkerLoader", () => {
  describe("unwrapWorkerLoader", () => {
    // `globalOutbound: null` disables network access for the dynamic worker.
    // `?.raw` alone coerced it to `undefined`, which the runtime treats as
    // "default outbound" — silently re-enabling network access for workers
    // meant to be sandboxed (#746).
    test("preserves explicit globalOutbound: null", () => {
      expect(
        unwrapWorkerLoader(code({ globalOutbound: null })).globalOutbound,
      ).toBeNull();
    });

    test("leaves omitted globalOutbound undefined (default outbound)", () => {
      expect(unwrapWorkerLoader(code({})).globalOutbound).toBeUndefined();
    });

    test("unwraps a provided globalOutbound to its raw fetcher", () => {
      const raw = { kind: "outbound" };
      expect(
        unwrapWorkerLoader(code({ globalOutbound: fetcher(raw) }))
          .globalOutbound,
      ).toBe(raw);
    });

    test("unwraps tails and streamingTails to raw fetchers", () => {
      const tail = { kind: "tail" };
      const streamingTail = { kind: "streamingTail" };
      const unwrapped = unwrapWorkerLoader(
        code({
          tails: [fetcher(tail)],
          streamingTails: [fetcher(streamingTail)],
        }),
      );
      expect(unwrapped.tails).toEqual([tail]);
      expect(unwrapped.streamingTails).toEqual([streamingTail]);
    });
  });
});
