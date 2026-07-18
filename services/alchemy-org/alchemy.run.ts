/**
 * The AlchemyOrg Stack — provisions the surface the factory manages:
 * the `test-alchemy` sandbox repository. The factory's processes and
 * Worker are being rebuilt on the reset AI core and will rejoin this
 * program as they land — their Layers declare their own infrastructure
 * (webhook, D1, tokens), so yielding them here is all the wiring there
 * will be.
 *
 * The same program that defines the org provisions its surface: the
 * exported repo const (src/repos.ts) IS the resource — yielding it here
 * resolves the one instance everything else names (resources are
 * memoized by FQN).
 */
import * as Alchemy from "alchemy";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import { testAlchemy } from "./src/repos.ts";

export default Alchemy.Stack(
  "AlchemyOrg",
  { providers: GitHub.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;

    return {
      repository: repo.fullName,
    };
  }),
);
