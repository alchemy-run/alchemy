import * as Cloudflare from "alchemy/Cloudflare";
import { Queues } from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Messages } from "./Messages.ts";

// #region show
export default Cloudflare.Worker(
  "Commits",
  { main: import.meta.url },
  Effect.gen(function* () {
    const messages = yield* Queues.WriteQueue(yield* Messages);

    yield* GitHub.consumeRepositoryEvents(
      { owner: "alchemy-run", repository: "alchemy", events: ["push"] },
      (event) =>
        messages.send({ room: "commits", text: event.payload.head_commit?.message ?? "" })/*hide*/.pipe(Effect.orDie)/*end*/,
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(Effect.provide([Queues.WriteQueueBinding, Cloudflare.GitHubRepositoryEventSourceLive])),
);
// #endregion show
