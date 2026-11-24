import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BoardLive } from "./Agents.ts";
import { Issue } from "./Board/Issue.aggregate.ts";
import { IssueId } from "./Board/Issue.id.ts";
import { IssueDetail } from "./Board/IssueDetail.view.ts";
import { WebApi } from "./Board/WebApi.api.ts";
import { GitHubIssues } from "./GitHubIssues.ts";

/** The board, and GitHub's events. */
const Live = Layer.mergeAll(BoardLive, GitHub.RepositoryEventSourceLive);

/**
 * Receives the repository's events, serves the web app's Api at `/api`, and
 * shows an issue at `GET /issues/<number>`.
 */
export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const details = yield* IssueDetail;
    const web = yield* WebApi;
    yield* GitHubIssues;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // The web app's commands and live reads.
        if (new URL(request.url, "http://board").pathname.startsWith("/api")) {
          return yield* web.fetch;
        }
        const [, area, number] = new URL(request.url, "http://board").pathname.split("/");
        if (area !== "issues" || number === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const detail = yield* details.get(Issue.ref(IssueId.make(number)));
        return yield* HttpServerResponse.json(Option.getOrNull(detail));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Live)),
) {}
