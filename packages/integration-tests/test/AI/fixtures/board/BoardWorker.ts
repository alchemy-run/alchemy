import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import BoardAgents, { BoardLive } from "./Agents.ts";
import { BoardApi, CommentOnIssue, Issue, IssueDetail, ReportIssue } from "./Board.ts";
import { IssueId } from "./Issue.id.ts";

/**
 * Stands in for a webhook: `POST /report/<issue>` and `POST /comment/<issue>`
 * become commands on the board, `POST /issue/<issue>` reads it, and
 * `POST /session/<issue>` reads the transcript of the issue's session.
 */
export default class BoardWorker extends Cloudflare.Worker<BoardWorker>()(
  "BoardWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const issues = yield* Issue;
    const details = yield* IssueDetail;
    const agents = yield* BoardAgents;
    const api = yield* BoardApi;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // What a front end uses: commands, and live reads over WebSockets.
        if (new URL(request.url, "http://board").pathname.startsWith("/api")) {
          return yield* api.fetch;
        }
        const [, action, id] = new URL(request.url, "http://board").pathname.split("/");
        const issueId = IssueId.make(id ?? "");
        const body = (yield* request.json) as {
          readonly title?: string;
          readonly commentId?: string;
          readonly body?: string;
        };
        const answer = yield* Match.value(action).pipe(
          Match.when("report", () =>
            Effect.as(
              issues.send(new ReportIssue({ issueId, title: body.title ?? "" }), {
                commandId: `report:${issueId}`,
              }),
              { ok: true as const },
            ),
          ),
          Match.when("comment", () =>
            Effect.as(
              issues.send(
                new CommentOnIssue({
                  issueId,
                  commentId: body.commentId ?? "",
                  body: body.body ?? "",
                }),
                { commandId: `comment:${body.commentId}` },
              ),
              { ok: true as const },
            ),
          ),
          Match.when("issue", () => Effect.map(details.get(Issue.ref(issueId)), Option.getOrNull)),
          // What the issue's session was told and did, as its harness stores it.
          Match.when("session", () =>
            Effect.map(agents.getByName(issueId).transcript(issueId), (messages) => ({ messages })),
          ),
          Match.orElse(() => Effect.succeed(undefined)),
        );
        return answer === undefined
          ? HttpServerResponse.text("not found", { status: 404 })
          : yield* HttpServerResponse.json(answer);
      }).pipe(
        // Answer with the failure, so a test can say what went wrong.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(BoardLive)),
) {}
