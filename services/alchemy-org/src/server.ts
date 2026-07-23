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
 * inside the detached process. Deploying needs no API keys; running
 * needs `GITHUB_ACCESS_TOKEN` (or `GITHUB_TOKEN`) and
 * `ANTHROPIC_API_KEY` in the operator's environment (the reconciler
 * passes the shell env through).
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Server from "alchemy/Server";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { CodingLocal } from "./coding.ts";
import { EngineerLive } from "./engineer.ts";
import { Factory, FactoryLive, type FactoryService } from "./factory.ts";
import { Issues, IssuesLive, type IssuesService } from "./issues.ts";
import { SqliteLedger } from "./ledger.ts";
import { LiveTestingLive } from "./live-testing.ts";
import {
  PullRequests,
  PullRequestsLive,
  type PullRequestsService,
} from "./pull-requests.ts";
import { ReconcilingLive } from "./reconciling.ts";
import { ResourceEngineerLive } from "./resource-engineer.ts";
import { ReviewerLive } from "./reviewer.ts";
import { TypedErrorsLive } from "./typed-errors.ts";
import { ApprovalsLive } from "./approvals.ts";
import { ToolOutputStoreLive } from "./internal/ToolOutputStore.ts";
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
import { workspace } from "./workspace.ts";

// ─── the physics (local) ─────────────────────────────────────────────

/** GitHub REST credentials from the operator's shell env. */
const Credentials = GitHub.fromEnv();

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
 * The checkout the org works in — a CLONE of test-alchemy,
 * self-provisioned at boot (see `ensureWorkspace`). `ORG_WORKSPACE`
 * overrides the location.
 */
const workspaceRoot =
  process.env.ORG_WORKSPACE ??
  `${process.cwd()}/.alchemy/workspaces/test-alchemy`;

const OrgWorkspace = workspace(workspaceRoot);

/**
 * Boot step, BEFORE the org's Layer graph builds (the Workspace layer
 * realpaths its root): clone test-alchemy if missing (the clone URL
 * carries the token, so pushes work), and seed `main` if the repo is
 * empty (PRs need a base branch).
 */
const ensureWorkspace = Effect.promise(async () => {
  const fs = await import("node:fs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", args)).stdout.trim();

  if (!fs.existsSync(workspaceRoot)) {
    const token =
      process.env.GITHUB_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
    await git(
      "clone",
      `https://x-access-token:${token}@github.com/alchemy-run/test-alchemy.git`,
      workspaceRoot,
    );
  }
  try {
    await git("-C", workspaceRoot, "rev-parse", "--verify", "origin/main");
  } catch {
    // empty repository: seed main so pull requests have a base
    await git("-C", workspaceRoot, "checkout", "-B", "main");
    fs.writeFileSync(
      `${workspaceRoot}/README.md`,
      "# test-alchemy\n\nSandbox repository managed by the alchemy-org software factory.\n",
    );
    await git("-C", workspaceRoot, "add", "-A");
    await git(
      "-C",
      workspaceRoot,
      "-c",
      "user.name=alchemy-org[bot]",
      "-c",
      "user.email=bot@alchemy.run",
      "commit",
      "-m",
      "chore: seed main",
    );
    await git("-C", workspaceRoot, "push", "-u", "origin", "main");
  }
});

// ─── the org: agents, then processes ────────────────────────────────

/** The Engineer: local toolbox physics + real PR plumbing (branch,
 * commit, push, pulls.create) over the workspace clone. */
const EngineerLayer = EngineerLive.pipe(
  Layer.provide(CodingLocal),
  Layer.provide(OpenPullRequestLive.pipe(Layer.provide(ToolOutputStoreLive))),
  Layer.provide(Kernel),
  Layer.provide(OrgWorkspace),
);

/** The Reviewer: reads the diff, records its verdict in the approvals
 * ledger (visible as a PR comment) — the merge tool ratifies against it. */
const ReviewerLayer = ReviewerLive.pipe(
  Layer.provide(Layer.mergeAll(ApproveRecorded, CommentLive, ReadDiffLive)),
  Layer.provide(Kernel),
);

