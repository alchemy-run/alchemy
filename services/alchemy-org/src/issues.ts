/**
 * The issue flywheel: {@link GitHubIssues} — resolves a GitHub issue end
 * to end (triage → pull request → review → merge), settled by the WORLD
 * closing the issue, never by the model's claim — plus
 * {@link GitHubIssuesLive}, the process's ONE implementation.
 *
 * Implementations own delivery (canon §5): this Layer is where
 * ingestion, dedupe, and the domain methods live. It is written against
 * three seams and NOTHING environmental — the environment is chosen
 * entirely at composition:
 *
 * - arrival:   `GitHub.RepositoryEventSource` (webhook on Cloudflare,
 *              polling on the laptop — one tag, two physics)
 * - dedupe:    {@link Ledger} (memory | sqlite | D1 — the database
 *              decides send-vs-steer, never instance memory)
 * - execution: `AI.Kernel` (in-process memory kernel locally; routing
 *              into the OrgRing Durable Object on Cloudflare)
 *
 * The charter's `AI.when` / `AI.exit` expressions encode INTERFACE only
 * — nothing in prose provisions anything.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as S from "effect/Schema";
import { Engineer, Reviewer } from "./agents.ts";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import { Comment, MergePullRequest, SearchIssues } from "./tools.ts";
import { IssueRef as IssueRefSchema } from "./vocabulary.ts";

// ─── the domain interface's types ──────────────────────────────────

export interface IssueRef {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

export interface IssueSnapshot extends IssueRef {
  readonly body: string;
  readonly state: string;
}

// ─── org-internal events (harness-bus deliverable; bare mention =
//     the publish grant) ────────────────────────────────────────────

/** Published when an issue is handed to engineering. */
export const EngineeringStarted = AI.Event(
  "org.engineering.started",
  IssueRefSchema,
);

/**
 * Published when work is blocked on a maintainer — the run parks on its
 * machine-observed exit right after.
 */
export const IssueParked = AI.Event(
  "org.issue.parked",
  S.Struct({
    owner: S.String,
    repository: S.String,
    number: S.Number,
    blocker: S.String,
  }),
);

// ─── the term: charter = the interface ─────────────────────────────

/**
 * One issue, one run: created when the issue opens, steered by its
 * comments, settled when GitHub closes it — the machine-observed exit
 * (`AI.exit(AI.when(IssueClosed(...)))`) correlates runs by the
 * source's natural key, so the charter never restates the plumbing.
 */
export class GitHubIssues extends AI.Process<
  GitHubIssues,
  {
    listIssues(): Effect.Effect<ReadonlyArray<IssueRef>>;
    getIssue(
      number: number,
    ): Effect.Effect<IssueSnapshot, GitHub.IssueNotFound>;
  }
>()("GitHubIssues")`
You resolve GitHub issues for the test-alchemy repository, from the
moment one opens until GitHub closes it.

${AI.when(GitHub.IssueOpened(testAlchemy))}, read it, then
${SearchIssues} for duplicates and prior discussion. If it is a
duplicate or a question you can answer, ${Comment} asking the reporter
to close it. Otherwise write acceptance criteria: a checklist
verifiable by a command or a test.

Hand the issue and its criteria to ${Engineer}, announcing
${EngineeringStarted} so the rest of the org sees the work moving.
The Engineer opens a pull request when the tests are green.

Ask ${Reviewer} to review that pull request against the issue. If the
review requests changes, send it back to ${Engineer} with the review
attached as new acceptance criteria. Once approved,
${MergePullRequest} — it refuses to merge without an approved review.

${AI.when(GitHub.IssueCommented(testAlchemy))}, read it and adjust:
a comment can change the criteria, unblock the work, or resolve the
issue outright.

If you are blocked on something only a maintainer can decide, publish
${IssueParked} naming what you need, and wait.

GitHub closing the issue is what ends this work — whether the merged
pull request closed it or a maintainer closed it by hand. You never
declare the issue done yourself.` {}

// ─── the ONE implementation ────────────────────────────────────────

/** The ledger queue this process admits into. */
const QUEUE = "issues";

/**
 * The implementation — generic over the seams; no environment anywhere
 * in it. The wire delivers TYPED events (webhook or poll, same union);
 * routing is a match; the ledger decides send-vs-steer transactionally
 * (a stateless, concurrent Worker and a laptop process run the
 * identical code); execution serialization is the kernel Layer's
 * physics.
 */
export const GitHubIssuesLive = Layer.effect(
  GitHubIssues,
  Effect.gen(function* () {
    const kernel = yield* AI.Kernel;
    const ledger = yield* Ledger;
    // the domain methods' physics: GitHub API bindings, bound ONCE to
    // the managed repository (the *Http layers are the environment's
    // choice at composition)
    const listIssues = yield* GitHub.ListIssues(testAlchemy);
    const getIssue = yield* GitHub.GetIssue(testAlchemy);

    // interpret() walks the charter's refs and resolves each tag from
    // the ambient context (this Layer's requirements): ${Engineer}
    // becomes a delegation tool, ${Comment}/${SearchIssues}/
    // ${MergePullRequest} become toolkit handlers. Splice in prose ⇒
    // tag in Req ⇒ Layer.provide; interpretation failure is a
    // mis-composed deployment — a defect, never a consumer error.
    const inner = yield* kernel.interpret(GitHubIssues).pipe(Effect.orDie);

    // It's just routing.
    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      { events: ["issues", "issue_comment"] },
      (event) =>
        Match.value(event).pipe(
          // the machine exit: GitHub closed the issue — exit delivery is
          // delivery; hand the event to the run by its world key
          Match.tag("IssueClosed", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              yield* ledger.settle(QUEUE, key);
              yield* Effect.log(`[issues] settled ${key} (issue closed)`);
              yield* inner.settle(key, event);
            }),
          ),
          // first sighting of an issue creates its run (the ledger
          // decides, transactionally — redeliveries and poll
          // re-observations collapse); everything later steers it
          Match.tag("IssueOpened", "IssueCommented", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              const { status } = yield* ledger.offer(QUEUE, key, event);
              yield* Effect.log(`[issues] ${status} ${key}`);
              yield* status === "accepted"
                ? inner.send(event, { key })
                : inner.steer(key, event);
            }),
          ),
          // labeled etc.: not this process's message — denial-by-skip
          Match.orElse(() => Effect.void),
        ),
    );

    // the declared interface is the WHOLE service (the tag is sealed):
    // the actor verbs stay internal — delivery goes through the drive
    // loop above, never around the ledger
    return {
      // wire failures that aren't domain answers (network, auth) are
      // defects here — the interface deliberately declares no
      // wire-error channel
      listIssues: () =>
        listIssues({ state: "open", per_page: 100 }).pipe(
          Effect.map((issues) =>
            issues
              // the REST issues list includes pull requests; the issues
              // desk lists issues
              .filter((issue) => issue.pull_request === undefined)
              .map((issue) => ({
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
              })),
          ),
          Effect.orDie,
        ),

      getIssue: (number: number) =>
        getIssue({ issue_number: number }).pipe(
          Effect.map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            body: issue.body ?? "",
            state: issue.state,
          })),
          Effect.catchTag("GitHub.ApiError", (error) => Effect.die(error)),
        ),
    };
  }),
);
