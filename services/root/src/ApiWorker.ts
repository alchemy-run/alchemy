import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Api } from "./Api.ts";
import { ArtifactsSandbox } from "./artifacts/ArtifactsSandbox.ts";
import { ReadOutputLive } from "./artifacts/ReadOutput.ts";
import { SpillingTools } from "./artifacts/SpillingTools.ts";
import { AskLive, TellLive } from "./chat/Ask.ts";
import { Calls, CallToolLive } from "./chat/Call.ts";
import { CallsLive, PostsLive } from "./chat/ChatDO.ts";
import { ExploreLive } from "./chat/Explore.ts";
import { WriteTools } from "./coding/Editor.ts";
import { OpenPullRequestLive } from "./coding/OpenPullRequest.ts";
import { PushBranchLive } from "./coding/PushBranch.ts";
import { ReadTools, RunTools } from "./coding/Toolbox.ts";
import { GeneralEngineer } from "./engineering/Engineer.ts";
import { ColleaguesLive, EngineeringChart } from "./engineering/Group.ts";
import { ManagerLive } from "./engineering/Manager.ts";
import { GeneralReviewer } from "./engineering/Reviewer.ts";
import { TriageLive } from "./engineering/TriageDO.ts";
import { GitHubWorker } from "./github/GitHubWorker.ts";
import { PublishTokenLive } from "./github/PublishToken.ts";
import { SessionRepoLive } from "./github/SessionRepo.ts";
import { HeadLive } from "./Head.ts";
import { OrgDoctrine } from "./OrgGuidance.ts";
import { DriverCloudflare } from "./platform/DriverCloudflare.ts";
import { SkillGateD1 } from "./platform/SkillGateD1.ts";
import { AwsEmulationGeneral } from "./process/AwsEmulation.ts";
import { CloudflareEmulationGeneral } from "./process/CloudflareEmulation.ts";
import { DistillationGeneral } from "./process/Distillation.ts";
import { ProviderEngineeringGeneral } from "./process/ProviderEngineering.ts";
import { VerificationGeneral } from "./process/Verification.ts";
import { ProposalsLive } from "./proposals/ProposalsDO.ts";
import { RootChart } from "./Root.ts";
import { SandboxSession } from "./sandbox/SandboxSession.ts";
import { WorkspaceAgentLive } from "./sandbox/WorkspaceAgent.ts";

/** ONE org registry per isolate — every Agent/Skill/Group Layer that
 *  builds registers its static declaration (template + refs + pinned
 *  model), and `GET /api/org` serves the org graph from it: the
 *  organization, derived, never re-declared. */
const OrgStructure = Layer.sync(AI.OrgRegistry, () => AI.makeOrgRegistry());

/** The artifact store on the session's workspaces. */
const Store = ArtifactsSandbox;

/** Read + Run over the workspace router — what every agent holds. */
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

/** What every CONVERSING member holds: the ask/tell/call physics over
 *  the colleague addresses and the call store, plus the EXPLORER —
 *  every response starts from zero and restores context by walking
 *  the message graph. */
const Conversation = Layer.mergeAll(
  AskLive,
  TellLive,
  CallToolLive,
  ExploreLive,
).pipe(
  Layer.provide(ColleaguesLive),
  Layer.provide(PostsLive),
  Layer.provide(CallsLive),
);

/** The ENGINEER — the team's worker: read + run + editor, the publish
 *  pair behind the human gate, the conversation seams. */
const EngineerWorker = GeneralEngineer.pipe(
  Layer.provide([PushBranchLive, OpenPullRequestLive]),
  Layer.provide(PublishTokenLive),
  Layer.provide(Conversation),
  Layer.provide(ProposalsLive),
  Layer.provide(WorkspaceAgentLive),
  Layer.provide(Editor),
  Layer.provide(Guidance),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(SandboxSession),
  Layer.provide(SessionRepoLive),
);

/** The REVIEWER — the quality gate: the same hands as the engineer
 *  (review by running; self-improvement PRs), plus the proposal tools
 *  (READY is filing the merge proposal) and workspaces of its own. */
const ReviewerWorker = GeneralReviewer.pipe(
  Layer.provide([PushBranchLive, OpenPullRequestLive]),
  Layer.provide(PublishTokenLive),
  Layer.provide(Conversation),
  Layer.provide(ProposalsLive),
  Layer.provide(WorkspaceAgentLive),
  Layer.provide(Editor),
  Layer.provide(Guidance),
  Layer.provide(Toolbox),
  Layer.provide(Spill),
  Layer.provide(SandboxSession),
  Layer.provide(SessionRepoLive),
);

/** The MANAGER — the head of the engineering team: the triage queue,
 *  the channel's threads, spawn/workspaces, proposals, conversation. */
const ManagerWorker = ManagerLive.pipe(
  Layer.provide(EngineerWorker),
  Layer.provide(TriageLive),
  Layer.provide(Conversation),
  Layer.provide(ProposalsLive),
  Layer.provide(WorkspaceAgentLive),
  Layer.provide(SandboxSession),
  Layer.provide(SessionRepoLive),
);

