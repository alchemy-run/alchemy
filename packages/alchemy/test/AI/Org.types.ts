/**
 * Type-level audit of the reference organization (fixtures/org): verifies
 * that the topology's authority boundaries are facts of the type system,
 * not conventions. Never executed — tsc is the test runner for this file.
 *
 * Three levels are audited:
 *
 * 1. **Term level** — a term's `Req` is the union of its refs' *tags*
 *    (interpolation is dependency declaration).
 * 2. **Layer level** — transitive capability flow is Layer composition:
 *    `AI.layer(ResolveGitHubIssue).pipe(Layer.provide(AI.layer(Reviewer)))`
 *    eliminates the Reviewer tag and surfaces the Reviewer's tools.
 *    Capability denial is the fact that `Approve` appears nowhere in
 *    the ring's Layer closure unless the Reviewer's Layer is the door.
 * 3. **Front-door level** — `GitHub.frontDoor(ResolveGitHubIssue)` is a Layer
 *    requiring exactly the term's tag + the wire; the delivery compile
 *    fence rides the consuming call site, never the term.
 */
import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Engineer, Reviewer } from "./fixtures/org/agents.ts";
import { ResolveGitHubIssue } from "./fixtures/org/processes.ts";
import { testAlchemy } from "./fixtures/org/repos.ts";
import type {
  Approve,
  AskHuman,
  Bash,
  Comment,
  EditFile,
  Grep,
  MergePullRequest,
  OpenPullRequest,
  ReadFile,
  SearchIssues,
} from "./fixtures/org/tools.ts";

type Assert<_T extends true> = never;
type Not<T extends boolean> = T extends true ? false : true;
type Has<Union, T> = [Extract<Union, T>] extends [never] ? false : true;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type ChannelsOf<L> =
  L extends AI.Process<infer Out, infer In, infer Err, infer Req, any, any, any>
    ? { out: Out; in: In; err: Err; req: Req }
    : never;

// ─── ResolveGitHubIssue: the one ring (one Process, multiple agents) ──────
// One GitHub issue owned end to end; the WORLD (GitHub closing the
// issue) settles the case, never the model's claim.

type ResolveGitHubIssueC = ChannelsOf<typeof ResolveGitHubIssue>;

// In = the union of its accepted broadcast messages (AI.when): a case
// is created by IssueOpened and steered by IssueCommented — the same
// inbox, two doors, both chosen by the (derived) front door.
type IssueOpenedItem = {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
};
type IssueCommentedItem = {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly author: string;
  readonly comment: string;
};
type _iw_in = Assert<
  IsEqual<ResolveGitHubIssueC["in"], IssueOpenedItem | IssueCommentedItem>
>;

// Out = the machine-observed exit's EVENT payload (AI.exit(AI.when(source))):
// dispatch resolves with what GitHub said when it closed the issue.
type _iw_out = Assert<
  IsEqual<
    ResolveGitHubIssueC["out"],
    {
      readonly owner: string;
      readonly repository: string;
      readonly number: number;
    }
  >
>;
type _iw_err = Assert<
  IsEqual<ResolveGitHubIssueC["err"], AI.BudgetExceeded | AI.Refused>
>;

// Term level: the process delegates to exactly two agents (their own
// toolboxes are *their* layers' requirements, not the process's) and
// holds its own tools — it triages, replies, and merges itself.
type _iw_engineer = Assert<Has<ResolveGitHubIssueC["req"], Engineer>>;
type _iw_reviewer = Assert<Has<ResolveGitHubIssueC["req"], Reviewer>>;
type _iw_reply = Assert<Has<ResolveGitHubIssueC["req"], Comment>>;
type _iw_search = Assert<Has<ResolveGitHubIssueC["req"], SearchIssues>>;
type _iw_merge = Assert<Has<ResolveGitHubIssueC["req"], MergePullRequest>>;
// …plus the machine-observed exit's channel obligation: observing
// GitHub.IssueClosed(repo) is a process-side obligation, so the
// GitHub.Events tag joins Req — the deployment cannot type-check
// without the channel's Layer.
type _iw_channel = Assert<Has<ResolveGitHubIssueC["req"], GitHub.GitHubEvents>>;

