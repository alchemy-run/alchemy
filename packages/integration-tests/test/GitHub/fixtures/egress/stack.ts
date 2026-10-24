import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import EgressBoxLive from "./box.runtime.ts";
import GitHubEgressGatewayWorker from "./gateway-worker.ts";
import { GitHubEgressGateway } from "./gateway.ts";
import { EGRESS_OWNER } from "./repo.ts";
import EgressWorker from "./worker.ts";

export const providers = Layer.mergeAll(
  Cloudflare.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "GitHubEgressStack",
  { providers, state },
  Effect.gen(function* () {
    yield* GitHub.Repository("EgressRepo", {
      owner: EGRESS_OWNER,
      name: "test-github-egress",
      visibility: "private",
      autoInit: true,
    });
    const worker = yield* EgressWorker;
    yield* GitHubEgressGatewayWorker;
    return { url: worker.url.as<string>() };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EgressBoxLive, GitHubEgressGateway.host(GitHubEgressGatewayWorker)),
    ),
  ),
);
