import type { RuntimeContext } from "@/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class CounterBoom extends Data.TaggedError("CounterBoom")<{
  readonly reason: string;
}> {}

/** The shared RPC behavior exercised through each provider's own counter. */
export interface CounterShape {
  increment: () => Effect.Effect<number, never, RuntimeContext>;
  get: () => Effect.Effect<number, never, RuntimeContext>;
  listKeys: (prefix: string) => Effect.Effect<string[], never, RuntimeContext>;
  removeKey: (key: string) => Effect.Effect<boolean, never, RuntimeContext>;
  sqlClear: () => Effect.Effect<void, never, RuntimeContext>;
  sqlInsert: (value: string) => Effect.Effect<void, never, RuntimeContext>;
  sqlAll: () => Effect.Effect<{ v: string }[], never, RuntimeContext>;
  armAlarm: (ms: number) => Effect.Effect<void, never, RuntimeContext>;
  peekAlarm: () => Effect.Effect<number | null, never, RuntimeContext>;
  cancelAlarm: () => Effect.Effect<void, never, RuntimeContext>;
  firedCount: () => Effect.Effect<number, never, RuntimeContext>;
  tick: (n: number) => Stream.Stream<number, never, RuntimeContext>;
  boom: () => Effect.Effect<never, CounterBoom, RuntimeContext>;
  alarm: () => Effect.Effect<void, never, RuntimeContext>;
}