/** The TEAM — the org chart over its members' implementations. */
const EngineeringLive = EngineeringChart.pipe(
  Layer.provide(ManagerWorker),
  Layer.provide(EngineerWorker),
  Layer.provide(ReviewerWorker),
);

/** The WORKSPACE — one session per workspace: the machine-owning
 *  resource the company works in, the target of `/terminal/Workspace/…`. */
const WorkspaceWorker = WorkspaceAgentLive.pipe(Layer.provide(SandboxSession));

/** The ROOT GROUP — the chart over the Head and the team it names.
 *  Deployed like every group: its Layer build IS its registration in
 *  the org registry (nothing lists Root by hand). */
const RootLive = Layer.suspend(() => RootChart).pipe(
  Layer.provide(Layer.suspend(() => HeadWorker)),
  Layer.provide(EngineeringLive),
);

/** The HEAD — ⊤: the Root Thread's resident. */
const HeadWorker = Layer.suspend(() => HeadLive).pipe(
  Layer.provide(EngineeringLive),
  Layer.provide(Conversation),
  Layer.provide(ProposalsLive),
  Layer.provide(WorkspaceWorker),
  Layer.provide(SandboxSession),
  Layer.provide(SessionRepoLive),
);

// INGEST: GitHub events → the triage queue → the manager.
// DISABLED for now (operator's call): the review loop is being
// exercised on self-initiated tasks only — no forwarding of real
// issues/pull requests. Re-enable by restoring TriagePump here (and
// its import) and adding IngestWorker back into the Company merge.
//
// const IngestWorker = TriagePump.pipe(
//   Layer.provide(ManagerWorker),
//   Layer.provide(TriageLive),
//   // a REAL webhook: deploy provisions it against the Worker's URL;
//   // under `alchemy dev` the local provider polls GitHub and posts
//   // the same deliveries to the local Worker
//   Layer.provide(Cloudflare.GitHubRepositoryEventSourceLive),
// );

/**
 * The ROUTER runs at the Worker level, where no session workspace
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

/**
 * THE COMPANY over Cloudflare physics — Human + Root + Head:
 *
 * - the Root Thread → the Head's session (`Head:root`): the one
 *   conversation; its live wire is the `/attach/Head/root` socket
 * - the groups     → code (Root.ts, engineering/Group.ts): sessions
 *   moment a colleague is addressed; ask-chains bubble answers up
 * - the inbound    → the triage queue (one DO), strictly FIFO into
 *   the manager
 * - workspaces     → each its own machine with the repo checked out
 *   (a MicroVM deployed, a linked worktree in dev)
 * - decisions      → proposals (one DO): the humans' Approve/Deny on
 *   the Root Thread's cards
 */
const Company = Layer.mergeAll(
  HeadWorker,
  RootLive,
  EngineeringLive,
  ManagerWorker,
  EngineerWorker,
  ReviewerWorker,
  WorkspaceWorker,
  Conversation,
  // the routes' own reads: colleague addresses (CallsApi), stores
  ColleaguesLive,
  SandboxSession,
  PublishTokenLive,
).pipe(
  Layer.provideMerge(TriageLive),
  Layer.provideMerge(ProposalsLive),
  Layer.provideMerge(CallsLive),
  Layer.provideMerge(PostsLive),
  Layer.provideMerge(CheckoutsRouter),
  Layer.provideMerge(OrgStructure),
  // the runtime switch over skill activation (the profile UI's
  // toggles) — consulted by the driver's activation doors
  Layer.provideMerge(SkillGateD1),
  Layer.provideMerge(DriverCloudflare),
  Layer.provideMerge(GitHubWorker),
  // MERGED (not just provided): the Api's own routes (OrgApi's skill
  // config) resolve the D1 door from the Company too
  Layer.provideMerge(Cloudflare.D1.QueryDatabaseBinding),
  Layer.orDie,
);

/**
 * The company, served — a Cloudflare Worker whose HTTP surface is the
 * Api (src/Api.ts) plus the sockets: `/attach/:term/:key` (the chat —
 * `/attach/Head/root` IS the Root Thread) and `/terminal/:term/:key`
 * (the PTY bridge) upgrade into the session's own DO;
 * `/api/calls/:id/live` into the CallDO.
 */
export default class ApiWorker extends Cloudflare.Worker<ApiWorker>()(
  "Worker",
  {
    // API + sockets only — the SPA is its own Worker
    // (`Cloudflare.Website.Vite` in alchemy.run.ts) that forwards
    // /api, /attach, /terminal here over a service binding.
    main: import.meta.url,
    // PINNED dev port (the Website pins 1337): stable addresses across
    // restarts
    dev: { port: 1340 },
  },
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;
    const calls = yield* Calls;
    const api = yield* HttpRouter.toHttpEffect(yield* Api);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        // a call's live view
        const live = /^\/api\/calls\/([^/]+)\/live$/.exec(path);
        if (live !== null) {
          return yield* calls.socket(decodeURIComponent(live[1]!), request);
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
  }).pipe(Effect.provide(Company)),
) {}
