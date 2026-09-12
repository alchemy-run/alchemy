import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { assignedTree } from "../sandbox/SessionTree.ts";
import { Message } from "../thread/Message.ts";
import { threadOf } from "../thread/Terms.ts";
import { Distillation } from "../process/Distillation.ts";
import { AwsEmulation } from "../process/AwsEmulation.ts";
import { CloudflareEmulation } from "../process/CloudflareEmulation.ts";
import { ProviderEngineering } from "../process/ProviderEngineering.ts";
import { PullRequests } from "../process/PullRequests.ts";
import { Verification } from "../process/Verification.ts";
import { OrgGuidance } from "../OrgGuidance.ts";
import { ReadOutput } from "../artifacts/ReadOutput.ts";
import { SessionRepo } from "../github/SessionRepo.ts";
import { models } from "../platform/Model.ts";
import { Bash } from "./Bash.ts";
import { EditFile } from "./EditFile.ts";
import { Glob } from "./Glob.ts";
import { Grep } from "./Grep.ts";
import { ListDirectory } from "./ListDirectory.ts";
import { OpenPullRequest } from "./OpenPullRequest.ts";
import { PushBranch } from "./PushBranch.ts";
import { ReadFile } from "./ReadFile.ts";
import { WriteFile } from "./WriteFile.ts";

export default import.meta.url;

/**
 * The CODER — a generic coding agent, the whole product in one file:
 *
 * ONE agent, one durable session per chat. You talk to it through the
 * web UI; each session gets its OWN sandbox container (the circular
 * org image — the alchemy repo checked out, installed, compiled), and
 * the agent reads, searches, runs, and edits that tree. Sessions are
 * Durable Objects: the thread and the board survive everything, and
 * the stance is re-rendered every tick — so improving this agent is
 * editing this file and redeploying.
 *
 * - {@link Engineer}     — the agent: its tag and its CONTRACT — the
 *   methods every session answers to (`model`/`setModel`: the catalog
 *   id it samples with, set by the operator's selector or by the
 *   owning thread handing down its own pick).
 * - {@link GeneralEngineer} — the GENERAL implementation of the agent: the
 *   stance and the toolkit it
 *   mentions (mention-is-presence — these ten tools ARE the agent's
 *   capability envelope; publishing stops at the pull request — there
 *   is no merge button).
 */
export class Engineer extends AI.Agent<Engineer, EngineerApi>(import.meta)(
  "Engineer",
) {}

/** An engineer session's methods — what `engineer.at(key)` answers. */
export interface EngineerApi {
  /** The session's current pick; `undefined` = the org's default. */
  readonly model: () => Effect.Effect<string | undefined>;
  /** Choose the model the session samples with from its next
   *  sampling on; `undefined` returns to the org's default. Nothing
   *  in flight is interrupted. */
  readonly setModel: (model: string | undefined) => Effect.Effect<void>;
  /** Hand the session an EXISTING tree on its machine — the key of a
   *  `Git.Checkouts` checkout its owner made (a thread's worktree for
   *  the pull request the brief is about). From the first tool call
   *  on, the session's shell, file tools, and terminal are rooted
   *  there (`SandboxCheckout`); `undefined` returns the session to the
   *  tree its key derives. Set BEFORE the brief. */
  readonly setTree: (key: string | undefined) => Effect.Effect<void>;
}

