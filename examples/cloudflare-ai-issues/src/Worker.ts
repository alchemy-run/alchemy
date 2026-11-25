import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Board } from "./Board/Board.model.ts";
import { Issue } from "./Board/Issue.aggregate.ts";
import { IssueId } from "./Board/Issue.id.ts";
import { IssueDetail } from "./Board/IssueDetail.view.ts";
import { IssueWorkLive } from "./Board/IssueWork.policy.ts";
import { TriageLive } from "./Board/Triage.process.ts";
import { WebApi } from "./Board/WebApi.api.ts";
import { GitHubIssues } from "./GitHubIssues.ts";
import { Smart, SmartLlama } from "./Models.ts";
import { PostAnswerLive } from "./PostAnswer.tool.ts";
import { SandboxLive } from "./Sandbox.ts";
import { SearchIssuesLive } from "./SearchIssues.tool.ts";

/**
 * How a process runs: on Pi, on Llama, with these tools and a Boat sandbox.
 * To run sessions on OpenCode, provide `OpenCode.HarnessLive`,
 * `OpenCode.CodingTools` and `OpenCodeCloudflare.DurableObjectStorage`
 * instead; nothing else changes.
 */
const Agents = Layer.mergeAll(
  Pi.HarnessLive,
  Pi.CodingTools,
  AI.DefaultModel(Smart),
  SearchIssuesLive,
  PostAnswerLive,
).pipe(
  Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, SmartLlama, SandboxLive)),
  Layer.provide(Boat.CreateSandboxHttp),
);

/**
 * What the board's members do: its policy, and the prose of its process
 * with what a session runs on. Provided to the prose, so each session's
 * object builds its own harness.
 */
const Handlers = Layer.mergeAll(IssueWorkLive, TriageLive.pipe(Layer.provide(Agents)));

/**
 * Where the board runs: every member a Durable Object of this Worker. An
 * aggregate, a view, a policy and a Triage session are each a class the
 * platform declares, one instance per key.
 */
const BoardLive = Board.layer(Handlers).pipe(Layer.provide(DomainCloudflare.layerDurableObjects()));

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
