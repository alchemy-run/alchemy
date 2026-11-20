/**
 * An instance whose alarm handler records the node running it and hangs
 * on its first run, so a test can kill that node, and finishes on every
 * run after. It runs on a pool of its own, so killing that pool's node
 * leaves every other fixture's calls alone.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Abandoned } from "./cluster.ts";

export default class AbandonedAlarm extends Rivet.DurableObject<AbandonedAlarm>()(
  "AbandonedAlarm",
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const read = (key: string) =>
        Effect.map(state.storage.get<number>(key), (value) => value ?? 0);
      const bump = (key: string) =>
        Effect.flatMap(read(key), (value) => state.storage.put(key, value + 1));
      return {
        arm: () =>
          Effect.gen(function* () {
            yield* state.storage.setAlarm((yield* Effect.sync(() => Date.now())) + 100);
          }),
        alarmState: () =>
          Effect.gen(function* () {
            return {
              runs: yield* read("runs"),
              done: yield* read("done"),
              node: (yield* state.storage.get<string>("node")) ?? null,
              alarm: yield* state.storage.getAlarm(),
            };
          }),
        alarm: () =>
          Effect.gen(function* () {
            yield* bump("runs");
            // The container running the handler: Docker sets its hostname to its id.
            const node = yield* Config.String("HOSTNAME").pipe(
              Effect.orElseSucceed(() => "unknown"),
            );
            yield* state.storage.put("node", node);
            // The first run waits for its node to be killed.
            if ((yield* read("runs")) === 1) yield* Effect.sleep("10 minutes");
            yield* bump("done");
          }),
      };
    });
  }).pipe(Effect.provide(Abandoned)),
) {}
