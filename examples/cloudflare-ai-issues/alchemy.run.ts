import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Repo } from "./src/Repo.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "CloudflareAiIssues",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      DomainCloudflare.providers(),
      Boat.providers(),
      GitHub.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* Repo;
    const worker = yield* Worker;
    return { url: worker.url, repository: repo.htmlUrl };
  }),
);
