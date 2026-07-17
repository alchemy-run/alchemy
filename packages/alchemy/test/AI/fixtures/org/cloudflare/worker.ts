/**
 * The organization deployed: one Cloudflare Worker hosting the Ring DO
 * namespace, with the org — kernel, agents (each with its own tool
 * physics), the ResolveGitHubIssue process, the GitHub channel — composed as
 * Layers and provided onto the Worker's init Effect.
 *
 * Delivery is OWNED BY THE IMPLEMENTATION (the components doctrine —
 * the derived front door is gone): a hand-wired
 * `GitHub.consumeRepositoryEvents` call in the init Layer adapts each
 * webhook delivery to the catalog shapes and picks the door — `send`
 * (create the case) or `steer` (the conversation moving). The real
 * pattern — one generic implementation Layer per process, with a
 * Ledger deciding send-vs-steer transactionally — lives in
 * services/alchemy-org; this fixture keeps a minimal ledgerless copy.
 */
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Engineer, Reviewer } from "../agents.ts";
import { ResolveGitHubIssue } from "../processes.ts";
import { testAlchemy } from "../repos.ts";
import { CloudflareKernelLive, Ring } from "./kernel.ts";
import {
  ApproveHumanLive,
  BashDevBox,
  CommentLive,
  EditFileLive,
  GrepLive,
  MergePullRequestLive,
  OpenPullRequestLive,
  ReadFileLive,
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

// ─── the org: the ring + its hand-wired delivery ─────────────────
//
// Minimal, ledgerless delivery: adapt each webhook delivery to the
// catalog shapes, then pick the door — first message for a case key
// creates the run (`send`), later ones steer it (`steer(key, …)`).
// The REAL pattern now lives in services/alchemy-org: one generic
// implementation Layer per process, with a Ledger deciding
// send-vs-steer transactionally instead of this in-memory Set.

const DeliveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const issues = yield* ResolveGitHubIssue;
    const seen = new Set<string>();
    // the wire delivers TYPED events; this is just routing
    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      { events: ["issues", "issue_comment"] },
      (event) =>
        Match.value(event).pipe(
          // the machine exit: exit delivery IS delivery — hand GitHub's
          // close to the run by its world key; the kernel subscribes to
          // nothing
          Match.tag("IssueClosed", (event) =>
            issues.settle(GitHub.eventKey(event)!, event),
          ),
          Match.tag("IssueOpened", "IssueCommented", (event) =>
            Effect.suspend(() => {
              const key = GitHub.eventKey(event)!;
              if (seen.has(key)) return issues.steer(key, event);
              seen.add(key);
              return issues.send(event, { key });
            }),
          ),
          // labeled etc.: denial-by-skip
          Match.orElse(() => Effect.void),
        ),
    );
  }),
);

const OrgLive = DeliveryLive.pipe(
  // the delivery resolves ResolveGitHubIssue's live service from the SAME
  // Layer instance the worker yields below (Layer memoization)
  Layer.provideMerge(ResolveGitHubIssueLive),
  Layer.provide(CloudflareKernelLive),
  // the wire: provisions the repository webhook pointing at this
  // Worker and claims the delivery path — ONE instance shared by the
  // channel Layer and the hand-wired consuming call site. Composed
  // here (owner convention: build the environment with Layer
  // combinators, provide ONCE) — its own Worker requirement is
  // ambient in the init Effect below.
  Layer.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),
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
    // in init — the same one resolver the delivery and channel Layer
    // use (the deferred form is legal here: init runs at plan time
    // under the Stack, the bindings precedent).
    const repoRef = yield* GitHub.resolveRepository(testAlchemy);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://org");

        // GitHub webhook deliveries never reach this handler — the
        // GitHubRepositoryEventSourceLive listener claims them first,
        // and the hand-wired delivery routes them.

        // Manual case admission, typed end to end: In = the case's
        // accepted messages, Out = the IssueClosed event payload (the
        // WORLD settles the case; dispatch resolves when GitHub closes
        // the issue).
        const match = url.pathname.match(/^\/issues\/(\d+)\/work$/);
        if (request.method === "POST" && match) {
          const closed = yield* issues
            .dispatch({
              _tag: "IssueOpened",
              repository: {
                name: repoRef.repository,
                owner: { login: repoRef.owner },
              },
              issue: {
                number: Number(match[1]),
                title: `manual dispatch of #${match[1]}`,
              },
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
    // ONE provide (owner convention): the environment was built above
    // with Layer combinators — never chain Effect.provide calls.
  }).pipe(Effect.provide(OrgLive)),
) {}
