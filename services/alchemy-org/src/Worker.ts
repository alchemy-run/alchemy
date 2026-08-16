import * as AI from "alchemy/AI";
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
import { orgRoutes } from "./Routes.ts";
import { ApprovalsD1 } from "./services/ApprovalsD1.ts";
import { DriverCloudflare } from "./services/DriverCloudflare.ts";
import { GitHubWorker } from "./services/GitHubWorker.ts";
import { LedgerD1 } from "./services/LedgerD1.ts";
import { CheckoutsSandbox } from "./services/CheckoutsSandbox.ts";
import { QualityAssuranceGeneral } from "./skills/QualityAssurance.ts";
import { ReadDiffLive, ReadIssueLive } from "./tools/index.ts";
import { ReadOutputLive } from "./tools/ReadOutput.ts";
import { ReadTools, RunTools, WriteTools } from "./tools/Toolbox.ts";

/** Each session's own machine, resolved at CALL time from the session
 *  DO (the layers build in the shared per-isolate graph). ONE const —
 *  the toolbox, the spill store, and the checkout share the machine. */
const SandboxSession = Cloudflare.AI.SandboxContainerSession({
  enableInternet: true,
});

/** The artifact store on that same machine (readOutput reads what the
 *  spill net and the bash tool parked). */
const Store = ArtifactsSandbox;

const Toolbox = Layer.mergeAll(ReadTools, RunTools, WriteTools).pipe(
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

const Spill = SpillingTools.pipe(
  Layer.provide(ReadOutputLive),
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

/** The engineer over the session container. */
const EngineerWorker = GeneralEngineer.pipe(
  Layer.provide(Toolbox),
  Layer.provide(Spill),
);

/** The review charter: tools + checkout live INSIDE the session's
 *  container — git runs one RPC hop away, exactly the local reading
 *  experience (repo-relative paths at the tree root). */
const ReviewBotWorkerLive = Layer.suspend(() => ReviewBotLive).pipe(
  Layer.provide([QualityAssuranceGeneral, ReadDiffLive, ReadIssueLive]),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(CheckoutsSandbox.pipe(Layer.provide(SandboxSession))),
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

/** The review pipeline: webhook router + charter. */
const ReviewBotWorker = ReviewBotEvents.pipe(
  // provideMERGE: the HTTP edge addresses the bot too (click-to-review)
  Layer.provideMerge(ReviewBotWorkerLive),
  Layer.provide(CheckoutsRouter),
  // a REAL webhook: deploy provisions it against the Worker's URL,
  // runtime verifies signatures and claims the delivery path
  Layer.provide(Cloudflare.GitHubRepositoryEventSourceLive),
  Layer.provideMerge(LedgerD1),
);

/** The whole org over CLOUDFLARE physics. */
const Org = Layer.mergeAll(EngineerWorker, ReviewBotWorker).pipe(
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
export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
  "OrgWorker",
  {
    main: import.meta.url,
    // The same SPA Local.Vite serves locally (vite.config.ts → ui/dist;
    // run `bun vite build` before deploying). Assets-first with SPA
    // fallback; API / attach / webhook paths run this Worker first so
    // the SPA never swallows them.
    assets: {
      directory: "./ui/dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/attach/*", "/__alchemy/*"],
    },
  },
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;
    const api = yield* HttpRouter.toHttpEffect(yield* orgRoutes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        // keys may contain `/` (owner/repo#n) — rest-join after term
        if (path.startsWith("/attach/")) {
          const [, , term, ...rest] = path.split("/");
          if (!term || rest.length === 0) {
            return HttpServerResponse.text("bad attach path", {
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