// Capability by omission — the merge gate: ResolveGitHubIssue holds
// MergePullRequest (whose own prose refuses without an approved
// review) but NOT Approve — approval lives only in the Reviewer's
// template (the autonomy dial). It also cannot touch the repo directly
// (no Grep/EditFile/Bash/OpenPullRequest — those are the Engineer's,
// behind its Layer) and cannot escalate (no AskHuman).
type _iw_no_approve = Assert<Not<Has<ResolveGitHubIssueC["req"], Approve>>>;
type _iw_no_editFile = Assert<Not<Has<ResolveGitHubIssueC["req"], EditFile>>>;
type _iw_no_grep = Assert<Not<Has<ResolveGitHubIssueC["req"], Grep>>>;
type _iw_no_bash = Assert<Not<Has<ResolveGitHubIssueC["req"], Bash>>>;
type _iw_no_openPr = Assert<
  Not<Has<ResolveGitHubIssueC["req"], OpenPullRequest>>
>;
type _iw_no_askHuman = Assert<Not<Has<ResolveGitHubIssueC["req"], AskHuman>>>;

// AI.when contributes NO channel tag (delivery is outside code): the
// GitHub.Events obligation above comes from the halt alone. WhenOnly
// proves the negative — `when` on channel-backed world sources with no
// machine exit leaves Req channel-free. (testAlchemy is the DEFERRED
// form — the exported un-yielded resource Effect — proving the widened
// constructor changes no Req derivation.)
class WhenOnly extends AI.Process<WhenOnly>()("WhenOnly")`
${AI.when(GitHub.IssueOpened(testAlchemy))} accepted, never
auto-delivered. ${AI.never`perpetual demo ring`}` {}
type _when_no_channel = Assert<
  Not<Has<ChannelsOf<typeof WhenOnly>["req"], GitHub.GitHubEvents>>
>;

// World-owned mentions contribute no publish topology (canon §2a ruling
// 4, held at the TYPE level): a bare mention of a world-owned catalog
// source is inert vocabulary — no publish grant, no channel obligation.
class Vocabulary extends AI.Process<Vocabulary>()("Vocabulary")`
${GitHub.IssueOpened(testAlchemy)} is vocabulary here — the world
publishes it; this process never can.
${AI.never`perpetual demo ring`}` {}
type _vocab_no_channel = Assert<
  Not<Has<ChannelsOf<typeof Vocabulary>["req"], GitHub.GitHubEvents>>
>;

// …while an ORG-internal channel-backed mention IS the publish grant:
// the channel tag joins Req (publishing needs the channel's physics).
class OrgChat extends Context.Service<OrgChat, AI.EventChannelService>()(
  "org/Chat",
) {}
const OrgAnnounce = AI.EventSource("org.announce", S.Void, OrgChat);
class Announcer extends AI.Process<Announcer>()("Announcer")`
Publish ${OrgAnnounce} when anything noteworthy happens.
${AI.never`perpetual demo ring`}` {}
type _announcer_channel = Assert<
  Has<ChannelsOf<typeof Announcer>["req"], OrgChat>
>;

// ─── Layer level: merge authority enters through exactly one door ──
// The Reviewer's template is the only ${Approve} in the org.

const ResolveGitHubIssueLive = AI.layer(ResolveGitHubIssue).pipe(
  Layer.provide([AI.layer(Engineer), AI.layer(Reviewer)]),
);
type ResolveGitHubIssueClosure =
  typeof ResolveGitHubIssueLive extends Layer.Layer<any, any, infer R>
    ? R
    : never;

