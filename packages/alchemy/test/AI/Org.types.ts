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
 * 3. **Interface level** — `AI.Process<Self, Interface>()` makes the
 *    term's tag resolve to `ProcessService & Interface`; declaring an
 *    interface obligates a hand-written `Layer.effect(Term, …)` (the
 *    kernel defaults `AI.layer`/`AI.process` are compile-fenced).
 */
import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
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
  L extends AI.Process<
    infer Out,
    infer In,
    infer Err,
    infer Req,
    any,
    any,
    any,
    any
  >
    ? { out: Out; in: In; err: Err; req: Req }
    : never;

// ─── ResolveGitHubIssue: the one ring (one Process, multiple agents) ──────
// One GitHub issue owned end to end; the WORLD (GitHub closing the
// issue) settles the case, never the model's claim.

type ResolveGitHubIssueC = ChannelsOf<typeof ResolveGitHubIssue>;

// In = the union of its accepted broadcast messages (AI.when): the
// TYPED wire events — a run is created by IssueOpened and steered by
// IssueCommented; the tags are the routing surface (Match.tag).
type _iw_in = Assert<
  IsEqual<ResolveGitHubIssueC["in"]["_tag"], "IssueOpened" | "IssueCommented">
>;
type _iw_in_issue = Assert<
  Has<
    keyof Extract<ResolveGitHubIssueC["in"], { _tag: "IssueOpened" }>,
    "issue"
  >
>;

// Out = unknown: the charter has NO halt — it is EXTERNALLY SETTLED
// (kernel-pruning ruling). The implementation Layer that consumed the
// wire ends the run with `settle(key, event)`; the settled event's
// type is the component's knowledge, never the charter's.
type _iw_out = Assert<IsEqual<ResolveGitHubIssueC["out"], unknown>>;
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
// …and nothing else: event refs contribute NOTHING to Req
// (kernel-pruning ruling — sources are pure vocabulary). The
// machine-observed exit (`AI.exit(AI.when(GitHub.IssueClosed(repo)))`)
// is DELIVERED by the implementation Layer (`settle(key, event)`);
// the wire's compile fence rides the consuming Layer's own
// requirements (canon §5).
type _iw_only_declared = Assert<
  IsEqual<
    ResolveGitHubIssueC["req"],
    Engineer | Reviewer | Comment | SearchIssues | MergePullRequest
  >
>;

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

// AI.when contributes NOTHING to Req (delivery is outside code).
// WhenOnly proves the negative. (testAlchemy is the DEFERRED form —
// the exported un-yielded resource Effect — proving the widened
// constructor changes no Req derivation.)
class WhenOnly extends AI.Process<WhenOnly>()("WhenOnly")`
${AI.when(GitHub.IssueOpened(testAlchemy))} accepted, never
auto-delivered. ${AI.never`perpetual demo ring`}` {}
type _when_nothing = Assert<IsEqual<ChannelsOf<typeof WhenOnly>["req"], never>>;

// World-owned mentions contribute no publish topology (canon §2a ruling
// 4, held at the TYPE level): a bare mention of a world-owned catalog
// source is inert vocabulary — no publish grant, no obligation.
class Vocabulary extends AI.Process<Vocabulary>()("Vocabulary")`
${GitHub.IssueOpened(testAlchemy)} is vocabulary here — the world
publishes it; this process never can.
${AI.never`perpetual demo ring`}` {}
type _vocab_nothing = Assert<
  IsEqual<ChannelsOf<typeof Vocabulary>["req"], never>
>;

