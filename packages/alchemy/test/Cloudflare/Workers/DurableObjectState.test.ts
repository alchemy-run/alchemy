import {
  fromDurableObjectState,
  type DurableObjectAbortOptions,
} from "@/Cloudflare/Workers/DurableObjectState.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("fromDurableObjectState.abort", () => {
  const mockState = (abort: (...args: unknown[]) => void) =>
    fromDurableObjectState({
      id: { toString: () => "id" },
      storage: { sql: {} },
      abort,
    } as never);

  it.effect("forwards reason to the raw DurableObjectState", () =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const state = mockState((...args) => {
        calls.push(args);
      });
      yield* state.abort("Hello, World!");
      expect(calls).toEqual([["Hello, World!", undefined]]);
    }),
  );

  it.effect("forwards retryAlarm options to the raw DurableObjectState", () =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const state = mockState((...args) => {
        calls.push(args);
      });
      const options: DurableObjectAbortOptions = { retryAlarm: false };
      yield* state.abort("Cleanup complete", options);
      expect(calls).toEqual([["Cleanup complete", options]]);
    }),
  );
});
