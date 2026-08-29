import * as AI from "alchemy/AI";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { GeneralEngineer } from "./Engineer.ts";
import { SpillingTools } from "./lib/SpillingTools.ts";
import { ArtifactsSandbox } from "./lib/ArtifactsSandbox.ts";
import { ReviewBotEvents, ReviewBotLive } from "./ReviewBot.ts";
import { routes } from "./Routes.ts";
import { ApprovalsD1 } from "./services/ApprovalsD1.ts";
import { DriverCloudflare } from "./services/DriverCloudflare.ts";
import { GitHubWorker } from "./services/GitHubWorker.ts";
import { LedgerD1 } from "./services/LedgerD1.ts";
import { CheckoutsSandbox } from "./services/CheckoutsSandbox.ts";
import { QualityAssuranceGeneral } from "./skills/QualityAssurance.ts";
import {
  OpenPullRequestLive,
  PublishTokenLive,
  PushBranchLive,
  ReadDiffLive,
  ReadIssueLive,
} from "./tools/index.ts";
import { ReadOutputLive } from "./tools/ReadOutput.ts";
import { ReadTools, RunTools, WriteTools } from "./tools/Toolbox.ts";

/**
 * Each session's own machine, resolved at CALL time from the session
 * (the layers build in the shared per-isolate graph). ONE const — the
 * toolbox, the spill store, and the checkout share the machine.
 *
 * HARDCODED to the AWS Lambda MicroVM (Firecracker) launched from the
 * shared image, driven cross-cloud from this Worker (the HTTP/token
 * binding impls mint an IAM user + assume-role for the Worker). To go
 * back to the Cloudflare Container attached to the session DO, swap
 * this const for:
 *
 * ```ts
 * const SandboxSession = Cloudflare.AI.SandboxContainerSession({
 *   enableInternet: true,
 * });
 * ```
 *
 * (and mirror the swap in services/DriverCloudflare.ts + alchemy.run.ts)
 */
const SandboxSession = AWS.AI.SandboxMicrovmSession({
  // the SESSION owns the machine: thread keys are `<session>::<thread>`,
  // so every thread of a session (and its terminal) shares one MicroVM
  machineKey: (key) => key.split("::")[0]!,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      AWS.Lambda.RunMicrovmHttp,
      AWS.Lambda.GetMicrovmHttp,
      AWS.Lambda.CreateAuthTokenHttp,
      // session lifecycle → machine lifecycle: settle suspends the
      // session's VM, resume wakes it, remove terminates it (wired in
      // the driver)
      AWS.Lambda.SuspendMicrovmHttp,
      AWS.Lambda.ResumeMicrovmHttp,
      AWS.Lambda.TerminateMicrovmHttp,
    ),
  ),
);

/** The artifact store on that same machine (readOutput reads what the
 *  spill net and the bash tool parked). */
const Store = ArtifactsSandbox;

/** Git over that same machine — ONE composition shared by both
 *  charters (the engineer claims the session repo's tree; the review
 *  bot claims the PR head's). */
const Checkouts = CheckoutsSandbox.pipe(Layer.provide(SandboxSession));

const Toolbox = Layer.mergeAll(ReadTools, RunTools, WriteTools).pipe(
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

const Spill = SpillingTools.pipe(
  Layer.provide(ReadOutputLive),
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

/** The engineer over the session container — plus the PUBLISH pair:
 *  push rides the sandbox's own git, the PR the GitHub REST API, both
 *  authenticated by the host's one FQN-memoized token resource. */
const EngineerWorker = GeneralEngineer.pipe(
  Layer.provide(
    Layer.mergeAll(PushBranchLive, OpenPullRequestLive).pipe(
      // the host-minted PAT — one FQN-memoized resource for the pair
      Layer.provide(PublishTokenLive),
    ),
  ),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(Checkouts),
  Layer.provide(SandboxSession),
);

/** The review charter: tools + checkout live INSIDE the session's
 *  container — git runs one RPC hop away, exactly the local reading
 *  experience (repo-relative paths at the tree root). */
const ReviewBotWorkerLive = Layer.suspend(() => ReviewBotLive).pipe(
  Layer.provide([QualityAssuranceGeneral, ReadDiffLive, ReadIssueLive]),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(Checkouts),
);

/**
 * The ROUTER runs at the Worker level, where no session machine
 * exists: `release` is a no-op (the container recycles with its
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

/** The review pipeline: webhook router + charter.
 *
 * DISABLED for now — not merged into {@link Org} below, so the webhook
 * resource, the PR polling, and the ReviewBot sessions all drop out of
 * the stack. Kept exported (and compiling) so re-enabling is one edit:
 * add it back to the `Org` mergeAll. */
export const ReviewBotWorker = ReviewBotEvents.pipe(
  // provideMERGE: the HTTP edge addresses the bot too (click-to-review)
  Layer.provideMerge(ReviewBotWorkerLive),
  Layer.provide(CheckoutsRouter),
  // a REAL webhook: deploy provisions it against the Worker's URL,
  // runtime verifies signatures and claims the delivery path
  Layer.provide(Cloudflare.GitHubRepositoryEventSourceLive),
  Layer.provideMerge(LedgerD1),
);

/** The whole org over CLOUDFLARE physics. SandboxSession is merged in
 *  so the ROUTES see `AI.Sandbox` too (the terminal door) — the same
 *  layer reference the charters consume, deduped by the build MemoMap,
 *  so the terminal lands on the same machine registry the tools use.
 *  (ReviewBotWorker deliberately absent — reviews are disabled.) */
const Org = Layer.mergeAll(EngineerWorker, SandboxSession).pipe(
  Layer.provideMerge(DriverCloudflare),
  Layer.provideMerge(GitHubWorker),
  Layer.provideMerge(ApprovalsD1),
  Layer.provide(Cloudflare.D1.QueryDatabaseBinding),
  Layer.orDie,
);

/**
 * The org, deployed — a Cloudflare Worker hosting both agents over
 * Cloudflare physics (the mirror of Server.ts):
 *
 * - sessions   → Durable Objects (`services/DriverCloudflare.ts`)
 * - the board  → D1 (`SessionIndexD1`), fed by the driver's stream
 * - GitHub     → `*Http` bindings (a PersonalAccessToken bound as a
 *                Worker secret) + a REAL repository webhook (push
 *                delivery — the polling latency disappears)
 * - dedupe     → the Ledger on D1
 * - approvals  → D1 rows (the operator answers from any instance)
 * - the tools  → each session's OWN container (`SandboxContainerSession`),
 *                started on first use, recycled after idle
 * - checkouts  → git INSIDE that container (`CheckoutsSandbox`)
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
