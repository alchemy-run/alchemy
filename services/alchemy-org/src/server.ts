/**
 * The org, running on your machine — an Effectful {@link Server.Service}
 * hosting the factory's processes as a detached local process.
 *
 * The COMPOSITION is the whole file: the same charters, tools, skills,
 * and processes that will one day run on a Cloudflare Worker are wired
 * here to LOCAL physics — Anthropic over HTTP, GitHub REST polling for
 * events, bun:sqlite for the Ledger, the local FileSystem/shell for the
 * Coding skill. Swapping environments is swapping this provide-list.
 *
 * Phases: the constructor runs at PLAN time too (to collect bindings),
 * so the org's Layer graph is deliberately built inside `host.run` —
 * the host only STORES that program at plan; it executes at runtime,
 * inside the detached process. GitHub credentials resolve from the
 * ALCHEMY PROFILE (the GitHub AuthProvider — `alchemy login`); running
 * additionally needs `ANTHROPIC_API_KEY` in the operator's environment
 * (the reconciler passes the shell env through).
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import * as AI from "alchemy/AI";
import * as Auth from "alchemy/Auth";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Server from "alchemy/Server";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApprovalsLive } from "./approvals.ts";
import { CodingLocal } from "./coding.ts";
import { EngineerLive } from "./engineer.ts";
import { Factory, FactoryLive } from "./factory.ts";
import { ToolOutputStoreLive } from "./internal/ToolOutputStore.ts";
import { Issues, IssuesLive } from "./issues.ts";
import { SqliteLedger } from "./ledger.ts";
import { LiveTestingLive } from "./live-testing.ts";
import { PullRequests, PullRequestsLive } from "./pull-requests.ts";
import { ReconcilingLive } from "./reconciling.ts";
import { ResourceEngineerLive } from "./resource-engineer.ts";
import { ReviewerLive } from "./reviewer.ts";
import {
  ApproveRecorded,
  CloseIssueLive,
  CommentLive,
  LinkIssuesLive,
  MergePullRequestLive,
  OpenPullRequestLive,
  ReadDiffLive,
  SearchIssuesLive,
} from "./tools/index.ts";
import { TypedErrorsLive } from "./typed-errors.ts";
import { fixed as workspace, perRun as runWorkspace } from "alchemy/Workspace";

// ─── the physics (local) ─────────────────────────────────────────────

/**
 * GitHub REST credentials from the ALCHEMY PROFILE via the GitHub
 * AuthProvider — the same chain `GitHub.providers()` and `alchemy
 * login` use (`ALCHEMY_PROFILE` selects; no shell env token needed).
 */
/**
 * The AuthProviders registry, WITH GitHub registered: the CLI provides
 * this for commands; a standalone runtime brings its own. `fresh`
 * matters: the registration layer is memoized by REFERENCE, and at
 * plan time the CLI's own graph already built it against the CLI's
 * registry — without `fresh`, ours would stay empty.
 */
const AuthRegistry = Layer.fresh(GitHub.Auth.GitHubAuth).pipe(
  Layer.provideMerge(Layer.succeed(Auth.AuthProviders, {})),
);

const Credentials = GitHub.fromAuthProvider().pipe(
  Layer.provide(AuthRegistry),
  Layer.provide(Auth.ProfileLive),
  Layer.provide(Auth.CredentialsStoreLive),
);

/**
 * The GitHub capability bindings, LOCAL flavor: straight Octokit calls
 * with the env token (the `*Http` flavors — worker-scoped tokens — slot
 * in unchanged on Cloudflare).
 */
const GitHubBindings = Layer.mergeAll(
  GitHub.CreateIssueCommentLocal,
  GitHub.CreatePullRequestLocal,
  GitHub.GetIssueLocal,
  GitHub.GetPullRequestLocal,
  GitHub.ListIssuesLocal,
  GitHub.ListPullRequestReviewsLocal,
  GitHub.ListPullRequestsLocal,
  GitHub.MergePullRequestLocal,
  GitHub.SearchIssuesLocal,
).pipe(Layer.provide(Credentials));

/**
 * The model: Anthropic over HTTP; the key is read at RUNTIME. (The
 * kernel annotates every compiled tool `Strict: false` — Anthropic's
 * strict tool-calling grammar caps union-typed parameters per request
 * and a real toolkit cannot fit; see KernelMemory.compileTool.)
 */
const Model = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

const Kernel = AI.KernelMemory.pipe(Layer.provide(Model));

/**
 * The workspaces ROOT — one directory holds the central clones and the
 * per-run worktrees (`Git.WorkspacesWorktree` populates it), and the
 * SAME directory is the toolbox's containment root: each run's tree is
 * a subdirectory the coding tools can reach but not escape.
 * `ORG_WORKSPACE` overrides the location.
 */
const workspaceRoot =
  process.env.ORG_WORKSPACE ?? `${process.cwd()}/.alchemy/workspaces`;

const OrgWorkspace = workspace(workspaceRoot);

/**
 * Checkouts as a capability, LOCAL physics: central blobless clone +
 * one worktree per run key. ONE instance — the Engineer's turn and the
 * OpenPullRequest handler must share the checkout cache (same const,
 * memoized by reference in the Layer graph).
 */
const WorkspacesLive = Git.WorkspacesWorktree({ root: workspaceRoot }).pipe(
  Layer.provide(GitHub.GitCredentials),
  Layer.provide(Credentials),
);

// ─── the org: agents, then processes ────────────────────────────────

