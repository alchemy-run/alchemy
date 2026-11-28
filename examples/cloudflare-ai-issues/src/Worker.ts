import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
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
import { WebApi } from "./Board/WebApi.api.ts";
import { GitHubIssues } from "./GitHubIssues.ts";
import { Smart, SmartLlama } from "./Models.ts";
import { PostAnswerLive } from "./PostAnswer.tool.ts";
import { SandboxLive } from "./Sandbox.ts";
import { SearchIssuesLive } from "./SearchIssues.tool.ts";
import type { SessionRead } from "./SessionRead.ts";
import { Triage, TriageLive } from "./Triage.process.ts";

/**
 * How a process runs: on Pi, on Llama, with these tools and a Boat sandbox.
 * To run sessions on OpenCode, provide `OpenCode.HarnessLive`,
 * `OpenCode.CodingTools` and `OpenCodeCloudflare.DurableObjectStorage`
 * instead; nothing else changes.
 */
const Harness = Layer.mergeAll(
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
 * The board on Durable Objects: an aggregate, a view and a policy are each
 * a class the platform declares, one instance per key. Its policy holds
 * Triage, so it still needs one.
 */
const BoardLive = Board.layer(IssueWorkLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * Triage on Durable Objects: one object per session, which builds the prose
 * with what a session runs on and the board it mentions.
 */
const TriageSessions = AICloudflare.ProcessSessions(
  TriageLive.pipe(Layer.provide(Layer.mergeAll(Harness, BoardLive))),
);

const Live = Layer.mergeAll(BoardLive, TriageSessions, GitHub.RepositoryEventSourceLive).pipe(
  Layer.provide(TriageSessions),
);

/**
 * Receives the repository's events, serves the web app's Api at `/api`,
 * shows an issue at `GET /issues/<number>`, and its session at
 * `GET /sessions/<number>`.
 */
export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const details = yield* IssueDetail;
    const web = yield* WebApi;
    const triage = yield* Triage;
    yield* GitHubIssues;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://board");
        // The web app's commands and live reads.
        if (url.pathname.startsWith("/api")) return yield* web.fetch;
        const [, area, number] = url.pathname.split("/");
        if (number === undefined) return HttpServerResponse.text("not found", { status: 404 });
        if (area === "sessions") {
          // A session's key is its issue. The page asks again for what came after the item it last saw.
          const session = triage.get(number);
          const after = Number(url.searchParams.get("after") ?? 0);
          const read: SessionRead = {
            ...(yield* session.status),
            ...(yield* session.history({ after, take: 100 })),
          };
          return yield* HttpServerResponse.json(read);
        }
        if (area !== "issues") return HttpServerResponse.text("not found", { status: 404 });
        const detail = yield* details.get(Issue.ref(IssueId.make(number)));
        return yield* HttpServerResponse.json(Option.getOrNull(detail));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Live)),
) {}
