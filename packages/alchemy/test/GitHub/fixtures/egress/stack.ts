import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cloudflare from "@/Cloudflare";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
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
