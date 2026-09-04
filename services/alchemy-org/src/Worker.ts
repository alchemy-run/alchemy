import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DistillationGeneral } from "./process/Distillation.ts";
import { AwsEmulationGeneral } from "./process/AwsEmulation.ts";
import { CloudflareEmulationGeneral } from "./process/CloudflareEmulation.ts";
import { ProviderEngineeringGeneral } from "./process/ProviderEngineering.ts";
import { VerificationGeneral } from "./process/Verification.ts";
import { WriteTools } from "./coding/Editor.ts";
import { GeneralEngineer } from "./coding/Engineer.ts";
import { OpenPullRequestLive } from "./coding/OpenPullRequest.ts";
import { PushBranchLive } from "./coding/PushBranch.ts";
import { ReadTools, RunTools } from "./coding/Toolbox.ts";
import { GitHubWorker } from "./github/GitHubWorker.ts";
import { ProposalsDO } from "./github/ProposalsDO.ts";
import { PublishTokenLive } from "./github/PublishToken.ts";
import { OrgDoctrine } from "./OrgGuidance.ts";
import { DriverCloudflare } from "./platform/DriverCloudflare.ts";
import { FindCompanionsLive } from "./review/Companions.ts";
import { LedgerD1 } from "./review/LedgerD1.ts";
import { ReadDiffLive } from "./review/ReadDiff.ts";
import { ReadIssueLive } from "./review/ReadIssue.ts";
import { ReviewerLive } from "./review/Reviewer.ts";
import { ReviewerEvents } from "./review/ReviewerEvents.ts";
import { routes } from "./Routes.ts";
import { ArtifactsSandbox } from "./artifacts/ArtifactsSandbox.ts";
import { ReadOutputLive } from "./artifacts/ReadOutput.ts";
import { SandboxSession } from "./sandbox/SandboxSession.ts";
import { SessionRepoLive } from "./github/SessionRepo.ts";
import { SpillingTools } from "./artifacts/SpillingTools.ts";

/** The artifact store on the session's machine (readOutput reads what
 *  the spill net and the bash tool parked). */
const Store = ArtifactsSandbox;

/** Git over that same machine — `SandboxSession` provides
 *  `Git.Checkouts` alongside `AI.Sandbox` (the pairing is per machine:
 *  converging git in a MicroVM, worktrees over the dev checkout), ONE
 *  composition shared by both charters (the engineer claims the session
 *  repo's tree; the reviewer claims the PR head's). */
const Checkouts = SandboxSession;

/** Read + Run over the session machine — what BOTH agents hold. The
 *  editor (`coding/Editor.ts`) is added to the engineer alone below. */
