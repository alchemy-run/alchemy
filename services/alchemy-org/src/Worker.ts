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
import { ChannelAgentLive } from "./channel/ChannelAgent.ts";
import { Channel } from "./channel/Channel.ts";
import { ChannelLive } from "./channel/ChannelDO.ts";
import { ChannelEvents } from "./channel/ChannelEvents.ts";
import { GitHubWorker } from "./github/GitHubWorker.ts";
import { PublishTokenLive } from "./github/PublishToken.ts";
import { OrgDoctrine } from "./OrgGuidance.ts";
import { DriverCloudflare } from "./platform/DriverCloudflare.ts";
import { routes } from "./Routes.ts";
import { ArtifactsSandbox } from "./artifacts/ArtifactsSandbox.ts";
import { ReadOutputLive } from "./artifacts/ReadOutput.ts";
import { SandboxSession } from "./sandbox/SandboxSession.ts";
import { SessionRepoLive } from "./github/SessionRepo.ts";
import { SpillingTools } from "./artifacts/SpillingTools.ts";
import { ThreadAgentLive } from "./thread/ThreadAgent.ts";
import { ThreadsLive } from "./thread/ThreadDO.ts";
import { Threads } from "./thread/Threads.ts";

/** The artifact store on the session's machine. */
const Store = ArtifactsSandbox;

/** Git over that same machine — one composition shared by every
 *  charter (worktrees per thread ride the same seam). */
const Checkouts = SandboxSession;

/** Read + Run over the session machine — what every agent holds. */
const Toolbox = Layer.mergeAll(ReadTools, RunTools).pipe(
  Layer.provide(Store),
  Layer.provide(SandboxSession),
);

/** The pluggable doctrine, dormant until a change touches its domain. */
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

/** The ENGINEER — a thread's coding subagent: Read + Run + editor,
 *  plus the publish pair (push the branch, open the pull request —
 *  both land on GitHub directly). */
const EngineerWorker = GeneralEngineer.pipe(
  Layer.provide(
    Layer.mergeAll(PushBranchLive, OpenPullRequestLive).pipe(
      Layer.provide(PublishTokenLive),
    ),
  ),
  Layer.provide(Editor),
  Layer.provide(Guidance),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(Checkouts),
  Layer.provide(SandboxSession),
  Layer.provide(SessionRepoLive),
);

/** The THREAD AGENT — one session per thread, the task's whole
 *  conversation; governs its assigned refs, worktrees, subagents. */
const ThreadWorker = Layer.suspend(() => ThreadAgentLive).pipe(
  Layer.provide(EngineerWorker),
  Layer.provide(SessionRepoLive),
  Layer.provide(Checkouts),
  Layer.provide(SandboxSession),
);

/** The CHANNEL AGENT — codemode over the control plane; runs only on
 *  the operator's channel messages. It never holds the thread agent:
 *  it calls the thread (`Threads`), and the thread manipulates its
 *  agent. */
const ChannelWorker = Layer.suspend(() => ChannelAgentLive);

/**
 * The ROUTER runs at the Worker level, where no session machine
 * exists: `checkout` belongs to session charters alone.
 */
const CheckoutsRouter = Layer.succeed(Git.Checkouts, {
  checkout: () =>
    Effect.die(
      "Git.Checkouts.checkout at the Worker level — checkouts belong to session charters",
    ),
  get: () => Effect.succeed(Option.none()),
  release: () => Effect.void,
});

/** INGEST: GitHub webhooks → ChannelDO.deliver → owned threads. */
const IngestWorker = ChannelEvents.pipe(
  Layer.provide(CheckoutsRouter),
  // a REAL webhook: deploy provisions it against the Worker's URL;
  // under `alchemy dev` the local provider polls GitHub and posts the
  // same deliveries to the local Worker
  Layer.provide(Cloudflare.GitHubRepositoryEventSourceLive),
);

/**
 * The whole org over CLOUDFLARE physics, CHANNEL-FIRST:
 *
 * - the channel  → ONE ChannelDO (`main`): the org-wide log, the
 *                  thread directory, webhook dedupe, `/channel` WS
 * - threads      → one ThreadDO per task (`t-…`): assigned refs, agents,
 *                  `/thread/:id` WS; the thread's CONVERSATION is its
 *                  agent session (DriverCloudflare)
 * - sessions     → Durable Objects (`platform/DriverCloudflare.ts`);
 *                  no session management surface — sessions exist only
 *                  as channel runs, thread agents, and subagents
 * - GitHub       → `*Http` bindings + a REAL repository webhook; reads
 *                  for the review view are on demand, nothing mirrored;
 *                  agents write directly (push, open pull requests)
 * - the tools    → each thread's OWN machine (one sandbox per thread,
 *                  a worktree per pull request)
 */
const Org = Layer.mergeAll(
  ThreadWorker,
  ChannelWorker,
  IngestWorker,
  EngineerWorker,
  SandboxSession,
  PublishTokenLive,
).pipe(
  // the thread as an object: its books (ThreadDO) and its agent (by
  // name through AI.Sessions); dropping a deleted thread's worktrees
  // runs git over the thread's machine, so the seam rides along
  Layer.provideMerge(ThreadsLive.pipe(Layer.provide(SandboxSession))),
  Layer.provideMerge(ChannelLive),
  Layer.provideMerge(DriverCloudflare),
  Layer.provideMerge(GitHubWorker),
  Layer.provide(Cloudflare.D1.QueryDatabaseBinding),
  Layer.orDie,
);

/**
 * The org, deployed — a Cloudflare Worker whose HTTP surface is the
 * channel (Routes.ts) plus the sockets: `/channel` upgrades into the
 * ChannelDO, `/thread/:id` into that thread's DO, and
 * `/attach/:term/:key` + `/terminal/:term/:key` into the session's
 * own DO exactly as before.
 */
export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  {
    // API + sockets only — the SPA is its own Worker
    // (`Cloudflare.Website.Vite` in alchemy.run.ts) that forwards
    // /api, /attach, /terminal, /channel, /thread here over a service
    // binding.
    main: import.meta.url,
    // PINNED dev port (the Website pins 1337): stable addresses across
    // restarts
    dev: { port: 1340 },
  },
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;
    const channelService = yield* Channel;
    const threadsService = yield* Threads;
    const api = yield* HttpRouter.toHttpEffect(yield* routes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        // the channel's live tail
        if (path === "/channel") {
          return yield* channelService.socket(request);
        }
        // a thread's state push
        if (path.startsWith("/thread/")) {
          const id = decodeURIComponent(path.slice("/thread/".length));
          if (id.length === 0) {
            return HttpServerResponse.text("bad thread socket path", {
              status: 400,
            });
          }
          return yield* threadsService.socket(id, request);
        }
        // session sockets: /attach/… is the chat socket, /terminal/…
        // the PTY bridge — the session DO tells them apart by pathname
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
