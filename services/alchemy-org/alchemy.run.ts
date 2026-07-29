/**
 * The AlchemyOrg Stack — provisions the surface the factory manages
 * AND the factory itself, on BOTH substrates:
 *
 * - the `test-alchemy` sandbox repository (the exported repo const IS
 *   the resource — resources are memoized by FQN);
 * - the LOCAL org (src/Server.ts): an Effectful Local.Vite service
 *   running the processes as a detached local process, UI included;
 * - the DEPLOYED org (src/Worker.ts): a Cloudflare Worker running the
 *   same processes over Cloudflare physics — agent runs as Durable
 *   Objects, a real repository webhook, D1, and the sandbox container
 *   (src/services/Sandbox.runtime.ts registers the container's
 *   program; its default export must be provided on the Stack so the
 *   bundler emits the image entrypoint).
 *
 * Deploying needs GitHub credentials (the repo, the webhook, the
 * bound tokens) and Cloudflare credentials (worker, D1, container).
 * Both org runtimes read `ANTHROPIC_API_KEY` — the local service from
 * the operator's shell, the Worker from the secret bound at deploy.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Local from "alchemy/Local";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/Repos.ts";
import AlchemyOrg from "./src/Server.ts";
import SandboxLive from "./src/services/Sandbox.runtime.ts";
import AlchemyOrgWorker from "./src/Worker.ts";

export default Alchemy.Stack(
  "AlchemyOrg",
  {
    providers: Layer.mergeAll(
      GitHub.providers(),
      Local.providers(),
      Cloudflare.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const org = yield* AlchemyOrg;
    const worker = yield* AlchemyOrgWorker;

    return {
      repository: repo.fullName,
      url: org.url,
      pid: org.pid,
      workerUrl: worker.url,
    };
  }).pipe(Effect.provide(SandboxLive)),
);
