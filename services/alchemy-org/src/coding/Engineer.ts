import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import { DistilledGuidance } from "../process/DistilledGuidance.ts";
import { FlociGuidance } from "../process/FlociGuidance.ts";
import { ProviderGuidance } from "../process/ProviderGuidance.ts";
import { PullRequests } from "../process/PullRequests.ts";
import { Verification } from "../process/Verification.ts";
import { OrgGuidance } from "../OrgGuidance.ts";
import { ReadOutput } from "../artifacts/ReadOutput.ts";
import { SessionRepo } from "../github/SessionRepo.ts";
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
 * - {@link Engineer}     — the agent: a bare tag.
 * - {@link GeneralEngineer} — the GENERAL implementation of the agent: the
 *   stance and the toolkit it
 *   mentions (mention-is-presence — these ten tools ARE the agent's
 *   capability envelope; publishing stops at the pull request — there
 *   is no merge button).
 */
export class Engineer extends AI.Agent<Engineer>(import.meta)("Engineer") {}

export const GeneralEngineer = Engineer.make(
  Effect.gen(function* () {
    // ── INIT: once per chat ──────────────────────────────────────────
    const thread = yield* AI.Thread;
    const repo = yield* SessionRepo;

    // Session keys are `<owner>/<repo>/<name>` — the prefix picks the
    // session's repository from the STATIC connected list (Repos.ts);
    // a PULL REQUEST session is keyed `<owner>/<repo>#<n>` and works in
    // the PR's head (github/SessionRepo.ts). INIT only READS which
    // tree that is, for the stance's prose — it touches no machine.
    // The tree itself lands the first time a tool reaches for it
    // (sandbox/SandboxCheckout.ts): a reply that needs no tool needs
    // no machine, and the wait shows on the tool that does. A GitHub
    // hiccup here costs the PR prose, never the session.
    const tree = yield* repo
      .resolve(thread.key)
      .pipe(
        Effect.catch((reason) =>
          Effect.as(
            Effect.logWarning(`Engineer INIT: tree unresolved — ${reason}`),
            undefined,
          ),
        ),
      );
    const workspace = tree?.repo ?? "the alchemy repository";
    const pull = tree?.pull;

    // the PR clause of the stance — a nested fragment so its PushBranch
    // mention counts (mention-is-presence rides splices, not strings)
    const subject =
      pull === undefined
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

    // ── the STANCE: re-rendered before every sampling ────────────────
    return AI.fragment`
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

      Publish when the operator asks: commit your work (bash: git
      add / git commit with a conventional-commit message), push it
      with ${PushBranch} (a topic branch, never a protected one),
      then PROPOSE the pull request with ${OpenPullRequest}. Nothing
      you propose reaches GitHub on its own: the operator accepts or
      declines each proposal in the UI, and you learn the outcome
      here. Publishing stops at the proposal — merging is the
      operator's act. Every pull request you propose is reviewed
      against the standard below — write toward it from the first
      line, not after the review asks.

      ${PullRequests}

      Doctrine is pluggable — activate what the work touches before
      you change anything, and no more. A provider (a resource, a
      binding, a lifecycle rule under packages/alchemy/src) is held to
      ${ProviderGuidance}; the repository is one unit with two others,
      and the work usually crosses into them: ${DistilledGuidance} for
      the SDK (a typed error, a patched schema, the companion pull
      request and its pin) and ${FlociGuidance} for an AWS resource's
      local emulation. A change to services/alchemy-org — the
      harness you are running in — is held to ${OrgGuidance}, which
      names the domain skills beneath it; it is the same text a human
      coding agent reads in that folder's AGENTS.md.

      This chat (${thread.key}) is long-lived: the operator returns
      to it across days. When a task completes, say so plainly and
      stop; when you are blocked on a decision only the operator can
      make, ask the question and park.`;
  }),
);