// …and an ORG-internal mention is the publish grant as an AFFORDANCE
// (emits topology + ctx.emit) — never a requirement (kernel-pruning
// ruling: sources are pure vocabulary; where emissions route is the
// kernel ASSEMBLY's business, e.g. the AI.EventBus component).
const OrgAnnounce = AI.Event("org.announce", S.Void);
class Announcer extends AI.Process<Announcer>()("Announcer")`
Publish ${OrgAnnounce} when anything noteworthy happens.
${AI.never`perpetual demo ring`}` {}
type _announcer_nothing = Assert<
  IsEqual<ChannelsOf<typeof Announcer>["req"], never>
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
// …the agent tags are eliminated.
type _iwl_no_engineer = Assert<Not<Has<ResolveGitHubIssueClosure, Engineer>>>;
type _iwl_no_reviewer = Assert<Not<Has<ResolveGitHubIssueClosure, Reviewer>>>;

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

// The wire's compile fence lives in USER SPACE (kernel-pruning ruling):
// an implementation Layer that consumes the wire carries its own
// requirement on the seam — e.g. services/alchemy-org's
// `GitHubIssuesLive` requires `GitHub.RepositoryEventSource`, so
// forgetting the webhook/polling Layer fails the deploy's type-check
// through the seam, never through prose-derived Req.

// ─── the declared interface (AI.Process<Self, Interface>) ─────────
// A process may declare domain operations ON TOP OF the actor verbs:
// its tag then resolves to `ProcessService & Interface`. Declaring an
// interface makes `AI.layer`'s `make` argument REQUIRED (the kernel
// interprets the charter; `make` builds the domain methods over the
// SEALED verbs — the interface is the whole public service) — omission
// is an ordinary arity error. `Layer.effect(Term, …)` remains the
// full-control implementation form.

interface IssueRef {
  readonly number: number;
}
class IssueNotFound {
  readonly _tag = "IssueNotFound";
}

class IssueDesk extends AI.Process<
  IssueDesk,
  {
    listIssues(): Effect.Effect<ReadonlyArray<IssueRef>>;
    getIssue(number: number): Effect.Effect<IssueRef, IssueNotFound>;
  }
>()("IssueDesk")`
${AI.when(GitHub.IssueOpened(testAlchemy))} a new issue opens the case.
${AI.never`perpetual demo ring`}` {}

// the tag's Shape is SEALED to the declared interface (replace, not
// extend — owner ruling): the domain methods are there, the actor
// verbs are NOT — delivery cannot be bypassed from outside the
// implementation Layer…
type IssueDeskShape = (typeof IssueDesk)["Service"];
type _id_verb_send = Assert<Not<Has<keyof IssueDeskShape, "send">>>;
type _id_verb_dispatch = Assert<Not<Has<keyof IssueDeskShape, "dispatch">>>;
type _id_verb_steer = Assert<Not<Has<keyof IssueDeskShape, "steer">>>;
type _id_list = Assert<Has<keyof IssueDeskShape, "listIssues">>;
type _id_get = Assert<Has<keyof IssueDeskShape, "getIssue">>;
// …the domain methods keep their declared channels…
type _id_get_err = Assert<
  IsEqual<
    ReturnType<IssueDeskShape["getIssue"]>,
    Effect.Effect<IssueRef, IssueNotFound>
  >
>;
// …and the instance type (what `yield* IssueDesk` resolves) is the
// same sealed interface. (Class name as the type — never
// `InstanceType<typeof …>`, which the circular
// `class X extends AI.Process<X>()` heritage collapses.)
type _id_instance_list = Assert<Has<keyof IssueDesk, "listIssues">>;
type _id_instance_send = Assert<Not<Has<keyof IssueDesk, "send">>>;

// a PLAIN term's tag still resolves to the actor verbs — a process is
// an actor, and `dispatch` is its In → Out function nature
type WhenOnlyShape = (typeof WhenOnly)["Service"];
type _plain_verb_send = Assert<Has<keyof WhenOnlyShape, "send">>;
type _plain_verb_dispatch = Assert<Has<keyof WhenOnlyShape, "dispatch">>;

// the charter's Req derivation is untouched by the Interface parameter
// (event refs contribute nothing — kernel-pruning ruling)
type _id_req_free = Assert<IsEqual<ChannelsOf<typeof IssueDesk>["req"], never>>;

