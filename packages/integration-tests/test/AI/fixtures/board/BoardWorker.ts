import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Fast, FastLlama } from "../Processes.ts";
import {
  Board,
  BoardApi,
  CommentOnIssue,
  Issue,
  IssueDetail,
  IssueWorkLive,
  Labeler,
  ReportIssue,
} from "./Board.ts";
import { IssueId } from "./Issue.id.ts";
import { Triage } from "./Triage.ts";
import { TriageLive } from "./TriageProse.ts";

/** What a Triage session runs with: Pi, in its object's own storage, and a model. */
const Agents = Layer.mergeAll(Pi.HarnessLive, AI.DefaultModel(Fast)).pipe(
  Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, FastLlama)),
);

/** What `withdraw` is given to reset a session's object: see {@link Resettable}. */
const RESET = "reset-this-object";

/** The board on Durable Objects. Its policy holds Triage, so it still needs one. */
const BoardLive = Board.layer(IssueWorkLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * Lets a test reset a session's object, as an eviction in the middle of its
 * work does. Nothing outside an object can reset it, so the process is
 * wrapped where it is built, inside the object: withdrawing {@link RESET}
 * aborts it.
 */
const Resettable = Layer.effect(
  Triage,
  Effect.gen(function* () {
    const triage = yield* Triage;
    const state = yield* Effect.serviceOption(Cloudflare.DurableObjectState);
    return {
      ...triage,
      get: (key: string) => {
        const session = triage.get(key);
        return {
          ...session,
          withdraw: (id: string) =>
            id === RESET && Option.isSome(state)
              ? state.value.abort("reset by a test")
              : session.withdraw(id),
        };
      },
    };
  }),
).pipe(Layer.provide(TriageLive.pipe(Layer.provide(Layer.mergeAll(Agents, BoardLive)))));

/** Each Triage session in a Durable Object of this Worker, with the board its prose mentions. */
const TriageSessions = AICloudflare.layerDurableObjects(Resettable);

const Live = BoardLive.pipe(Layer.provideMerge(TriageSessions));

/**
 * Stands in for a webhook: `POST /report/<issue>` and `POST /comment/<issue>`
 * become commands on the board, `POST /issue/<issue>` reads it,
 * `POST /session/<issue>` reads the transcript of the issue's session, and
 * `POST /ask/<issue>` sends its session a message and waits for the answer.
 */
export default class BoardWorker extends Cloudflare.Worker<BoardWorker>()(
  "BoardWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const issues = yield* Issue;
    const details = yield* IssueDetail;
    const triage = yield* Triage;
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
          // Ask a session and wait for its answer, from outside its object.
          Match.when("ask", () =>
            Effect.gen(function* () {
              yield* triage.start(issueId, { as: Labeler.context({ name: "asker" }) });
              const reply = yield* triage.get(issueId).prompt(body.body ?? "");
              return { answer: reply.text };
            }),
          ),
          // The object is reset, so the call itself fails.
          Match.when("crash", () =>
            triage
              .get(issueId)
              .withdraw(RESET)
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.as({ ok: true as const }),
              ),
          ),
          // What the issue's session was told and did, as its harness stores it.
          Match.when("session", () =>
            Effect.map(triage.get(issueId).history({ take: 200 }), (page) => ({
              messages: JSON.stringify(page.items),
            })),
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
  }).pipe(Effect.provide(Live)),
) {}
