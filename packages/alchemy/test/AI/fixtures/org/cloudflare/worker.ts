/**
 * The organization deployed: one Cloudflare Worker hosting the Ring DO
 * namespace, with the whole org — kernel, agents (each with its own tool
 * physics), loops, event channels — composed as Layers and provided onto
 * the Worker's init Effect.
 *
 * This is the shape the user writes; `alchemy deploy` provisions the
 * Worker, the DO namespace, and (via GitHubRepositoryEventSourceLive) the
 * repository webhooks — because the charters *subscribed* to those events.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import {
  Engineer,
  Judge,
  ReleaseBlogger,
  Reviewer,
  Scribe,
  Support,
  Triage,
} from "../agents.ts";
import { Autoresearch, Fix, Flywheel, Helpdesk } from "../processes.ts";
import { DiscordEventsLive, GitHubEventsLive } from "./events.ts";
import { CloudflareKernelLive, Ring } from "./kernel.ts";
import {
  ApproveHumanLive,
  AskHumanLive,
  BashDevBox,
  BashReadOnly,
  CreateIssueLive,
  EditFileLive,
  GrepLive,
  OpenPullRequestLive,
  ReadFileLive,
  ReplyLive,
  SearchIssuesLive,
} from "./tools.ts";

// ─── agents: same contracts, per-agent physics ───────────────────
// The Engineer's Bash is a read-write DevBox; the Judge's Bash is the
// same contract refusing mutation. Layer.provide scopes each choice to
// its agent — both coexist in this one Worker.

const EngineerLive = AI.layer(Engineer).pipe(
  Layer.provide([
    BashDevBox,
    GrepLive,
    ReadFileLive,
    EditFileLive,
    OpenPullRequestLive,
  ]),
);

const JudgeLive = AI.layer(Judge).pipe(
  Layer.provide([BashReadOnly, ReadFileLive]),
);

const ScribeLive = AI.layer(Scribe).pipe(Layer.provide(CreateIssueLive));

const TriageLive = AI.layer(Triage).pipe(Layer.provide(SearchIssuesLive));

// Reviewer holds the only ${Approve} in the org — and here is the
// autonomy dial: ApproveHumanLive makes Flywheel an orchestra; swapping
// in an auto-approve Layer would make it a factory. One line.
const ReviewerLive = AI.layer(Reviewer).pipe(
  Layer.provide([ApproveHumanLive, ReplyLive]),
);

const ReleaseBloggerLive = AI.layer(ReleaseBlogger).pipe(
  Layer.provide([ReadFileLive, SearchIssuesLive, OpenPullRequestLive]),
);

const SupportLive = AI.layer(Support).pipe(
  Layer.provide([
    SearchIssuesLive,
    BashReadOnly,
    ReadFileLive,
    CreateIssueLive,
    ReplyLive,
    AskHumanLive,
  ]),
);

// ─── rings: loops over their agents ──────────────────────────────

const FixLive = AI.layer(Fix).pipe(
  // loop-level Bash (the check's grading policy names it) is read-only
  Layer.provide([EngineerLive, JudgeLive, ScribeLive, BashReadOnly]),
);

const FlywheelLive = AI.layer(Flywheel).pipe(
  Layer.provide([
    FixLive,
    TriageLive,
    ReviewerLive,
    ReleaseBloggerLive,
    ScribeLive,
    ReplyLive, // nested in the ${AI.never} health-signal prose
    CreateIssueLive, // nested in the ${AI.fold} template
  ]),
);

const HelpdeskLive = AI.layer(Helpdesk).pipe(
  Layer.provide([SupportLive, ScribeLive]),
);

const AutoresearchLive = AI.layer(Autoresearch).pipe(
  // note what is NOT provided here: no Approve, no Engineer, no Bash —
  // the system ring's Req cannot demand them, so no Layer can grant them
  Layer.provide([OpenPullRequestLive, AskHumanLive]),
);

// ─── the org: rings + channels + kernel ──────────────────────────

// FixLive appears both inside FlywheelLive (the product ring dispatches
// Fix runs) and in the org's own outputs (the worker exposes a direct
// dispatch route for it).
const OrgLive = Layer.mergeAll(
  FlywheelLive,
  HelpdeskLive,
  AutoresearchLive,
  FixLive,
).pipe(
  Layer.provide([GitHubEventsLive, DiscordEventsLive]),
  Layer.provide(CloudflareKernelLive),
  // the wire: provisions repo webhooks pointing at this Worker
  Layer.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),
);

export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
  "Org",
  { main: import.meta.url },
  Effect.gen(function* () {
    // resolving the rings from context proves the whole graph closed:
    // every agent, tool, channel, and the kernel found a Layer
    const fix = yield* Fix;
    const flywheel = yield* Flywheel;
    const helpdesk = yield* Helpdesk;
    const autoresearch = yield* Autoresearch;
    const rings = yield* Ring;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://org");

        // GitHub webhook deliveries never reach this handler — the
        // GitHubRepositoryEventSourceLive listener claims them first.

        // typed end-to-end dispatch: In = IssueRef, Out = PullRequestRef
        const match = url.pathname.match(/^\/issues\/(\d+)\/fix$/);
        if (request.method === "POST" && match) {
          const pr = yield* fix
            .dispatch({
              owner: "alchemy-run",
              repository: "alchemy-effect",
              number: Number(match[1]),
            })
            .pipe(
              // both abnormal exits are typed: exhaustion is resumable
              // (raise the budget, re-dispatch); refusal carries the
              // ratified blocker
              Effect.catchTag("AI.BudgetExceeded", (e) =>
                Effect.succeed({
                  budgetExceeded: e.limit,
                  resumeHint: e.resumeHint,
                } as const),
              ),
              Effect.catchTag("AI.Refused", (e) =>
                Effect.succeed({ refused: e.reason } as const),
              ),
            );
          return yield* HttpServerResponse.json(pr);
        }

        if (request.method === "GET" && url.pathname === "/status") {
          const trace = yield* rings.getByName("Flywheel").trace();
          return yield* HttpServerResponse.json({
            rings: {
              flywheel: typeof flywheel.run,
              helpdesk: typeof helpdesk.run,
              autoresearch: typeof autoresearch.run,
            },
            flywheelTraceLength: trace.length,
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(OrgLive)),
) {}
