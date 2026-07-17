/**
 * The organization deployed — NOT DEPLOYED YET. One Cloudflare Worker
 * hosting the org: agents (each with its own tool physics), the
 * ResolveGitHubIssue process, the GitHub channel, and the DERIVED front
 * door (`GitHub.frontDoor(ResolveGitHubIssue)` walks the charter's
 * declarations and wires `consumeRepositoryEvents` underneath — no
 * hand-written webhook routing).
 *
 * Before deploying: wire real tool physics (layers.ts is all stubs) and
 * settle the kernel (see the TODO below).
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Engineer, Reviewer } from "./agents.ts";
import { ResolveGitHubIssue } from "./flywheel.ts";
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
} from "./layers.ts";
import { alchemyEffect } from "./repos.ts";

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
// ApproveHumanLive makes the org an orchestra; an auto-approve Layer
// would make it a factory. Merging stays fenced regardless:
// MergePullRequest refuses without an approved review, and Approve
// lives only in the Reviewer's template.
const ReviewerLive = AI.layer(Reviewer).pipe(
  Layer.provide([ApproveHumanLive, CommentLive]),
);

// ─── the one Process over its agents ─────────────────────────────
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
  // term is provided — exhaustion stays a typed BudgetExceeded exit.
  // Future: a per-dispatch override for one-off tighter/looser runs.
  Layer.provide(
    AI.budget({ tokens: "10M", wallClock: "72h", iterations: 24, stall: 4 }),
  ),
);

// TODO(deploy): which kernel Layer to provide is deliberately open until
// deploy. The in-memory kernel below keeps the graph closed for
// type-checking, but it holds no durable state — the real deployment
// wants a durable Cloudflare kernel (a Ring Durable Object owning the
// admission ledger + Trace) before webhooks are pointed at this Worker.
const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layer({
      apiKey:
        // TODO(sam): use effect/Config
        process.env.ANTHROPIC_API_KEY === undefined
          ? undefined
          : Redacted.make(process.env.ANTHROPIC_API_KEY),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);
const KernelLive = AI.memory.pipe(Layer.provide(ModelLive));

// ─── the org: the ring + its derived front door ──────────────────

const OrgLive = GitHub.frontDoor(ResolveGitHubIssue).pipe(
  Layer.provideMerge(ResolveGitHubIssueLive),
  Layer.provide(GitHub.GitHubEventsLive),
  Layer.provide(KernelLive),
);

export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
  "AlchemyOrg",
  { main: import.meta.url },
  Effect.gen(function* () {
    // resolving the ring from context proves the whole graph closed:
    // every agent, tool, the channel, the kernel, and the front door
    // found a Layer
    const issues = yield* ResolveGitHubIssue;

    // the exported resource resolved to its plain { owner, repository }
    // in init — the same one resolver the front door and channel Layer
    // use (the deferred form is legal here: init runs at plan time
    // under the Stack)
    const repoRef = yield* GitHub.resolveRepositoryRef(alchemyEffect);

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

        return HttpServerResponse.text("alchemy-org", { status: 200 });
      }),
    };
  }).pipe(
    Effect.provide(
      OrgLive.pipe(
        // the wire: provisions the repository webhook pointing at this
        // Worker and claims the delivery path — ONE instance shared by the
        // channel Layer (through OrgLive's open requirement) and the front
        // door's derived consuming call sites
        Layer.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),
      ),
    ),
  ),
) {}
