import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Issue from "./Issue.ts";
import { owner, repository } from "./Repo.ts";
import { MARKER } from "./tools.ts";

/** Receives the repository's events and hands each issue to its Durable Object. */
export default class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const issues = yield* Issue;

    yield* GitHub.consumeRepositoryEvents(
      { owner, repository, events: ["issues", "issue_comment"] },
      Effect.fn(function* (event) {
        const { number, title } = event.payload.issue;
        const issue = issues.getByName(String(number));
        if (event.name === "issues") {
          const { action, issue: opened } = event.payload;
          if (action === "opened") {
            yield* issue.ask(
              number,
              `Issue #${number}: ${title}\n\n${opened.body ?? ""}`,
              event.id,
            );
          }
          if (action === "closed") yield* issue.closed();
          return;
        }
        const { action, comment } = event.payload;
        // The bot's own comments arrive here too.
        if (action === "created" && !comment.body.includes(MARKER)) {
          yield* issue.ask(number, comment.body, event.id);
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
        return yield* HttpServerResponse.json(yield* issues.getByName(number).toolCalls());
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GitHub.RepositoryEventSourceLive)),
) {}
