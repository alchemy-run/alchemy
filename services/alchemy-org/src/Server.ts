/**
 * The org, running on your machine — an Effectful {@link Local.Service}
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
import * as Local from "alchemy/Local";
import { perRun as runWorkspace } from "alchemy/Workspace";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Approvals, ApprovalsLive } from "./Approvals.ts";
import { buildBoard } from "./Board.ts";
import { SqliteLedger } from "./Ledger.ts";
import { testAlchemy } from "./Repos.ts";
import { ReviewerLive } from "./agents/Reviewer.ts";
import { ToolOutputStoreLive } from "./lib/ToolOutputStore.ts";
import { IssueEngineer, Issues, IssuesLive } from "./processes/Issues.ts";
import { PullRequests, PullRequestsLive } from "./processes/PullRequests.ts";
import { CodingLocal } from "./skills/Coding.ts";
import { LiveTestingLive } from "./skills/LiveTesting.ts";
import { QualityAssuranceLocal } from "./skills/QualityAssurance.ts";
import { ResourceEngineeringLive } from "./skills/ResourceEngineering.ts";
import { TypedErrorsLive } from "./skills/TypedErrors.ts";
import {
  ApproveRecorded,
  ApproveRequested,
  CloseIssueLive,
  CommentLive,
  LinkIssuesLive,
  MergePullRequestLive,
  OpenPullRequestLive,
  ReadDiffLive,
  ReadIssueLive,
  SearchIssuesLive,
} from "./tools/index.ts";

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
  GitHub.UpdateIssueLocal,
).pipe(Layer.provide(Credentials));

/**
 * The model: Anthropic over HTTP; the key is read at RUNTIME. (The
 * kernel annotates every compiled tool `Strict: false` — Anthropic's
 * strict tool-calling grammar caps union-typed parameters per request
 * and a real toolkit cannot fit; see KernelMemory.compileTool.)
 */
const Model = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
  config: {
    // extended thinking: the traces stream to the UI as reasoning
    // deltas and land on the transcript as reasoning parts
    thinking: { type: "enabled", budget_tokens: 4096 },
    max_tokens: 16384,
  },
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

/**
 * The kernel, with the OBSERVABILITY seam attached: every agent layer
 * that provides this bundle interprets its runs with the org's chat
 * projection listening (designs/ai/streaming.md). ONE Chats instance —
 * the same const is provideMerge'd into OrgLive for the HTTP surface.
 */
const OrgChats = AI.ChatsMemory();

const Kernel = Layer.mergeAll(
  AI.KernelMemory.pipe(Layer.provide(Model)),
  AI.ChatsObserver.pipe(Layer.provide(OrgChats)),
);

/**
 * The workspaces ROOT — one directory holds the central clones and the
 * per-run worktrees (`Git.WorkspacesWorktree` populates it), and the
 * SAME directory is the toolbox's containment root: each run's tree is
 * a subdirectory the coding tools can reach but not escape.
 * `ORG_WORKSPACE` overrides the location.
 */
const workspaceRoot =
  process.env.ORG_WORKSPACE ?? `${process.cwd()}/.alchemy/workspaces`;

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
 * tree — or anything outside its checkout. The doctrine skills form a
 * TREE (the skill graph): Coding exposes ResourceEngineering, whose
 * teaching exposes TypedErrors and LiveTesting — each level provided
 * as OUTPUTS (provideMerge) so the kernel resolves them at activation. */
const EngineerLayer = IssueEngineer.pipe(
  Layer.provide(
    CodingLocal.pipe(
      Layer.provideMerge(
        ResourceEngineeringLive.pipe(
          Layer.provideMerge([TypedErrorsLive, LiveTestingLive]),
        ),
      ),
    ),
  ),
  Layer.provide(OpenPullRequestLive.pipe(Layer.provide(ToolOutputStoreLive))),
  Layer.provide(Kernel),
  Layer.provide(runWorkspace({ remote: GitHub.remote(testAlchemy) })),
  // one shared instance: init's checkout, the toolbox root, and the
  // PR tool all read the same cache, so they land in the same worktree
  Layer.provide(WorkspacesLive),
);

/**
 * The AUTONOMY DIAL — which physics answers the Reviewer's `Approve`:
 *
 * - autonomous (default): {@link ApproveRecorded} writes the approvals
 *   ledger; the owner's merge ratifies against it — the factory runs
 *   the whole loop itself.
 * - supervised (`ORG_SUPERVISED=1`): {@link ApproveRequested} posts the
 *   verdict as a RECOMMENDATION and records nothing — the merge tool
 *   then only succeeds on a real APPROVED GitHub review from a human.
 *   Same charters, same tools; the second key of the two-key ceremony
 *   moves to a person purely by composition.
 */
const Approval =
  process.env.ORG_SUPERVISED === "1" ? ApproveRequested : ApproveRecorded;

/** The Reviewer worker: reads the diff + the cited issue, verifies in
 * the ISSUE'S OWN checkout (the doors key both workers by the issue,
 * so this is the exact tree the engineer built in — read and run, no
 * editor), records its verdict — the channel's merge ratifies it. */
