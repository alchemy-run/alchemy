/**
 * The organization deployed: one Cloudflare Worker hosting the Ring DO
 * namespace, with the org — kernel, agents (each with its own tool
 * physics), the ResolveGitHubIssue process, the GitHub channel — composed as
 * Layers and provided onto the Worker's init Effect.
 *
 * Delivery is the DERIVED front door (canon §5): `GitHub.frontDoor(
 * ResolveGitHubIssue)` walks the charter's declarations (`AI.when` sources, the
 * machine-observed exit) and wires `consumeRepositoryEvents`
 * underneath — adapt, then `send` (create the case) or `steer` (the
 * conversation moving). No hand-written webhook routing anywhere; a
 * hand-written `consumeRepositoryEvents` handler remains the escape
 * hatch for custom validation/denial.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { Engineer, Reviewer } from "../agents.ts";
import { ResolveGitHubIssue } from "../processes.ts";
import { testAlchemy } from "../repos.ts";
import { CloudflareKernelLive, Ring } from "./kernel.ts";
import {
  ApproveHumanLive,
  BashDevBox,
  CreateIssueLive,
  EditFileLive,
  GrepLive,
  MergePullRequestLive,
  OpenPullRequestLive,
  ReadFileLive,
  CommentLive,
  SearchIssuesLive,
} from "./tools.ts";

// ─── agents: same contracts, per-agent physics ───────────────────

const EngineerLive = AI.layer(Engineer).pipe(
  Layer.provide([
    BashDevBox,
    GrepLive,
    ReadFileLive,
    EditFileLive,
    OpenPullRequestLive,
  ]),
);

// Reviewer holds the only ${Approve} in the org — the autonomy dial:
// ApproveHumanLive makes ResolveGitHubIssue an orchestra; an auto-approve Layer
// would make it a factory. Merging stays fenced regardless:
// MergePullRequest refuses without an approved review, and Approve
// lives only in the Reviewer's template.
const ReviewerLive = AI.layer(Reviewer).pipe(
  Layer.provide([ApproveHumanLive, CommentLive]),
);

// ─── the one ring: a Process over its agents ─────────────────────
// The Process triages, replies, and merges itself — SearchIssues /
// Comment / MergePullRequest are ITS tools; agents exist only where the
// work is a distinct craft with a distinct toolbox.

const ResolveGitHubIssueLive = AI.layer(ResolveGitHubIssue).pipe(
  Layer.provide([
    EngineerLive,
    ReviewerLive,
    CommentLive,
    SearchIssuesLive,
    MergePullRequestLive,
  ]),
  // budget is NOT prose (owner ruling): ceilings are provided where the
  // term is provided — exhaustion stays a typed BudgetExceeded exit
  Layer.provide(
    AI.budget({ tokens: "10M", wallClock: "72h", iterations: 24, stall: 4 }),
  ),
);

// ─── the org: the ring + its derived front door ──────────────────

const OrgLive = GitHub.frontDoor(ResolveGitHubIssue).pipe(
  // the front door resolves ResolveGitHubIssue's live service from the SAME
  // Layer instance the worker yields below (Layer memoization)
  Layer.provideMerge(ResolveGitHubIssueLive),
  // GitHubEventsLive (CORE, src/GitHub/EventsLive.ts) satisfies the
  // GitHub.Events channel tag that ResolveGitHubIssue's machine-observed exit
  // put in Req; its own requirement on GitHub.RepositoryEventSource is
  // the transitive compile fence — deliberately left OPEN so the wire
  // below is shared with the front door (one instance, one set of
  // delivery listeners).
  Layer.provide(GitHub.GitHubEventsLive),
  Layer.provide(CloudflareKernelLive),
);

export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
  "Org",
  { main: import.meta.url },
  Effect.gen(function* () {
    // resolving the ring from context proves the whole graph closed:
    // every agent, tool, the channel, the kernel, and the front door
    // found a Layer
    const issues = yield* ResolveGitHubIssue;
    const rings = yield* Ring;

    // The exported resource resolved to its plain { owner, repository }
    // in init — the same one resolver the front door and channel Layer
    // use (the deferred form is legal here: init runs at plan time
    // under the Stack, the bindings precedent).
    const repoRef = yield* GitHub.resolveRepositoryRef(testAlchemy);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://org");

        // GitHub webhook deliveries never reach this handler — the
        // GitHubRepositoryEventSourceLive listener claims them first,
        // and the front door routes them.

        // Manual case admission, typed end to end: In = the case's
        // accepted messages, Out = the IssueClosed event payload (the
        // WORLD settles the case; dispatch resolves when GitHub closes
        // the issue).
        const match = url.pathname.match(/^\/issues\/(\d+)\/work$/);
        if (request.method === "POST" && match) {
          const closed = yield* issues
            .dispatch({
              owner: repoRef.owner,
              repository: repoRef.repository,
              number: Number(match[1]),
              title: `manual dispatch of #${match[1]}`,
              body: "",
            })
            .pipe(
              // both abnormal exits are typed: exhaustion is resumable,
              // refusal carries the ratified blocker
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
          return yield* HttpServerResponse.json(closed);
        }

        if (request.method === "GET" && url.pathname === "/status") {
          const trace = yield* rings.getByName("ResolveGitHubIssue").trace();
          return yield* HttpServerResponse.json({
            ring: typeof issues.run,
            traceLength: trace.length,
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(OrgLive),
    // the wire: provisions the repository webhook pointing at this
    // Worker and claims the delivery path — ONE instance shared by the
    // channel Layer (through OrgLive's open requirement) and the front
    // door's derived consuming call sites
    Effect.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),
  ),
) {}
