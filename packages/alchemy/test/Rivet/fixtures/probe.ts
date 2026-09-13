/**
 * A build-once probe: a Durable Object whose per-instance init counts how
 * many times it ran. The Rivet bridge must build an actor instance exactly
 * once (rivetkit mints a fresh per-call context for every action, so a
 * bridge keyed on that context would re-run init on every call).
 */
import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";

export interface InitProbeShape {
  touch: () => Effect.Effect<boolean, never, RuntimeContext>;
  inits: () => Effect.Effect<number, never, RuntimeContext>;
}

export class InitProbe extends Cloudflare.DurableObject<
  InitProbe,
  InitProbeShape
>()("InitProbe") {}

/** Per-instance init counts, keyed by the instance name (runner-process memory). */
const initCounts = new Map<string, number>();

export const InitProbeLive = InitProbe.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      // The per-instance effect: runs once per built instance.
      const id = String(state.id);
      yield* Effect.sync(() =>
        initCounts.set(id, (initCounts.get(id) ?? 0) + 1),
      );
      return {
        touch: () => Effect.succeed(true),
        inits: () => Effect.sync(() => initCounts.get(id) ?? 0),
      } satisfies InitProbeShape;
    });
  }),
);
