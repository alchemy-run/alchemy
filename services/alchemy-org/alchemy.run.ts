/**
 * The org, deployed: the sandbox repository plus {@link OrgWorker}
 * (src/Worker.ts) on Cloudflare — sessions as Durable Objects, the
 * board/ledger/approvals on D1, GitHub by webhook + token bindings,
 * every session's tools on its own container, the UI as Worker assets.
 *
 * Run with the operator's shell env carrying `ANTHROPIC_API_KEY` (it
 * binds as a Worker secret at deploy), after building the UI:
 *
 * ```sh
 * bun vite build
 * bun alchemy deploy
 * ```
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/Repos.ts";
import OrgWorker from "./src/Worker.ts";

export default Alchemy.Stack(
  "Org",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const org = yield* OrgWorker;
    return {
      repository: repo.fullName,
      url: org.url,
    };
  }).pipe(
    // the sandbox container guest: providing the runtime `.make()` is
    // what builds the image and deploys the container application
    Effect.provide(Cloudflare.AI.SandboxContainerRuntime),
  ),
);