// providing the agents' layers eliminated their tags and surfaced
// their toolboxes — Approve is in the closure through the Reviewer's
// door, the repo tools through the Engineer's…
type _iwl_approve = Assert<Has<ResolveGitHubIssueClosure, Approve>>;
type _iwl_grep = Assert<Has<ResolveGitHubIssueClosure, Grep>>;
type _iwl_editFile = Assert<Has<ResolveGitHubIssueClosure, EditFile>>;
type _iwl_openPr = Assert<Has<ResolveGitHubIssueClosure, OpenPullRequest>>;
type _iwl_readFile = Assert<Has<ResolveGitHubIssueClosure, ReadFile>>;
type _iwl_kernel = Assert<Has<ResolveGitHubIssueClosure, AI.Kernel>>;
// …the agent tags are eliminated…
type _iwl_no_engineer = Assert<Not<Has<ResolveGitHubIssueClosure, Engineer>>>;
type _iwl_no_reviewer = Assert<Not<Has<ResolveGitHubIssueClosure, Reviewer>>>;
// …and the channel obligation survives composition until a channel
// Layer discharges it.
type _iwl_channel = Assert<Has<ResolveGitHubIssueClosure, GitHub.GitHubEvents>>;

// WITHOUT the Reviewer's layer, no composition can demand Approve: the
// Reviewer tag stays open, but Approve appears nowhere.
const ResolveGitHubIssueNoReviewer = AI.layer(ResolveGitHubIssue).pipe(
  Layer.provide(AI.layer(Engineer)),
);
type ResolveGitHubIssueNoReviewerClosure =
  typeof ResolveGitHubIssueNoReviewer extends Layer.Layer<any, any, infer R>
    ? R
    : never;
type _iwnr_reviewer_open = Assert<
  Has<ResolveGitHubIssueNoReviewerClosure, Reviewer>
>;
type _iwnr_no_approve = Assert<
  Not<Has<ResolveGitHubIssueNoReviewerClosure, Approve>>
>;

// The transitive compile fence: discharging GitHub.Events with the CORE
// channel Layer surfaces its own requirement on the substrate binding —
// forgetting GitHubRepositoryEventSourceLive on the Worker fails to
// type-check.
const ResolveGitHubIssueWired = ResolveGitHubIssueLive.pipe(
  Layer.provide(GitHub.GitHubEventsLive),
);
type ResolveGitHubIssueWiredClosure =
  typeof ResolveGitHubIssueWired extends Layer.Layer<any, any, infer R>
    ? R
    : never;
type _iww_no_channel = Assert<
  Not<Has<ResolveGitHubIssueWiredClosure, GitHub.GitHubEvents>>
>;
type _iww_fence = Assert<
  Has<ResolveGitHubIssueWiredClosure, GitHub.RepositoryEventSource>
>;

// ─── the DERIVED front door (canon §5) ───────────────────────────
// GitHub.frontDoor(ResolveGitHubIssue) is a Layer requiring exactly the term's
// tag (the routing needs the live service) + the wire (the consuming
// call site carries the provisioning compile fence). It provides
// nothing and never demands the kernel or the channel — delivery is
// world-side code, not kernel machinery.

const FrontDoor = GitHub.frontDoor(ResolveGitHubIssue);
// NOTE: `Layer<in ROut, …>` is contravariant in its first parameter and
// `any` is assignable to everything EXCEPT `never` — so a literal
// `Layer.Layer<any, any, infer R>` pattern (used elsewhere in this file)
// silently fails to match the `Layer<never, …>` that Layer.effectDiscard
// produces. Infer all three slots instead.
type FrontDoorR =
  typeof FrontDoor extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
type FrontDoorOut =
  typeof FrontDoor extends Layer.Layer<infer A, infer _E, infer _R> ? A : never;

type _fd_term = Assert<Has<FrontDoorR, ResolveGitHubIssue>>;
type _fd_wire = Assert<Has<FrontDoorR, GitHub.RepositoryEventSource>>;
// exactly those two — nothing else rides in…
type _fd_exact = Assert<
  IsEqual<FrontDoorR, ResolveGitHubIssue | GitHub.RepositoryEventSource>
>;
type _fd_no_channel = Assert<Not<Has<FrontDoorR, GitHub.GitHubEvents>>>;
type _fd_no_kernel = Assert<Not<Has<FrontDoorR, AI.Kernel>>>;
type _fd_no_agents = Assert<Not<Has<FrontDoorR, Engineer | Reviewer>>>;
// …and it provides nothing (Layer.effectDiscard: pure wiring).
type _fd_out = Assert<IsEqual<FrontDoorOut, never>>;