/**
 * The ResourceEngineer: the factory's per-service laborer. The ONE
 * physics bundle is the generic ${Coding} toolbox; the doctrines
 * (typed errors, reconciling, live testing) are PROSE-ONLY skills —
 * knowledge, not tools. NOTE: the factory operates on the checkout
 * at ORG_WORKSPACE — point it at an alchemy repo root (with the
 * distilled submodule), not at services/alchemy-org.
 */
const ResourceEngineerLayer = ResourceEngineerLive.pipe(
  Layer.provide(
    Layer.mergeAll(CodingLocal, TypedErrorsLive, ReconcilingLive, LiveTestingLive),
  ),
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
  Layer.provide(Layer.mergeAll(EngineerLayer, ReviewerLayer)),
  Layer.provide(
    Layer.mergeAll(
      CommentLive,
      SearchIssuesLive,
      LinkIssuesLive,
      CloseIssueLive,
      MergePullRequestLive,
    ),
  ),
  Layer.provide(Kernel),
  Layer.provide(SqliteLedger(".alchemy/org-ledger.sqlite")),
  Layer.provide(GitHub.RepositoryEventSourcePolling({ every: "30 seconds" })),
  // ONE approvals ledger, shared by the Reviewer's Approve and the
  // PullRequests desk's merge ratification (memoized by reference)
  Layer.provideMerge(ApprovalsLive),
  Layer.provide(GitHubBindings),
  Layer.provide(Credentials),
);

// ─── the service ─────────────────────────────────────────────────────

interface OrgHandles {
  readonly issues?: IssuesService;
  readonly pullRequests?: PullRequestsService;
  readonly factory?: FactoryService;
}

export default class AlchemyOrg extends Server.Service<AlchemyOrg>()(
  "AlchemyOrg",
  {
    // no port pinned: the runtime binds an ephemeral one and reports it
    // back through the startup handshake — it lands in the `url` output
    main: import.meta.url,
    memo: { include: ["src/**"] },
  },
  Effect.gen(function* () {
    const host = yield* Server.ServerHost;
    const org = yield* Ref.make<OrgHandles>({});

    // The org IS the background program. `host.run` only registers it:
    // nothing here executes at plan; the detached process builds the
    // Layer graph once at startup and holds its scope open forever.
    yield* host.run(
      // the workspace clone must exist BEFORE the Layer graph builds
      // (the Workspace layer realpaths its root)
      ensureWorkspace.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const issues = yield* Issues;
            const pullRequests = yield* PullRequests;
            const factory = yield* Factory;
            yield* Ref.set(org, { issues, pullRequests, factory });
            yield* Effect.log(
              "alchemy-org is watching test-alchemy (polling every 30s)",
            );
            yield* Effect.never; // the processes live in this scope
          }).pipe(Effect.provide(OrgLive), Effect.scoped),
        ),
        Effect.orDie,
      ),
    );

    return {
      // localhost surface: the desks' sealed Shapes — read-only status,
      // plus the factory's one door (`POST /factory/wave`)
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const handles = yield* Ref.get(org);
        if (!handles.issues || !handles.pullRequests || !handles.factory) {
          return yield* HttpServerResponse.json(
            { phase: "starting" },
            { status: 503 },
          );
        }

        // the factory's door: start a wave, respond immediately — the
        // order book is where outcomes land as engineers file reports
        if (request.method === "POST" && request.url.startsWith("/factory/wave")) {
          const body = (yield* request.json.pipe(Effect.orDie)) as {
            services: string[];
            concurrency?: number;
          };
          yield* Effect.forkDetach(
            handles.factory
              .wave(body.services, { concurrency: body.concurrency })
              .pipe(Effect.provide(RuntimeContext.phantom)),
          );
          return yield* HttpServerResponse.json(
            { started: body.services },
            { status: 202 },
          );
        }

        const status = yield* Effect.all({
          issues: handles.issues.list(),
          pullRequests: handles.pullRequests.list(),
          factory: handles.factory.orderBook(),
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
) {}
