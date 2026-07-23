/**
 * The AlchemyOrg Stack — provisions the surface the factory manages
 * AND the factory itself:
 *
 * - the `test-alchemy` sandbox repository (the exported repo const IS
 *   the resource — yielding it resolves the one instance everything
 *   else names; resources are memoized by FQN);
 * - the org server (src/server.ts): an Effectful Server.Service running
 *   the processes as a detached local process (port from `ORG_PORT`/
 *   `PORT` in the deploying shell), pid tracked in state, restarted
 *   when src/** changes.
 *
 * Deploying needs GitHub credentials (the repo resource + nothing
 * else); the RUNNING org additionally needs `ANTHROPIC_API_KEY` in the
 * shell env — the service inherits it.
 */
import * as Alchemy from "alchemy";
import * as GitHub from "alchemy/GitHub";
import * as Server from "alchemy/Server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/repos.ts";
import AlchemyOrg from "./src/server.ts";

export default Alchemy.Stack(
  "AlchemyOrg",
  {
    providers: Layer.mergeAll(GitHub.providers(), Server.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const org = yield* AlchemyOrg;

    return {
      repository: repo.fullName,
      url: org.url,
      pid: org.pid,
    };
  }),
);
