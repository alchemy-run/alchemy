/**
 * An instance on a pool of its own, so a test can kill or stop its node
 * without touching any other fixture's calls. Its alarm handler records
 * the node running it; `arm`'s hangs on its first run and finishes on
 * every run after, and `armHeld`'s comes due while a transaction keeps it
 * from being claimed. `writeUntilStopped` keeps writing until its storage
 * fails.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
      // The container this runs on: Docker sets its hostname to its id.
      const node = Config.String("HOSTNAME").pipe(Effect.orElseSucceed(() => "unknown"));
      return {
        node: () => node,
        // Writes every 100ms until storage fails, then reports the failure as
        // data, as a Domain object reports a defect.
        writeUntilStopped: () =>
          Effect.gen(function* () {
            for (let i = 0; i < 300; i++) {
              const exit = yield* Effect.exit(state.storage.put("busy", i));
              if (Exit.isFailure(exit)) return { failed: Cause.pretty(exit.cause) };
              yield* Effect.sleep("100 millis");
            }
            return { failed: null };
          }),
        arm: () =>
          Effect.gen(function* () {
            yield* state.storage.put("hang", true);
            yield* state.storage.setAlarm((yield* Effect.sync(() => Date.now())) + 100);
          }),
        // RivetKit fires the alarm while the transaction holds storage, so
        // its handler can't claim it until the transaction ends.
        armHeld: () =>
          Effect.gen(function* () {
            yield* state.storage.setAlarm((yield* Effect.sync(() => Date.now())) + 100);
            yield* state.storage.transaction(Effect.sleep("25 seconds"));
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
            yield* state.storage.put("node", yield* node);
            // `arm`'s first run waits for its node to be killed.
            const hang = (yield* state.storage.get<boolean>("hang")) === true;
            if (hang && (yield* read("runs")) === 1) yield* Effect.sleep("10 minutes");
            yield* bump("done");
          }),
      };
    });
  }).pipe(Effect.provide(Abandoned)),
) {}
