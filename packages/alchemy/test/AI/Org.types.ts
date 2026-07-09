/**
 * Type-level audit of the reference organization (fixtures/org): verifies
 * that the topology's authority boundaries are facts of the type system,
 * not conventions. Never executed — tsc is the test runner for this file.
 *
 * Two levels are audited:
 *
 * 1. **Term level** — a term's `Req` is the union of its refs' *tags*
 *    (interpolation is dependency declaration).
 * 2. **Layer level** — transitive capability flow is Layer composition:
 *    `AI.layer(Fix).pipe(Layer.provide(AI.layer(Engineer)))` eliminates
 *    the Engineer tag and surfaces Engineer's tools. Capability denial is
 *    the fact that `Approve` appears nowhere in a ring's Layer closure.
 */
import * as Layer from "effect/Layer";
import * as AI from "@/AI/index.ts";
import {
  Engineer,
  Judge,
  ReleaseBlogger,
  Reviewer,
  Scribe,
  Support,
  Triage,
} from "./fixtures/org/agents.ts";
import { DiscordEvents } from "./fixtures/org/discord-events.ts";
import { GitHubEvents } from "./fixtures/org/github-events.ts";
import { Autoresearch, Fix, Flywheel, Helpdesk } from "./fixtures/org/loops.ts";
import type {
  Approve,
  AskHuman,
  Bash,
  CreateIssue,
  EditFile,
  Grep,
  OpenPullRequest,
  ReadFile,
  Reply,
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
  L extends AI.Loop<infer Out, infer In, infer Err, infer Req, any, any, any>
    ? { out: Out; in: In; err: Err; req: Req }
    : never;

type FixC = ChannelsOf<typeof Fix>;
type FlywheelC = ChannelsOf<typeof Flywheel>;
type HelpdeskC = ChannelsOf<typeof Helpdesk>;
type AutoresearchC = ChannelsOf<typeof Autoresearch>;

// ─── Fix: the task loop ──────────────────────────────────────────
// A run consumes one issue and resolves with the PR it opened.

type _fix_in = Assert<
  IsEqual<
    FixC["in"],
    {
      readonly owner: string;
      readonly repository: string;
      readonly number: number;
    }
  >
>;
type _fix_out = Assert<
  IsEqual<
    FixC["out"],
    {
      readonly owner: string;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
    }
  >
>;
type _fix_err = Assert<IsEqual<FixC["err"], AI.BudgetExceeded | AI.Refused>>;

// Term level: Req is the tags of the charter's refs — the delegated
// agents (Engineer), the positional verifier (Judge) and fold (Scribe),
// and loop-level tools nested in control-ref templates (Bash in the
// check's grading policy). The agents' own toolboxes are *their* layers'
// requirements, not the loop's.
type _fix_engineer = Assert<Has<FixC["req"], Engineer>>;
type _fix_judge = Assert<Has<FixC["req"], Judge>>;
type _fix_scribe = Assert<Has<FixC["req"], Scribe>>;
type _fix_bash = Assert<Has<FixC["req"], Bash>>;
type _fix_no_grep = Assert<Not<Has<FixC["req"], Grep>>>;
type _fix_no_reviewer = Assert<Not<Has<FixC["req"], Reviewer>>>;
// Fix can neither merge nor escalate — by omission, not by policy
type _fix_no_approve = Assert<Not<Has<FixC["req"], Approve>>>;
type _fix_no_askHuman = Assert<Not<Has<FixC["req"], AskHuman>>>;

// Layer level: providing the agents' kernel-derived layers eliminates
// their tags and surfaces their toolboxes — the transitive closure.
const FixLive = AI.layer(Fix).pipe(
  Layer.provide([AI.layer(Engineer), AI.layer(Judge), AI.layer(Scribe)]),
);
type FixClosure =
  typeof FixLive extends Layer.Layer<any, any, infer R> ? R : never;

// the Engineer's toolbox flows in through its layer…
type _fixl_grep = Assert<Has<FixClosure, Grep>>;
type _fixl_read = Assert<Has<FixClosure, ReadFile>>;
type _fixl_edit = Assert<Has<FixClosure, EditFile>>;
type _fixl_openPr = Assert<Has<FixClosure, OpenPullRequest>>;
// …the fold's (Scribe → CreateIssue) and the kernel itself…
type _fixl_createIssue = Assert<Has<FixClosure, CreateIssue>>;
type _fixl_kernel = Assert<Has<FixClosure, AI.Kernel>>;
// …the agent tags are eliminated…
type _fixl_no_engineer = Assert<Not<Has<FixClosure, Engineer>>>;
// …and the whole closure still cannot demand merge authority.
type _fixl_no_approve = Assert<Not<Has<FixClosure, Approve>>>;
type _fixl_no_askHuman = Assert<Not<Has<FixClosure, AskHuman>>>;

// ─── Flywheel: the product loop ──────────────────────────────────
// Perpetual; wakes on GitHub events from both managed repositories.

type _fw_out = Assert<IsEqual<FlywheelC["out"], never>>;
// subscribing to GitHub sources places the channel tag in Req —
// declaring the subscription obligates the webhook infrastructure
type _fw_channel = Assert<Has<FlywheelC["req"], GitHubEvents>>;
type _fw_no_discord = Assert<Not<Has<FlywheelC["req"], DiscordEvents>>>;
// dispatching Fix nests the loop tag; running agents contributes theirs
type _fw_fix = Assert<Has<FlywheelC["req"], Fix>>;
type _fw_triage = Assert<Has<FlywheelC["req"], Triage>>;
type _fw_reviewer = Assert<Has<FlywheelC["req"], Reviewer>>;
type _fw_blogger = Assert<Has<FlywheelC["req"], ReleaseBlogger>>;
// nested control-ref templates still contribute loop-level tools
type _fw_reply = Assert<Has<FlywheelC["req"], Reply>>;

// Layer level: merge authority enters the closure through exactly one
// door — the Reviewer, whose template interpolates ${Approve}.
const FlywheelLive = AI.layer(Flywheel).pipe(
  Layer.provide([
    FixLive,
    AI.layer(Triage),
    AI.layer(Reviewer),
    AI.layer(ReleaseBlogger),
    AI.layer(Scribe),
  ]),
);
type FlywheelClosure =
  typeof FlywheelLive extends Layer.Layer<any, any, infer R> ? R : never;

type _fwl_approve = Assert<Has<FlywheelClosure, Approve>>;
type _fwl_channel = Assert<Has<FlywheelClosure, GitHubEvents>>;
type _fwl_bash = Assert<Has<FlywheelClosure, Bash>>;

// ─── Helpdesk: the support loop ──────────────────────────────────
// Perpetual, un-budgeted, Discord-facing.

type _hd_out = Assert<IsEqual<HelpdeskC["out"], never>>;
type _hd_err = Assert<IsEqual<HelpdeskC["err"], never>>;
type _hd_channel = Assert<Has<HelpdeskC["req"], DiscordEvents>>;
type _hd_support = Assert<Has<HelpdeskC["req"], Support>>;

const HelpdeskLive = AI.layer(Helpdesk).pipe(
  Layer.provide([AI.layer(Support), AI.layer(Scribe)]),
);
type HelpdeskClosure =
  typeof HelpdeskLive extends Layer.Layer<any, any, infer R> ? R : never;

// Support escalates to humans and files issues; it does not merge.
type _hdl_askHuman = Assert<Has<HelpdeskClosure, AskHuman>>;
type _hdl_createIssue = Assert<Has<HelpdeskClosure, CreateIssue>>;
type _hdl_no_approve = Assert<Not<Has<HelpdeskClosure, Approve>>>;

// ─── Autoresearch: the system loop ───────────────────────────────
// Observes Flywheel and Helpdesk; halts when a maintainer closes the
// experiment; proposes PRs it cannot merge.

type _ar_out = Assert<IsEqual<AutoresearchC["out"], void>>;
type _ar_in = Assert<IsEqual<AutoresearchC["in"], void>>; // cron-driven
type _ar_propose = Assert<Has<AutoresearchC["req"], OpenPullRequest>>;
type _ar_askHuman = Assert<Has<AutoresearchC["req"], AskHuman>>;

// THE constitutional constraint: observation grants trace access, not
// capabilities. Autoresearch studies the rings it improves without
// inheriting their tags — so no Layer composition, however creative, can
// route Approve (or Bash, or the Engineer) into its closure, because its
// Req never demands them.
type _ar_no_approve = Assert<Not<Has<AutoresearchC["req"], Approve>>>;
type _ar_no_engineer = Assert<Not<Has<AutoresearchC["req"], Engineer>>>;
type _ar_no_flywheel = Assert<Not<Has<AutoresearchC["req"], Flywheel>>>;
type _ar_no_bash = Assert<Not<Has<AutoresearchC["req"], Bash>>>;
type _ar_no_channels = Assert<
  Not<Has<AutoresearchC["req"], GitHubEvents | DiscordEvents>>
>;

// ─── cross-ring coupling audit ───────────────────────────────────
// Helpdesk → Flywheel coupling exists only through the world: Support
// holds CreateIssue (GitHub side effect) and Flywheel triggers on
// IssueOpened (GitHub event). Neither ring's Req contains the other.
type _no_ring_coupling_hd = Assert<Not<Has<HelpdeskC["req"], Flywheel>>>;
type _no_ring_coupling_fw = Assert<Not<Has<FlywheelC["req"], Helpdesk>>>;
