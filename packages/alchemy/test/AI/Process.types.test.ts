/**
 * Type-level tests for the AI term language (design §1):
 *
 * - refs interpolated in Agent/Process templates flow into `Req`
 * - nested control-ref templates (`AI.until`, `AI.check`, `AI.fold`) flow through
 * - capability denial by omission: an un-interpolated tool never appears in `Req`
 * - unhalted charters are typed perpetual (`Out = never`), not rejected
 * - channel derivation: `Out` from the halt, `In` from the triggers,
 *   `Err` from the budget
 *
 * These assertions are purely type-level; the runtime tests just confirm
 * the terms are constructible pure data.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as AI from "@/AI/index.ts";

// ─── vocabulary ──────────────────────────────────────────────────

const IssueRef = S.Struct({ repo: S.String, number: S.Number });
const PrRef = S.Struct({ repo: S.String, number: S.Number, url: S.String });

const issue = AI.Parameter("issue", IssueRef)`
A reference to a GitHub issue in one of our repos.`;

const path = AI.Parameter("path", S.String)`
An absolute path to a file in the repository.`;

const pattern = AI.Parameter("pattern", S.String)`
A regular expression to search for.`;

// ─── tools — interfaces; physics comes later ─────────────────────

class Grep extends AI.Tool<Grep>()("grep")`
Search the repository for ${pattern}.` {}
class ReadFile extends AI.Tool<ReadFile>()("readFile")`
Read the file at ${path}.` {}
class EditFile extends AI.Tool<EditFile>()("editFile")`
Edit the file at ${path}.` {}
class Bash extends AI.Tool<Bash>()("bash")`
Run a shell command in the sandbox.` {}
class SearchIssues extends AI.Tool<SearchIssues>()("searchIssues")`
Search GitHub issues for ${pattern}.` {}
class CreateIssue extends AI.Tool<CreateIssue>()("createIssue")`
File a new ${issue}.` {}
class Reply extends AI.Tool<Reply>()("reply")`
Reply on the current surface (Discord thread / GitHub PR).` {}
class Approve extends AI.Tool<Approve>()("approve")`
Request approval to merge.` {}
class AskHuman extends AI.Tool<AskHuman>()("askHuman")`
Escalate a question to a human maintainer.` {}

// ─── agents — prose that hires tools ─────────────────────────────

class Engineer extends AI.Agent<Engineer>()("Engineer")`
You receive exactly one ${issue}. ${Grep} before you ${ReadFile};
${ReadFile} before you ${EditFile}. ${Bash} runs the tests after
every edit — all green is the only definition of done you may use.` {}

class Scribe extends AI.Agent<Scribe>()("Scribe")`
Distill traces into durable artifacts via ${CreateIssue}.` {}

class Triage extends AI.Agent<Triage>()("Triage")`
For each new ${issue}: dedupe via ${SearchIssues}.` {}

class Reviewer extends AI.Agent<Reviewer>()("Reviewer")`
Review PRs. Verdict via ${Approve} or changes via ${Reply}.` {}

// the positional verifier — grades work it did not do; note the toolbox
// includes SearchIssues, which nothing else in Fix holds
class Judge extends AI.Agent<Judge>()("Judge")`
Verify criteria mechanically: ${Bash} to run the suite yourself,
${SearchIssues} to confirm the issue's criteria are all addressed.` {}

// ─── event sources ───────────────────────────────────────────────

const IssueOpened = AI.EventSource("github.issue.opened", IssueRef);
const IssueLabeled = AI.EventSource(
  "github.issue.labeled",
  S.Struct({ repo: S.String, label: S.String }),
);
const PullRequestOpened = AI.EventSource(
  "github.pull_request.opened",
  IssueRef,
);
const ThreadCreated = AI.EventSource(
  "discord.thread.created",
  S.Struct({ channel: S.String, thread: S.String }),
);

// ─── loops — charters with typed control refs ────────────────────

// the task loop — schema'd `until` (typed Out), `each` (typed In), budget (Err)
class Fix extends AI.Process<Fix>()("Fix")`
One issue, one loop, one task per iteration.

${AI.each(issue)} give ${Engineer} a completely fresh context:
the issue, its criteria, CONTRIBUTING.md, and .alchemy/NOTES.md.

${AI.until(PrRef)`every criterion is checked and ${Bash} reports
the full suite green — the agent's claim of done-ness is not a
signal; resolve with the PR the Engineer opened`}

${AI.check(Judge)`grade each iteration; an off-goal verdict becomes
the next iteration's first input`}

${AI.fold(Scribe)`distill lessons into .alchemy/NOTES.md after
every iteration, successful or not`}

${AI.budget({ tokens: "5M", wallClock: "2h", iterations: 12, stall: 3 })}` {}

// the product loop — perpetual, nests Fix, never-halt with a nested ref
class Flywheel extends AI.Process<Flywheel>()("Flywheel")`
The development flywheel for alchemy-run repos.

${AI.on(IssueOpened, IssueLabeled)} run ${Triage}, then dispatch a
${Fix} run when ready — at most ${AI.concurrency(3)} in flight,
smallest estimates first.

${AI.on(PullRequestOpened)} assign ${Reviewer}.

${AI.on(ThreadCreated)} watch support surfaces via ${SearchIssues}.

${AI.never`no exit; merge rate, time-to-first-response, and reopen
rate are folded weekly and posted via ${Reply} to #maintainers`}

${AI.fold(Scribe)`weekly: cluster threads; the top recurring
confusion becomes a docs issue via ${CreateIssue}`}` {}

// the system loop — observes Flywheel without inheriting its Req
class Autoresearch extends AI.Process<Autoresearch>()("Autoresearch")`
${AI.every("1 week")} study the traces of ${AI.observe(Flywheel)};
you may ${AI.observe(Scribe)}'s folds too. Escalate via ${AskHuman}.

${AI.until`a maintainer closes the experiment`}` {}

// ─── type-level assertions ───────────────────────────────────────

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

type FixC = ChannelsOf<typeof Fix>;
type FlywheelC = ChannelsOf<typeof Flywheel>;
type AutoresearchC = ChannelsOf<typeof Autoresearch>;

// ── Req: interpolation contributes the ref's *tag* ──

// delegation contributes the agent's tag — its toolbox is the agent
// layer's requirement, eliminated by Layer.provide (per-agent physics)
type _fix_engineer = Assert<Has<FixC["req"], Engineer>>;
type _fix_no_grep = Assert<Not<Has<FixC["req"], Grep>>>;
// nested `until` template ref flows through (the load-bearing trick)
type _fix_bash = Assert<Has<FixC["req"], Bash>>;
// fold and check contribute their agents' tags, not their tools
type _fix_scribe = Assert<Has<FixC["req"], Scribe>>;
type _fix_no_createIssue = Assert<Not<Has<FixC["req"], CreateIssue>>>;
type _fix_judge = Assert<Has<FixC["req"], Judge>>;
type _fix_no_searchIssues = Assert<Not<Has<FixC["req"], SearchIssues>>>;
// capability denial by omission: Fix never mentions Approve or AskHuman
type _fix_no_approve = Assert<Not<Has<FixC["req"], Approve>>>;
type _fix_no_askHuman = Assert<Not<Has<FixC["req"], AskHuman>>>;

// nesting a Process contributes the inner loop's tag
type _fw_fix = Assert<Has<FlywheelC["req"], Fix>>;
type _fw_triage = Assert<Has<FlywheelC["req"], Triage>>;
type _fw_reviewer = Assert<Has<FlywheelC["req"], Reviewer>>;
// the Reviewer's Approve is the Reviewer layer's business, not Flywheel's
type _fw_no_approve = Assert<Not<Has<FlywheelC["req"], Approve>>>;
// nested ref inside the `never` halt template
type _fw_reply = Assert<Has<FlywheelC["req"], Reply>>;
// nested ref inside the fold template
type _fw_createIssue = Assert<Has<FlywheelC["req"], CreateIssue>>;

// Layer level: the transitive closure is Layer composition — providing
// the agents' layers eliminates their tags and surfaces their toolboxes
const FixLive = AI.layer(Fix).pipe(
  Layer.provide([AI.layer(Engineer), AI.layer(Judge), AI.layer(Scribe)]),
);
type FixClosure =
  typeof FixLive extends Layer.Layer<any, any, infer R> ? R : never;
type _fixl_grep = Assert<Has<FixClosure, Grep>>;
type _fixl_searchIssues = Assert<Has<FixClosure, SearchIssues>>;
type _fixl_kernel = Assert<Has<FixClosure, AI.Kernel>>;
type _fixl_no_engineer = Assert<Not<Has<FixClosure, Engineer>>>;
type _fixl_no_approve = Assert<Not<Has<FixClosure, Approve>>>;

// observation does NOT propagate anything: Autoresearch sees Flywheel's
// traces but gains neither its tag nor its capabilities
type _ar_no_flywheel = Assert<Not<Has<AutoresearchC["req"], Flywheel>>>;
type _ar_no_approve = Assert<Not<Has<AutoresearchC["req"], Approve>>>;
type _ar_no_engineer = Assert<Not<Has<AutoresearchC["req"], Engineer>>>;
type _ar_askHuman = Assert<Has<AutoresearchC["req"], AskHuman>>;

// ── Out: derived from the halt ──

// AI.until(schema) → the schema's type
type _fix_out = Assert<
  IsEqual<
    FixC["out"],
    { readonly repo: string; readonly number: number; readonly url: string }
  >
>;
// AI.never → never (the ring's run is an Effect<never, …>)
type _fw_out = Assert<IsEqual<FlywheelC["out"], never>>;
// bare AI.until → void
type _ar_out = Assert<IsEqual<AutoresearchC["out"], void>>;

// ── In: derived from the triggers ──

// AI.each(issue) → the parameter's schema type
type _fix_in = Assert<
  IsEqual<FixC["in"], { readonly repo: string; readonly number: number }>
>;
// AI.every → void
type _ar_in = Assert<IsEqual<AutoresearchC["in"], void>>;
// AI.on × 4 → union of the event schemas
type _fw_in_issue = Assert<
  Has<FlywheelC["in"], { readonly repo: string; readonly number: number }>
>;
type _fw_in_label = Assert<
  Has<FlywheelC["in"], { readonly repo: string; readonly label: string }>
>;

// ── Err: derived from the budget and the halt ──

// budget → BudgetExceeded; bounded exit (until) → Refused (a run may
// conclude its goal is unachievable — neither success nor exhaustion)
type _fix_err = Assert<IsEqual<FixC["err"], AI.BudgetExceeded | AI.Refused>>;
// perpetual + unbudgeted → nothing to exhaust, nothing to give up on
type _fw_err = Assert<IsEqual<FlywheelC["err"], never>>;

// ── dispatch is typed end-to-end ──

type _dispatch_in = Assert<
  IsEqual<
    Parameters<Fix["dispatch"]>[0],
    { readonly repo: string; readonly number: number }
  >
>;

// ── unhalted charters are typed as perpetual, not rejected ──
// (mirrors Effect's data flow: construction is total; the missing exit
// signal makes the loop's runs Effect<never, …>, and the Kernel lints
// undeclared perpetuity at interpretation time)

class NoHalt extends AI.Process<NoHalt>()("NoHalt")`
${AI.each(issue)} run ${Engineer} forever, unsupervised.` {}

type _nohalt_out = Assert<IsEqual<ChannelsOf<typeof NoHalt>["out"], never>>;

// a Process with a halt but no trigger still compiles (triggers not required)
class Idle extends AI.Process<Idle>()("Idle")`
Do nothing. ${AI.never`a perpetual no-op ring`}` {}

// ─── runtime: terms are constructible pure data ──────────────────

describe("AI term language", () => {
  it("Process terms are pure data", () => {
    expect(Fix["~alchemy/Kind"]).toBe("Process");
    expect(Fix["~alchemy/Name"]).toBe("Fix");
    expect(Fix.refs.some(AI.isHalt)).toBe(true);
    expect(Fix.refs.some(AI.isFold)).toBe(true);
    expect(Fix.refs.some(AI.isTrigger)).toBe(true);
    expect(Fix.refs.some(AI.isBudget)).toBe(true);
  });

  it("control refs carry their nested templates and refs", () => {
    const halt = Fix.refs.find(AI.isHalt)!;
    expect(halt.mode).toBe("until");
    expect(halt.schema).toBe(PrRef);
    expect(halt.refs).toContain(Bash);

    const fold = Flywheel.refs.find(AI.isFold)!;
    expect(fold.agent).toBe(Scribe);
    expect(fold.refs).toContain(CreateIssue);

    const triggers = Flywheel.refs.filter(AI.isTrigger);
    expect(triggers).toHaveLength(3);
    expect(triggers[0]!.mode).toBe("on");
    // variadic on: one trigger subscribing to two event sources
    expect(triggers[0]!.sources).toHaveLength(2);
    expect((triggers[0]!.sources[0] as AI.EventSource)["~alchemy/Name"]).toBe(
      "github.issue.opened",
    );
  });

  it("halts distinguish until from never", () => {
    const halt = Flywheel.refs.find(AI.isHalt)!;
    expect(halt.mode).toBe("never");
    expect(halt.refs).toContain(Reply);
  });

  it("observe refs carry their subject without granting capabilities", () => {
    const observed = Autoresearch.refs.filter(AI.isObserve);
    expect(observed.map((o) => o.subject)).toContain(Flywheel);
  });

  it("bare folds fall back to the agent's own template", () => {
    const bare = AI.fold(Scribe);
    expect(bare.template).toBeUndefined();
    expect(bare.agent).toBe(Scribe);
    const templated = AI.fold(Scribe)`with instructions`;
    expect(templated.template).toBeDefined();
  });

  it("checks assign a verifier distinct from the fold", () => {
    const check = Fix.refs.find(AI.isCheck)!;
    expect(check.agent).toBe(Judge);
    const fold = Fix.refs.find(AI.isFold)!;
    expect(fold.agent).toBe(Scribe);
    // bare and templated forms, like fold
    const bare = AI.check(Judge);
    expect(bare.template).toBeUndefined();
    expect(bare.agent).toBe(Judge);
  });

  it("terms are Context tags with stable keys", () => {
    expect((Engineer as any).key).toBe("alchemy/AI/Agent/Engineer");
    expect((Fix as any).key).toBe("alchemy/AI/Process/Fix");
  });
});

// ─── lint: charter cardinality & coherence ───────────────────────

describe("AI.lint", () => {
  it("well-formed goal charters are clean", () => {
    expect(AI.lint(Fix)).toEqual([]);
  });

  it("a perpetual coordinator with fold + delegates is flagged (§D doctrine)", () => {
    // Flywheel is the pre-split perpetual-LLM-coordinator: AI.never with
    // a fold and agent delegates. The doctrine says this should be a
    // deterministic server dispatching goal runs — warned, not errored,
    // until the fixture migrates.
    expect(
      AI.lint(Flywheel)
        .map((issue) => issue.code)
        .sort(),
    ).toEqual(["perpetual-fold", "perpetual-multistep"]);
  });

  it("undeclared perpetuity is a warning; explicit AI.never is not", () => {
    expect(AI.lint(NoHalt).map((issue) => issue.code)).toEqual([
      "undeclared-perpetuity",
    ]);
    expect(AI.lint(Idle)).toEqual([]);
  });

  it("a bounded exit without a budget is a soft runaway", () => {
    expect(AI.lint(Autoresearch).map((issue) => issue.code)).toEqual([
      "unbounded-until",
    ]);
  });

  it("duplicate positional refs are errors", () => {
    class TwoBudgets extends AI.Process<TwoBudgets>()("TwoBudgets")`
    ${AI.never`perpetual`} ${AI.budget({ usd: "1" })}
    ${AI.budget({ usd: "2" })}` {}
    expect(AI.lint(TwoBudgets)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "multiple-budgets" }),
    );
  });

  it("until + never is a contradiction", () => {
    class Confused extends AI.Process<Confused>()("Confused")`
    ${AI.until`done`} ${AI.never`also forever?`}
    ${AI.budget({ usd: "1" })}` {}
    expect(AI.lint(Confused)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "conflicting-halts" }),
    );
  });
});
