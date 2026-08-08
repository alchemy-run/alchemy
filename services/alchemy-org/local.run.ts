/**
 * The engineer's LOCAL deploy: {@link EngineerServer} as a detached local
 * process — DriverCore over SqliteThreadStorage, per-machine
 * workspace, UI included. Nothing in the cloud.
 *
 * Run with the operator's shell env carrying `ANTHROPIC_API_KEY`
 * (e.g. `doppler run -- bun alchemy deploy ./local.run.ts`).
 */
import * as Alchemy from "alchemy";
import * as Local from "alchemy/Local";
import * as Effect from "effect/Effect";
import EngineerServer from "./src/Server.ts";

export default Alchemy.Stack(
  "Engineer",
  {
    providers: Local.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const engineer = yield* EngineerServer;
    return {
      url: engineer.url,
    };
  }),
);