const ReviewerLayer = ReviewerLive.pipe(
  Layer.provide([Approval, CommentLive, ReadDiffLive, ReadIssueLive]),
  Layer.provide(QualityAssuranceLocal),
  Layer.provide(Kernel),
  Layer.provide(runWorkspace({ remote: GitHub.remote(testAlchemy) })),
  // the SAME instance the Engineer's layer uses — one checkout cache,
  // so the issue key resolves to one shared worktree
  Layer.provide(WorkspacesLive),
);

/**
 * The processes over their world: GitHub events arrive by REST polling
 * (the webhook Layer slots in unchanged on Cloudflare); the Ledger is
 * bun:sqlite so delivery dedupe survives restarts.
 */
export const OrgLive = Layer.mergeAll(IssuesLive, PullRequestsLive).pipe(
  // the owner's workers: the Engineer writes the fix in its own
  // thread; the Reviewer judges the artifact and records its verdict
  // (the SAME reviewer also judges unlinked foreign PRs — the router
  // dispatches it directly and ratifies the merge deterministically)
  Layer.provide([EngineerLayer, ReviewerLayer]),
  Layer.provide([
    CommentLive,
    SearchIssuesLive,
    LinkIssuesLive,
    CloseIssueLive,
    MergePullRequestLive,
    Approval,
    ReadDiffLive,
    ReadIssueLive,
  ]),
  Layer.provide(Kernel),
  Layer.provide(SqliteLedger(".alchemy/org-ledger.sqlite")),
  // 3s local poll — the floor: each cycle is 3 REST calls (issues +
  // comments + PRs), ~3.6k req/hr against GitHub's 5k budget. This is
  // the one architectural latency left (~2×3s per issue→merge loop);
  // webhooks on Cloudflare make delivery push and remove it entirely.
  Layer.provide(GitHub.RepositoryEventSourcePolling({ every: "3 seconds" })),
  // ONE approvals ledger: the desk's Approve records into it and its
  // merge ratifies against it (memoized by reference)
  Layer.provideMerge(ApprovalsLive),
  // the chat projection (same const the Kernel bundle observes into)
  // and the comment binding surface — both consumed by the HTTP edge
  Layer.provideMerge(OrgChats),
  Layer.provideMerge(GitHubBindings),
  Layer.provide(Credentials),
  Layer.orDie,
);

// ─── the service ─────────────────────────────────────────────────────

