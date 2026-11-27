import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { MARKER } from "./Comment.tool.ts";
import Issue from "./Issue.ts";
import { owner, repository } from "./Repo.ts";

/** Receives the repository's events and hands each issue to its Durable Object. */
export default class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const issues = yield* Issue;

    yield* GitHub.consumeRepositoryEvents(
      { owner, repository, events: ["issues", "issue_comment"] },
      Effect.fn(function* (event) {
        const issue = issues.getByName(String(event.payload.issue.number));
        if (event.name === "issues") {
          const { action, issue: opened } = event.payload;
          if (action === "opened") {
            yield* issue.opened(
              { number: opened.number, title: opened.title, body: opened.body ?? "" },
              event.id,
            );
          }
          if (action === "closed") yield* issue.closed();
          return;
        }
        const { action, comment } = event.payload;
        // The bot's own comments arrive here too.
        if (action === "created" && !comment.body.includes(MARKER)) {
          yield* issue.commented(comment.body, event.id);
        }
      }, Effect.orDie),
    );

    return {
      // GET /issues/<number> shows what the agent did on that issue.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, area, number] = new URL(request.url, "http://bot").pathname.split("/");
        if (area !== "issues" || number === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        return yield* HttpServerResponse.json(yield* issues.getByName(number).transcript());
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GitHub.RepositoryEventSourceLive)),
) {}
