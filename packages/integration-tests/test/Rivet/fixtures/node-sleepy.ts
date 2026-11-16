/**
 * A class `Node.serve` hosts in the test's own process, declared to sleep
 * soon after its last call. `slept` records each instance that went to sleep.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";

export const slept: Array<string> = [];

export default class NodeSleepy extends Rivet.DurableObject<NodeSleepy>()(
  "NodeSleepy",
  { main: import.meta.url, actorOptions: { sleepTimeout: 1_000 } },
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      return {
        ping: () => Effect.succeed("pong"),
        onSleep: () => Effect.sync(() => void slept.push(state.id.name)),
      };
    }),
  ),
) {}