export const GeneralEngineer = Engineer.make(
  Effect.gen(function* () {
    // ── the CHARTER: one Effect, run once where the Layer builds. What
    // it declares — the catalog, the repo resolver, the ten tools the
    // stance mentions — is the agent's, shared by every session. There
    // is no session here; turns and methods read theirs from the frame.
    const model = yield* models;
    const repo = yield* SessionRepo;
    const checkouts = yield* Git.Checkouts;

    // the session's own pick — a DECLARED durable cell, born at the
    // default, rewritten by `setModel` (the operator's selector, or a
    // thread handing its engineer its pick before the brief); it
    // resolves to the calling session's row in whichever turn or method
    // touches it. `null` is "the default" (a cleared choice must
    // round-trip through storage, and undefined does not).
    const chosen = PersistentRef.of<string | null>("model", () => null);

    // ── the STANCE: re-rendered before every sampling, for the session
    // sampling. Session keys are `<owner>/<repo>/<name>` — the prefix
    // picks the session's repository from the STATIC connected list
    // (Repos.ts); a PULL REQUEST session is keyed `<owner>/<repo>#<n>`
    // and works in the PR's head (github/SessionRepo.ts). The stance
    // only READS which tree that is, for its prose — it touches no
    // machine (the resolver memoizes per session, so this is one
    // GitHub call per session, not per tick). The tree itself lands the
    // first time a tool reaches for it (sandbox/SandboxCheckout.ts): a
    // reply that needs no tool needs no machine, and the wait shows on
    // the tool that does. A GitHub hiccup here costs the PR prose,
    // never the session.
    const stance = Effect.gen(function* () {
      const thread = yield* AI.Thread;
      const tree = yield* repo
        .resolve(thread.key)
        .pipe(
          Effect.catch((reason) =>
            Effect.as(
              Effect.logWarning(`Engineer: tree unresolved — ${reason}`),
              undefined,
            ),
          ),
        );
      const workspace = tree?.repo ?? "the alchemy repository";
      const pull = tree?.pull;

      // a tree HANDED to the session (a thread's worktree for one pull
      // request) — its shell and tools are rooted there; the stance
      // names it so the model never reaches for another
      const handedKey = yield* assignedTree;
      const handedTree =
        handedKey === null
          ? undefined
          : Option.getOrUndefined(yield* checkouts.get(handedKey));
      const manager = threadOf(thread.key);

      // the PR clause of the stance — a nested fragment so its PushBranch
      // mention counts (mention-is-presence rides splices, not strings)
      const subject =
        handedTree !== undefined
          ? AI.fragment`
            Your tree is the worktree at ${handedTree.path}, on the
            branch ${handedTree.branch} — the thread's checkout for the
            pull request your brief is about. Your shell, your file
            tools, and your terminal all start THERE, and there is the
            only place you work: never cd out of it, never touch
            another checkout or worktree on this machine, never run
            git checkout / git switch / gh pr checkout — the branch is
            already the right one. Commit on it and push it back with
            ${PushBranch} as "${handedTree.branch}" so the work lands
            in the pull request itself.`
          : pull === undefined
            ? AI.fragment``
            : pull.ref === pull.head
              ? AI.fragment`
            This session is about pull request #${pull.number} of
            ${workspace} — "${pull.title}" by ${pull.author}, merging
            ${pull.head} into ${pull.base}. Your tree IS the pull
            request's head, checked out on the branch ${pull.head}:
            commit fixes there and push them back with ${PushBranch} as
            "${pull.head}" so they land in the pull request itself.`
              : AI.fragment`
            This session is about pull request #${pull.number} of
            ${workspace} — "${pull.title}" by ${pull.author}, merging
            ${pull.head} (a fork) into ${pull.base}. Your tree IS the
            pull request's head, checked out read-only as ${pull.ref};
            publish fixes as a new branch and pull request.`;

      return yield* AI.fragment`
      You are a coding agent working in a checkout of ${workspace}
      on your own machine — the operator's pair of hands in
      this codebase. The operator reads your work in a chat UI; be
      direct, lead with the outcome, and keep prose tight.
      ${subject}

      Explore before you conclude: ${Grep} finds content, ${Glob}
      finds files, ${ListDirectory} shows shape. Read with
      ${ReadFile} — whole regions at once, not tiny slices; its
      digest is your proof of the version you read. When output gets
      truncated, ${ReadOutput} pages the rest.

      Verify with ${Bash}: run the tests, the typechecker, the build.
      Claims about behavior are checked by RUNNING, never asserted
      from reading. The test suite is the only oracle of done-ness;
      ${Verification} names the repository's own commands and what
      counts as evidence.

      Author with ${EditFile} (exact-string edits against the version
      you read) and ${WriteFile} (whole files). Read before you
      write; prefer the smallest change that works well; never leave
      the tree broken — typecheck and test what you touched.

      Publish when the work is ready: commit it (bash: git add / git
      commit with a conventional-commit message), push it with
      ${PushBranch} (a topic branch — or the pull request's own head
      branch when the session is about one), then OPEN the pull
      request with ${OpenPullRequest} — it lands on GitHub
      immediately and the answer carries its URL. Merging stays the
      operator's act on GitHub. Every pull request you open is held
      to the standard below — write toward it from the first line.

      ${PullRequests}

      Doctrine is pluggable — activate what the work touches before
      you change anything, and no more. A provider (a resource, a
      binding, a lifecycle rule under packages/alchemy/src) is held to
      ${ProviderEngineering}. Coverage of a cloud is produced by
      ${Distillation} — build, test live, feed every SDK mismatch back
      into distilled as a patch, regenerate, test again, ship both
      pull requests — and a resource is finished locally by its
      emulation: ${AwsEmulation} in floci for AWS,
      ${CloudflareEmulation} over the in-tree workerd runtime for
      Cloudflare. A change to services/alchemy-org — the harness you
      are running in — is held to ${OrgGuidance}, which
      names the domain skills beneath it; it is the same text a human
      coding agent reads in that folder's AGENTS.md.

      ${
        manager === undefined
          ? AI.fragment`
      This chat (${thread.key}) is long-lived: the operator returns
      to it across days. When a task completes, say so plainly and
      stop; when you are blocked on a decision only the operator can
      make, ask the question and park.`
          : AI.fragment`
      You are one agent of thread ${manager}, working a brief its
      MANAGER gave you; the manager and your fellow engineers are one
      ${Message} away — "manager" or an agent's key as the recipient.
      Message the manager when you are blocked on something only it
      or the operator can decide, and when a sibling's work bears on
      yours; a message arrives in the recipient's own conversation.
      When your brief is done, say so plainly — your final reply IS
      the report the manager reads — and stop.`
      }`;
    });

    // ── the OBJECT: the turn plus the methods. The turn provides the
    // session's pick to the stance before every sampling (the one
    // per-tick choice); the methods are how the outside changes it —
    // over the stub, inside the session's frame.
    return {
      turn: Effect.gen(function* () {
        const pick = yield* chosen;
        return yield* stance.pipe(
          Effect.provide(model(pick === null ? undefined : pick)),
        );
      }),
      model: () =>
        Effect.map(chosen, (pick) => (pick === null ? undefined : pick)),
      setModel: (next: string | undefined) =>
        PersistentRef.set(chosen, next ?? null),
      setTree: (key: string | undefined) =>
        PersistentRef.set(assignedTree, key ?? null),
    };
  }),
);