// the verbs the kernel's interpretation yields for IssueDesk (In is the
// IssueOpened payload; the AI.never halt makes Out = never)
type IssueDeskVerbs = AI.ProcessService<
  ChannelsOf<typeof IssueDesk>["out"],
  ChannelsOf<typeof IssueDesk>["in"],
  ChannelsOf<typeof IssueDesk>["err"]
>;
type IssueDeskDomain = {
  listIssues(): Effect.Effect<ReadonlyArray<IssueRef>>;
  getIssue(number: number): Effect.Effect<IssueRef, IssueNotFound>;
};

// `AI.layer(interfaceTerm)` without `make` is an ARITY error — the
// declared interface makes the second argument required:
// @ts-expect-error — an interface-bearing term requires the domain `make` argument
AI.layer(IssueDesk);

// …and the same holds for the deterministic-handler default:
declare const issueDeskHandler: AI.ProcessHandler<typeof IssueDesk>;
// @ts-expect-error — an interface-bearing term requires the trailing domain argument
AI.process(IssueDesk, issueDeskHandler);

// the two-arg form is the LIGHTWEIGHT implementation: kernel-interpreted
// verbs + your domain methods. `make` receives the interpreted verbs…
declare const makeIssueDeskDomain: (inner: IssueDeskVerbs) => IssueDeskDomain;
const IssueDeskDefault = AI.layer(IssueDesk, makeIssueDeskDomain);
type _id_default_out = Assert<
  Has<
    typeof IssueDeskDefault extends Layer.Layer<infer A, infer _E, infer _R>
      ? A
      : never,
    IssueDesk
  >
>;
type _id_default_kernel = Assert<
  Has<
    typeof IssueDeskDefault extends Layer.Layer<infer _A, infer _E, infer R>
      ? R
      : never,
    AI.Kernel
  >
>;

// …an Effect-returning `make` threads its requirements into the Layer…
declare const makeIssueDeskDomainFx: (
  inner: IssueDeskVerbs,
) => Effect.Effect<IssueDeskDomain, never, SearchIssues>;
const IssueDeskDefaultFx = AI.layer(IssueDesk, makeIssueDeskDomainFx);
type _id_default_fx_req = Assert<
  Has<
    typeof IssueDeskDefaultFx extends Layer.Layer<infer _A, infer _E, infer R>
      ? R
      : never,
    SearchIssues
  >
>;

// …and `AI.process` accepts the same trailing domain argument.
const IssueDeskHandled = AI.process(
  IssueDesk,
  issueDeskHandler,
  makeIssueDeskDomain,
);
type _id_handled_out = Assert<
  Has<
    typeof IssueDeskHandled extends Layer.Layer<infer A, infer _E, infer _R>
      ? A
      : never,
    IssueDesk
  >
>;

// a hand-written Layer.effect remains the full-control form: it DEMANDS
// the sealed shape (the declared interface, nothing else)…
declare const issueDeskImpl: Effect.Effect<IssueDeskShape>;
const IssueDeskLive = Layer.effect(IssueDesk, issueDeskImpl);
type _id_layer_out = Assert<
  Has<
    typeof IssueDeskLive extends Layer.Layer<infer A, infer _E, infer _R>
      ? A
      : never,
    IssueDesk
  >
>;

// …and rejects an implementation that only supplies the verbs.
declare const verbsOnlyImpl: Effect.Effect<
  AI.ProcessService<never, IssueRef, AI.BudgetExceeded>
>;
// @ts-expect-error — the Layer must implement the declared domain methods
Layer.effect(IssueDesk, verbsOnlyImpl);

// plain terms (no declared interface) are untouched — the tag IS the
// actor; no `make` argument, same call the Layer-level section above
// already exercises.
AI.layer(ResolveGitHubIssue);