const Toolbox = Layer.mergeAll(ReadTools, RunTools).pipe(
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

/** The pluggable doctrine both charters hold, dormant until a change
 *  touches its domain: how alchemy is verified (`process/Verification.ts`,
 *  over the read/run tools), how a provider is built and tested
 *  (`process/ProviderEngineering.ts`), the flywheel that feeds SDK
 *  mismatches back into distilled (`process/Distillation.ts`), how an
 *  resource is emulated locally (`process/AwsEmulation.ts` for floci,
 *  `process/CloudflareEmulation.ts` for the workerd runtime), and
 *  the org's own entry skill with
 *  the domain skills it names (`OrgGuidance.ts`). */
const Guidance = Layer.mergeAll(
  VerificationGeneral,
  ProviderEngineeringGeneral,
  DistillationGeneral,
  AwsEmulationGeneral,
  CloudflareEmulationGeneral,
  OrgDoctrine,
).pipe(Layer.provide(Toolbox));

const Editor = WriteTools.pipe(
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

const Spill = SpillingTools.pipe(
  Layer.provide(ReadOutputLive),
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

/** The engineer over the session machine — Read + Run + the editor,
 *  plus the PUBLISH pair: push rides the sandbox's own git, the PR the
 *  GitHub REST API, both authenticated by the host's one FQN-memoized
 *  token resource. */
const EngineerWorker = GeneralEngineer.pipe(
  Layer.provide(
    Layer.mergeAll(PushBranchLive, OpenPullRequestLive).pipe(
      // the host-minted PAT — one FQN-memoized resource for the pair
      Layer.provide(PublishTokenLive),
    ),
  ),
  Layer.provide(Editor),
  Layer.provide(Guidance),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(Checkouts),
  Layer.provide(SandboxSession),
  // which tree the session works in — for the stance's prose only; the
  // checkout itself happens on first tool touch (SandboxCheckout)
  Layer.provide(SessionRepoLive),
);

/** The review charter: Read + Run (no editor — judge, not author, by
 *  construction) plus the review tools; tools + checkout live INSIDE
 *  the session's machine — git runs one RPC hop away, exactly the
 *  local reading experience (repo-relative paths at the tree root). */
const ReviewerWorkerLive = Layer.suspend(() => ReviewerLive).pipe(
  Layer.provide([ReadDiffLive, ReadIssueLive, FindCompanionsLive, Guidance]),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(Checkouts),
  Layer.provide(SessionRepoLive),
);

/**
 * The ROUTER runs at the Worker level, where no session machine
 * exists: `release` is a no-op (the machine recycles with its
 * session), `checkout` is the charter's act alone.
 */
const CheckoutsRouter = Layer.succeed(Git.Checkouts, {
  checkout: () =>
    Effect.die(
      "Git.Checkouts.checkout at the Worker level — checkouts belong to session charters",
    ),
  get: () => Effect.succeed(Option.none()),
  release: () => Effect.void,
});

/** The review pipeline: the GitHub event router + the charter. Every
 *  pull request opened on the repository is reviewed as it opens and
 *  re-reviewed on every push (`review/ReviewerEvents.ts`); the HTTP
 *  edge addresses the charter too (`POST /api/prs/:n/review` admits a
 *  session by hand). */
const ReviewerWorker = ReviewerEvents.pipe(
  // provideMERGE: the HTTP edge addresses the reviewer too
  Layer.provideMerge(ReviewerWorkerLive),
  Layer.provide(CheckoutsRouter),
  // a REAL webhook: deploy provisions it against the Worker's URL,
  // runtime verifies signatures and claims the delivery path; under
  // `alchemy dev` the Webhook resource's local provider polls GitHub
  // and posts the same deliveries to the local Worker
  Layer.provide(Cloudflare.GitHubRepositoryEventSourceLive),
  Layer.provideMerge(LedgerD1),
);

/** The whole org over CLOUDFLARE physics. SandboxSession is merged in
 *  so the ROUTES see `AI.Sandbox` too (the terminal door) — the same
 *  layer reference the charters consume, deduped by the build MemoMap,
 *  so the terminal lands on the same machine registry the tools use. */
const Org = Layer.mergeAll(EngineerWorker, ReviewerWorker, SandboxSession).pipe(
  Layer.provideMerge(DriverCloudflare),
  Layer.provideMerge(GitHubWorker),
  // one Durable Object per pull request — the store scales with the
  // number of pull requests, not one database's write throughput
  Layer.provideMerge(ProposalsDO),
  Layer.provide(Cloudflare.D1.QueryDatabaseBinding),
  Layer.orDie,
);

/**
 * The org, deployed — a Cloudflare Worker hosting both agents over
 * Cloudflare physics:
 *
 * - sessions   → Durable Objects (`platform/DriverCloudflare.ts`)
 * - the board  → D1 (`SessionIndexD1`), fed by the driver's stream
 * - GitHub     → `*Http` bindings (a PersonalAccessToken bound as a
 *                Worker secret) + a REAL repository webhook (push
 *                delivery — the polling latency disappears)
 * - dedupe     → the Ledger on D1
 * - proposals  → Durable Objects partitioned by pull request
 *                (`github/ProposalsDO.ts`; the operator accepts from
 *                any instance, the executor in Routes performs the
 *                GitHub write)
 * - the tools  → each session's OWN machine (`sandbox/SandboxSession.ts`:
 *                a MicroVM deployed, a worktree of this checkout in dev)
 * - checkouts  → git INSIDE that machine (`CheckoutsSandbox` /
 *                `CheckoutsWorktree`)
 *
 * The same HTTP surface as the local server (Routes.ts) plus the
 * substrate's own doors: the GitHub webhook path is claimed by the
 * event-source binding BEFORE this fetch handler, and
 * `/attach/:term/:key` upgrades a WebSocket into the session's own
 * Durable Object.
 */
export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  {
    // API + sessions only — the SPA is its own Worker
    // (`Cloudflare.Website.Vite` in alchemy.run.ts) that forwards
    // /api and /attach here over a service binding.
    main: import.meta.url,
    // PINNED dev port (the Website pins 1337): stable addresses across
    // restarts — no more port roulette between the two workers
    dev: { port: 1340 },
  },
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;
    const api = yield* HttpRouter.toHttpEffect(yield* routes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        // keys may contain `/` (owner/repo#n) — rest-join after term.
        // BOTH live views ride the same forward into the session's DO:
        // /attach/… is the chat socket, /terminal/… the PTY bridge —
        // the DO tells them apart by pathname (the request rides along).
        if (path.startsWith("/attach/") || path.startsWith("/terminal/")) {
          const [, , term, ...rest] = path.split("/");
          if (!term || rest.length === 0) {
            return HttpServerResponse.text("bad session socket path", {
              status: 400,
            });
          }
          return yield* sessions.attach(
            decodeURIComponent(term),
            rest.map(decodeURIComponent).join("/"),
            request,
          );
        }
        return yield* api;
      }),
    };
  }).pipe(Effect.provide(Org)),
) {}
