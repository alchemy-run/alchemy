import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
export default Cloudflare.Worker(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const secret = yield* Config.Redacted("GITHUB_WEBHOOK_SECRET");

    yield* GitHub.consumeRepositoryEvents(
      { owner: "alchemy-run", repository: "chat", secret },
      (event) => Effect.log(event),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(Cloudflare.GitHubRepositoryEventSourceLive),
  ),
);
// #endregion show
