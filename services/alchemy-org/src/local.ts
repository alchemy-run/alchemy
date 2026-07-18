/**
 * The factory on a laptop — `bun run src/local.ts`.
 *
 * Same Factory as the Worker; the environment is this provide-list:
 *
 * | seam                        | local physics                          |
 * |-----------------------------|----------------------------------------|
 * | GitHub.RepositoryEventSource| polling (Octokit + cursors, 30s)       |
 * | Ledger                      | sqlite (`factory.db` — restart-resume) |
 * | AI.Kernel                   | AI.memory (executes in-process)        |
 * | Engineer / Reviewer tools   | local toolbox + Octokit + console gate |
 *
 * Required env: ANTHROPIC_API_KEY, and GITHUB_TOKEN or
 * GITHUB_ACCESS_TOKEN. Optional: FACTORY_WORKSPACE (the Engineer's
 * checkout; defaults to `.factory-workspace`).
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as AI from "alchemy/AI";
import * as Auth from "alchemy/Auth";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
import { SqliteLedger } from "./ledger.ts";
import { GitHubPullRequests } from "./pull-requests.ts";
import { localCodingTools } from "./toolbox.ts";

// ─── physics ───────────────────────────────────────────────────────

const Platform = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide([BunFileSystem.layer, Path.layer]),
  ),
);

// env-gated in preflight below — a missing key never gets this far
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

// AI.memory is the reference kernel ASSEMBLY — it names its own
// components (ask hub, event bus) explicitly. The factory adds none:
// its exits are all world-owned and settle through the drive loops.
const KernelLive = AI.memory.pipe(Layer.provide(ModelLive));

// the provider's credential chain — the SAME resolution the Stack's
// `GitHub.providers()` uses (`alchemy login` profile: env, stored PAT,
// `gh` CLI), never a hand-rolled env read. The registry starts empty
// (the same base the CLI/Test runtimes provide); GitHubAuth registers
// into it, and the store/profile/gh-CLI need the platform layers.
const Credentials = GitHub.fromAuthProvider().pipe(
  Layer.provide(GitHub.Auth.GitHubAuth),
  Layer.provide(Layer.succeed(Auth.AuthProviders, {})),
  Layer.provide([Auth.ProfileLive, Auth.CredentialsStoreLive]),
  Layer.provide(Platform),
);

// the GitHub API bindings' LOCAL physics: the provider's credentials,
// no token resource, no bind (the Worker uses the *Http layers, which
// capture the credential as a GitHub.PersonalAccessToken bound into
// the host). Everything that talks to GitHub (tool layers, the
// processes' domain methods) consumes the binding TAGS; this is where
// they get physics.
const GitHubApi = Layer.mergeAll(
  GitHub.ListIssuesLocal,
  GitHub.GetIssueLocal,
  GitHub.SearchIssuesLocal,
  GitHub.CreateIssueCommentLocal,
  GitHub.ListPullRequestsLocal,
  GitHub.ListPullRequestReviewsLocal,
  GitHub.MergePullRequestLocal,
).pipe(Layer.provide(Credentials));

const GitHubToolsLive = Layer.mergeAll(
  SearchIssuesLive,
  CommentLive,
  MergePullRequestLive,
  OpenPullRequestLive,
).pipe(Layer.provide(GitHubApi));

// TODO(workspace): default should become a fresh temp CLONE of
// test-alchemy (the Workspace component); until then point
// FACTORY_WORKSPACE at a checkout you own.
const workspace = process.env.FACTORY_WORKSPACE ?? ".factory-workspace";
const WorkspaceTools = localCodingTools(workspace).pipe(
  Layer.provide(Platform),
);

// ─── agents: same contracts, LOCAL tool physics ────────────────────

export const EngineerLocal = AI.layer(Engineer).pipe(
  Layer.provide([WorkspaceTools, GitHubToolsLive, KernelLive]),
);

// the Reviewer holds the org's only ${Approve} — locally the gate is
// the (loud, auto-approving) console; swapping in a human surface is a
// one-Layer change here, never a charter edit
export const ReviewerLocal = AI.layer(Reviewer).pipe(
  Layer.provide([ApproveConsole, GitHubToolsLive, KernelLive]),
);

// ─── the environment: one provide-list ─────────────────────────────

export const FactoryLocal = Factory.pipe(
  Layer.provide([EngineerLocal, ReviewerLocal]), // ← agents
  Layer.provide(GitHubToolsLive), // ← the processes' own tools
  Layer.provide(GitHubApi), // ← the domain methods' API bindings
  Layer.provide(GitHub.RepositoryEventSourcePolling({ every: "30 seconds" })), // ← poll
  Layer.provide(SqliteLedger("factory.db")), // ← restart-resume
  Layer.provideMerge(KernelLive), // ← kernel (exposed: the events tail below)
  Layer.provide(Credentials),
);

// ─── main ──────────────────────────────────────────────────────────

// GitHub credentials are NOT env-checked here: the auth provider chain
// resolves them (gh CLI, stored PAT via `alchemy login`, or env) and
// fails with its own actionable message if nothing is configured.
const preflight = Effect.gen(function* () {
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    yield* Effect.logError(
      "the factory needs credentials to run:\n" +
        "  ANTHROPIC_API_KEY        — model turns (the kernel)\n" +
        "optional:\n  FACTORY_WORKSPACE        — the Engineer's checkout (default: .factory-workspace)",
    );
    return yield* Effect.sync(() => process.exit(1));
  }
});

const main = Effect.gen(function* () {
  yield* preflight;

  yield* Effect.gen(function* () {
    const issues = yield* GitHubIssues;
    const pulls = yield* GitHubPullRequests;
    const kernel = yield* AI.Kernel;

    const open = yield* issues.listIssues();
    const openPulls = yield* pulls.listOpen();
    yield* Effect.log(
      `factory online — polling alchemy-run/test-alchemy every 30 seconds ` +
        `(${open.length} open issues, ${openPulls.length} open PRs; ledger: factory.db)`,
    );

    // the live firehose to stdout: admissions, turns, parks, settles
    yield* Effect.forkScoped(
      Stream.runForEach(kernel.events, (event) =>
        Effect.log(
          `[kernel] ${event.type} ring=${event.ring.join("/")}` +
            (event.session === undefined ? "" : ` session=${event.session}`),
        ),
      ),
    );

    // the ring serves admissions until this Scope closes — i.e. forever
    yield* Effect.never;
  }).pipe(
    // ONE provide (owner convention): the environment was built above
    // with Layer combinators — never chain Effect.provide calls
    Effect.provide(FactoryLocal),
    Effect.scoped,
  );
});

if (import.meta.main) {
  BunRuntime.runMain(main);
}
