/**
 * The coder's LOCAL deploy: {@link CoderServer} as a detached local
 * process — DriverMemory with sqlite durability, per-machine
 * workspace, UI included. Nothing in the cloud.
 *
 * Run with the operator's shell env carrying `ANTHROPIC_API_KEY`
 * (e.g. `doppler run -- bun alchemy deploy ./local.run.ts`).
 */
import * as Alchemy from "alchemy";
import * as Local from "alchemy/Local";
import * as Effect from "effect/Effect";
import CoderServer from "./src/Server.ts";

export default Alchemy.Stack(
  "Coder",
  {
    providers: Local.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const coder = yield* CoderServer;
    return {
      url: coder.url,
    };
  }),
);