/** The Engineer: local toolbox physics + real PR plumbing (branch,
 * commit, push, pulls.create). The toolbox is rooted at THE RUN'S OWN
 * worktree (`runWorkspace`), so an engineer cannot touch another run's
 * tree — or anything outside its checkout. */
const EngineerLayer = EngineerLive.pipe(
  Layer.provide(CodingLocal),
  Layer.provide(OpenPullRequestLive.pipe(Layer.provide(ToolOutputStoreLive))),
  Layer.provide(Kernel),
  Layer.provide(runWorkspace()),
  // one shared instance: init's checkout, the toolbox root, and the
  // PR tool all read the same cache, so they land in the same worktree
  Layer.provide(WorkspacesLive),
);

/** The Reviewer: reads the diff, records its verdict in the approvals
 * ledger (visible as a PR comment) — the merge tool ratifies against it. */
const ReviewerLayer = ReviewerLive.pipe(
  Layer.provide([ApproveRecorded, CommentLive, ReadDiffLive]),
  Layer.provide(Kernel),
);

/**
 * The ResourceEngineer: the factory's per-service laborer. The ONE
 * physics bundle is the generic ${Coding} toolbox; the doctrines
 * (typed errors, reconciling, live testing) are PROSE-ONLY skills —
 * knowledge, not tools. NOTE: the factory works under the workspaces
 * root at ORG_WORKSPACE — an alchemy checkout (with the distilled
 * submodule) must live inside it for waves to operate on.
 */
const ResourceEngineerLayer = ResourceEngineerLive.pipe(
  Layer.provide([
    CodingLocal,
    TypedErrorsLive,
    ReconcilingLive,
    LiveTestingLive,
  ]),
  Layer.provide(Kernel),
  Layer.provide(OrgWorkspace),
);

/** The Factory desk: waves of per-service engineers, banked reports. */
const FactoryLayer = FactoryLive.pipe(Layer.provide(ResourceEngineerLayer));

/**
 * The processes over their world: GitHub events arrive by REST polling
 * (the webhook Layer slots in unchanged on Cloudflare); the Ledger is
 * bun:sqlite so delivery dedupe survives restarts.
 */
export const OrgLive = Layer.mergeAll(
  IssuesLive,
  PullRequestsLive,
  FactoryLayer,
).pipe(
  Layer.provide([EngineerLayer, ReviewerLayer]),
  Layer.provide([
    CommentLive,
    SearchIssuesLive,
    LinkIssuesLive,
    CloseIssueLive,
    MergePullRequestLive,
  ]),
  Layer.provide(Kernel),
  Layer.provide(SqliteLedger(".alchemy/org-ledger.sqlite")),
  // 3s local poll — the floor: each cycle is 3 REST calls (issues +
  // comments + PRs), ~3.6k req/hr against GitHub's 5k budget. This is
  // the one architectural latency left (~2×3s per issue→merge loop);
  // webhooks on Cloudflare make delivery push and remove it entirely.
  Layer.provide(GitHub.RepositoryEventSourcePolling({ every: "3 seconds" })),
  // ONE approvals ledger, shared by the Reviewer's Approve and the
  // PullRequests desk's merge ratification (memoized by reference)
  Layer.provideMerge(ApprovalsLive),
  Layer.provide(GitHubBindings),
  Layer.provide(Credentials),
  Layer.orDie,
);

// ─── the service ─────────────────────────────────────────────────────

export default class AlchemyOrg extends Server.Service<AlchemyOrg>()(
  "AlchemyOrg",
  {
    // no port pinned: the runtime binds an ephemeral one and reports it
    // back through the startup handshake — it lands in the `url` output
    main: import.meta.url,
    memo: { include: ["src/**"] },
  },
  Effect.gen(function* () {
    // the desks are BINDINGS: resolved at init, closed over by fetch
    const issues = yield* Issues;
    const pullRequests = yield* PullRequests;
    const factory = yield* Factory;

    return {
      // localhost surface: the desks' sealed Shapes — read-only status,
      // plus the factory's one door (`POST /factory/wave`)
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        // the factory's door: start a wave, respond immediately — the
        // order book is where outcomes land as engineers file reports
        if (
          request.method === "POST" &&
          request.url.startsWith("/factory/wave")
        ) {
          const body = (yield* request.json.pipe(Effect.orDie)) as {
            services: string[];
            concurrency?: number;
          };
          yield* Effect.forkDetach(
            factory
              .wave(body.services, { concurrency: body.concurrency })
              .pipe(Effect.provide(RuntimeContext.phantom)),
          );
          return yield* HttpServerResponse.json(
            { started: body.services },
            { status: 202 },
          );
        }

        const status = yield* Effect.all({
          issues: issues.list(),
          pullRequests: pullRequests.list(),
          factory: factory.orderBook(),
        }).pipe(
          Effect.map(({ issues, pullRequests, factory }) => ({
            phase: "running",
            openIssues: issues.map((issue) => ({
              number: issue.number,
              title: issue.title,
            })),
            openPullRequests: pullRequests.map((pull) => ({
              number: pull.number,
              title: pull.title,
            })),
            factory,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              phase: "degraded",
              error: String(error),
            } as const),
          ),
        );
        return yield* HttpServerResponse.json(status);
      }),
    };
  }),
  // the org's machinery as the constructor's LAYERS: built with instance
  // lifetime, so the background fibers (GitHub pollers, kernel actor
  // loops) live until the process is killed — an `Effect.provide` here
  // would tear them down the moment init returns its handlers
  OrgLive,
) {}
