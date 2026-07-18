/**
 * The factory on Cloudflare — the DEPLOYABLE SHAPE, not deployed yet.
 * Same Factory as local.ts; the environment is this provide-list:
 *
 * | seam                        | Cloudflare physics                       |
 * |-----------------------------|------------------------------------------|
 * | GitHub.RepositoryEventSource| webhook (provisioned + HMAC-verified)     |
 * | Ledger                      | D1 (`org-ledger`, declared by D1Ledger)   |
 * | AI.Kernel                   | TODO(deploy) — see the OrgRing note below |
 * | Engineer workspace tools    | TODO(deploy) — DevBox container (Phase 3) |
 *
 * TODO(deploy) — the kernel slot: `AI.memory` below keeps the Layer
 * graph closed so this file type-checks as the deployable shape, but
 * model turns MUST NOT run in the stateless Worker. The real physics is
 * `CloudflareKernelLive(OrgRing)`: interpret-by-ROUTING — `send`/`steer`
 * admit into the term's Durable Object, and the DO hosts the execution
 * stack (the same terms + agents + model, composed a second time on the
 * DO class), giving per-key serialization for free. The Phase-3 harness
 * owns it; the sketch:
 *
 * ```ts
 * export class OrgRing extends Cloudflare.DurableObject<OrgRing>()("OrgRing",
 *   Effect.gen(function* () {
 *     const kernel = yield* AI.Kernel;          // the DO-side driver
 *     return { admit: (delivery) => kernel.route(delivery) };
 *   }).pipe(Effect.provide(ExecutionStack)),    // terms + EngineerCloudflare +
 * ) {}                                          // ReviewerCloudflare + model
 * ```
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
import { Factory } from "./factory.ts";
import {
  ApproveConsole,
  CommentLive,
  MergePullRequestLive,
  OpenPullRequestLive,
  SearchIssuesLive,
} from "./github-tools.ts";
import { GitHubIssues } from "./issues.ts";
import { D1Ledger } from "./ledger.ts";
import { GitHubPullRequests } from "./pull-requests.ts";
import { Bash, EditFile, Grep, ReadFile } from "./tools.ts";

// ─── workspace tools: TODO(deploy) — the DevBox container ──────────

const todo = (what: string) => () =>
  Effect.die(new Error(`TODO(deploy): ${what}`));

const DevBoxTools = Layer.mergeAll(
  Layer.succeed(Bash, todo("exec in the DevBox container") as never),
  Layer.succeed(Grep, todo("ripgrep in the DevBox container") as never),
  Layer.succeed(ReadFile, todo("read from the DevBox checkout") as never),
  Layer.succeed(EditFile, todo("edit in the DevBox checkout") as never),
);

// ─── model + kernel (the TODO(deploy) slot — see the module JSDoc) ─

const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layer({
      apiKey:
        process.env.ANTHROPIC_API_KEY === undefined
          ? undefined
          : Redacted.make(process.env.ANTHROPIC_API_KEY),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

// TODO(deploy): replace with CloudflareKernelLive(OrgRing) — execution
// belongs in the OrgRing DO (Phase-3 harness), never this Worker.
// AI.memory names its own components (ask hub, event bus) explicitly.
const KernelLive = AI.memory.pipe(Layer.provide(ModelLive));

// ─── credentials + tools ───────────────────────────────────────────

// the GitHub API bindings' Cloudflare physics: the *Http layers capture
// the provider credential as ONE GitHub.PersonalAccessToken resource
// per host and bind its value into the Worker — the deployed runtime
// authenticates with the bound token. NO credentials layer here: the
// token resource's provider gets them from the Stack's
// `GitHub.providers()` (auth provider: env, stored PAT, `gh` CLI), and
// the runtime reads the BOUND token (local.ts provides the *Local
// layers off ambient credentials instead).
const GitHubApi = Layer.mergeAll(
  GitHub.ListIssuesHttp,
  GitHub.GetIssueHttp,
  GitHub.SearchIssuesHttp,
  GitHub.CreateIssueCommentHttp,
  GitHub.ListPullRequestsHttp,
  GitHub.ListPullRequestReviewsHttp,
  GitHub.MergePullRequestHttp,
);

const GitHubToolsLive = Layer.mergeAll(
  SearchIssuesLive,
  CommentLive,
  MergePullRequestLive,
  OpenPullRequestLive,
).pipe(Layer.provide(GitHubApi));

const EngineerCloudflare = AI.layer(Engineer).pipe(
  Layer.provide([DevBoxTools, GitHubToolsLive, KernelLive]),
);
const ReviewerCloudflare = AI.layer(Reviewer).pipe(
  Layer.provide([ApproveConsole, GitHubToolsLive, KernelLive]),
);

// ─── the environment: one provide-list ─────────────────────────────

const FactoryCloudflare = Factory.pipe(
  Layer.provide([EngineerCloudflare, ReviewerCloudflare]), // ← agents
  Layer.provide(GitHubToolsLive), // ← the processes' own tools
  Layer.provide(GitHubApi), // ← the domain methods' API bindings
  // ← the wire: provisions the repository webhook pointing at this
  //   Worker and claims + verifies the delivery path
  Layer.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),
  // ← the ledger declares its own D1 database; the binding gives it
  //   the runtime client
  Layer.provide(D1Ledger.pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding))),
  Layer.provideMerge(KernelLive),
);

export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
  "Org",
  { main: import.meta.url },
  Effect.gen(function* () {
    // resolving both tags from context proves the whole graph closed:
    // processes, agents, tools, channel, ledger, kernel, and the wire
    // all found a Layer
    const issues = yield* GitHubIssues;
    const pulls = yield* GitHubPullRequests;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://org");

        // GitHub webhook deliveries never reach this handler — the
        // GitHubRepositoryEventSourceLive listener claims them first,
        // and the drive loops in issues.ts/pull-requests.ts route them.

        if (request.method === "GET" && url.pathname === "/issues") {
          // the declared interface, through the tag — typed end to end
          return yield* HttpServerResponse.json(yield* issues.listIssues());
        }

        if (request.method === "GET" && url.pathname === "/status") {
          const openPulls = yield* pulls.listOpen();
          return yield* HttpServerResponse.json({
            factory: "alchemy-org",
            repository: "alchemy-run/test-alchemy",
            processes: ["GitHubIssues", "GitHubPullRequests"],
            openPullRequests: openPulls.length,
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
    // ONE provide (owner convention): the environment was built above
    // with Layer combinators — never chain Effect.provide calls.
  }).pipe(Effect.provide(FactoryCloudflare)),
) {}