export default class AlchemyOrg extends Local.Vite<AlchemyOrg>()(
  "AlchemyOrg",
  {
    // no port pinned: the runtime binds an ephemeral one and reports it
    // back through the startup handshake — it lands in the `url` output.
    // The UI (ui/, built by Local.Vite at deploy) is served from the
    // SAME server, so there is no second address to keep in sync.
    main: import.meta.url,
    memo: { include: ["src/**", "ui/**", "vite.config.ts"] },
  },
  Effect.gen(function* () {
    // the desks are BINDINGS: resolved at init, closed over by fetch
    const issues = yield* Issues;
    const pullRequests = yield* PullRequests;
    const chats = yield* AI.Chats;
    const approvals = yield* Approvals;
    // sendMessage's honest door: a chat message to a desk becomes a
    // GitHub comment — the same world event as any other steer
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);

    const sseHeaders = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
      "x-accel-buffering": "no",
    };
    const encoder = new TextEncoder();

    // ── the localhost surface, as HttpRouter routes ─────────────────
    // the desks' sealed Shapes (read-only status) and the chat
    // projection (AI SDK UIMessage protocol)

    const listChats = HttpRouter.add(
      "GET",
      "/api/chats",
      Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* chats.list());
      }),
    );

    // the ISSUE BOARD: every chat grouped under the GitHub issue it
    // serves, via channel keys + kernel dispatch parentage (board.ts)
    const board = HttpRouter.add(
      "GET",
      "/api/board",
      Effect.gen(function* () {
        const [chatList, openIssues] = yield* Effect.all(
          [
            chats.list(),
            issues.list().pipe(
              Effect.map((list) =>
                list.map((issue) => ({
                  number: issue.number,
                  title: issue.title,
                })),
              ),
              // GitHub down ≠ board down: states degrade to "unknown"
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          ] as const,
          { concurrency: 2 },
        );
        return yield* HttpServerResponse.json(buildBoard(chatList, openIssues));
      }),
    );

    const chatMessages = HttpRouter.add(
      "GET",
      "/api/chats/:id/messages",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const id = decodeURIComponent(String(params.id ?? ""));
        // snapshot is kernel vocabulary; the AI SDK shaping is the
        // adapter's (`AI.toUIMessages`)
        const snapshot = yield* chats.snapshot(id);
        return snapshot === undefined
          ? yield* HttpServerResponse.json(
              { error: `unknown chat: ${id}` },
              { status: 404 },
            )
          : yield* HttpServerResponse.json(
              AI.toUIMessages(snapshot.log, snapshot.streaming),
            );
      }),
    );

    const chatStream = HttpRouter.add(
      "POST",
      "/api/chat",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = (yield* request.json.pipe(Effect.orDie)) as {
          id?: string;
          messages?: Array<{
            role?: string;
            parts?: Array<{ type?: string; text?: string }>;
          }>;
        };
        const id = body.id ?? "";
        const [term = "", key = ""] = ((at) =>
          at < 0 ? [] : [id.slice(0, at), id.slice(at + 1)])(id.indexOf(":"));
        const last = body.messages?.at(-1);
        const text =
          last?.role === "user"
            ? (last.parts ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? "")
                .join("\n")
                .trim()
            : "";

        // deliver the text through the WORLD's door: a GitHub comment
        // on the owner's issue (or the desk's PR) steers the run
        // like any other event; chats without a world door are
        // watch-only
        const threadNumber = Number(key.match(/#(\d+)$/)?.[1]);
        if (
          text.length > 0 &&
          term === "IssueOwner" &&
          Number.isFinite(threadNumber)
        ) {
          yield* comment({
            issue_number: threadNumber,
            body: text,
          }).pipe(Effect.orDie);
        }

        // live tail from NOW: the response streams the run's next
        // burst as ONE assistant message (steps per sampling) —
        // designs/ai/streaming.md. Subscription lifetime is the
        // RESPONSE BODY's (Stream.ensuring), never the request scope.
        const { queue, unsubscribe } = yield* chats.subscribe(
          id,
          Number.MAX_SAFE_INTEGER,
        );
        const translate = AI.makeChunkTranslator();
        const DONE = "__done__";
        const stream = Stream.fromQueue(queue).pipe(
          Stream.flatMap((observation: AI.KernelObservation) => {
            const { chunks, done } = translate(observation);
            const lines = chunks.map(
              (chunk) => `data: ${JSON.stringify(chunk)}\n\n`,
            );
            return Stream.fromArray(done ? [...lines, DONE] : lines);
          }),
          Stream.takeWhile((line: string) => line !== DONE),
          // a silent run should not hold sockets forever
          Stream.interruptWhen(Effect.sleep("5 minutes")),
          Stream.concat(Stream.make("data: [DONE]\n\n")),
          Stream.map((line: string) => encoder.encode(line)),
          Stream.catch(() => Stream.empty),
          Stream.ensuring(unsubscribe),
        ) as Stream.Stream<Uint8Array>;
        return HttpServerResponse.stream(stream, { headers: sseHeaders });
      }),
    );

    // ── the HUMAN's key (supervised mode): approve a PR ──────────────
    // Records into the SAME approvals ledger the merge tool ratifies
    // against — the org-console equivalent of a GitHub APPROVED review
    // (which the sandbox's single token cannot submit on its own PRs).
    // The wake rides the world door: the confirmation comment routes
    // to the PR's owner like any other event, and its next merge
    // attempt observes the approval.
    const approvePullRequest = HttpRouter.add(
      "POST",
      "/api/prs/:number/approve",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const number = Number(params.number);
        if (!Number.isFinite(number)) {
          return yield* HttpServerResponse.json(
            { error: "bad pull request number" },
            { status: 400 },
          );
        }
        const identity = yield* GitHub.resolveRepository(testAlchemy);
        const key = {
          owner: identity.owner,
          repository: identity.repository,
          number,
        };
        // IDEMPOTENT: a retried POST (an interrupted curl, a double
        // click) must not spam the PR with duplicate comments
        if (yield* approvals.isApproved(key)) {
          return yield* HttpServerResponse.json({
            approved: number,
            already: true,
          });
        }
        yield* approvals.record(key);
        yield* comment({
          issue_number: number,
          body: "✅ **Approved by the operator** (org console) — the merge is authorized.",
        }).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ approved: number });
      }),
    );

    const status = HttpRouter.add(
      "GET",
      "/api/status",
      Effect.gen(function* () {
        const snapshot = yield* Effect.all(
          {
            issues: issues.list(),
            pullRequests: pullRequests.list(),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(({ issues, pullRequests }) => ({
            phase: "running",
            openIssues: issues.map((issue) => ({
              number: issue.number,
              title: issue.title,
            })),
            openPullRequests: pullRequests.map((pull) => ({
              number: pull.number,
              title: pull.title,
            })),
          })),
          Effect.catch((error) =>
            Effect.succeed({
              phase: "degraded",
              error: String(error),
            } as const),
          ),
        );
        return yield* HttpServerResponse.json(snapshot);
      }),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          listChats,
          board,
          chatMessages,
          chatStream,
          approvePullRequest,
          status,
        ),
      ),
    };
  }),
  // the org's machinery as the constructor's LAYERS: built with instance
  // lifetime, so the background fibers (GitHub pollers, kernel actor
  // loops) live until the process is killed — an `Effect.provide` here
  // would tear them down the moment init returns its handlers
  OrgLive,
) {}
