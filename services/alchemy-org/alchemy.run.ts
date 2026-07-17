/**
 * The AlchemyOrg Stack — the FACTORY, provisioned: the `test-alchemy`
 * sandbox repository it manages, and the OrgWorker (src/worker.ts),
 * whose implementation Layers declare their own infrastructure —
 * yielding the Worker provisions the repository webhook
 * (`GitHubRepositoryEventSourceLive`) and the ledger's D1 database
 * (`D1Ledger`) as a consequence of the Layers that consume them.
 *
 * The same program that defines the org provisions its surface: the
 * exported repo const (src/repos.ts) IS the resource — yielding it here
 * resolves the one instance every charter and binding already names
 * (resources are memoized by FQN).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/repos.ts";
import OrgWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "AlchemyOrg",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const factory = yield* OrgWorker;

    return {
      repository: repo.fullName,
      factory: factory.url.as<string>(),
    };
  }),
);
