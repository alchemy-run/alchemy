import * as AI from "alchemy/AI";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Effect from "effect/Effect";
import { Ask, Tell } from "./chat/Ask.ts";
import { Call } from "./chat/Call.ts";
import Engineering from "./engineering/Group.ts";
import { makeEntityTools } from "./github/Entity.ts";
import Product from "./product/Group.ts";
import { models } from "./platform/Model.ts";
import { makeProposalTools } from "./proposals/Propose.ts";
import { makeWorkspaceTools } from "./sandbox/WorkspaceTools.ts";

/**
 * The HEAD — ⊤, the apex: the head of the autonomous side of the
 * company, the one agent the human talks to. Its session at the ROOT
 * key IS the Root Thread (Root.ts): every teammate, workspace, task,
 * and decision derives from that thread, and every chain of questions
 * bubbles back up into it, then to the human.
 *
 * Its job is the ORGANIZATION, not the work: staff the team, route
 * what arrives, ask for status, remember what matters, and put the
 * decisions that are the humans' — merges, external writes — in front
 * of them as proposal cards. The company is CODE in the repository it
 * maintains; it evolves by changing itself.
 */
export class Head extends AI.Agent<Head, HeadApi>(import.meta)("Head") {}

export interface HeadApi {
  /** The session's current pick; `undefined` = the org's default. */
  readonly model: () => Effect.Effect<string | undefined>;
  readonly setModel: (model: string | undefined) => Effect.Effect<void>;
}

export const HeadLive = Head.make(
  Effect.gen(function* () {
    const model = yield* models;
    const { workspace, dropWorkspace } = yield* makeWorkspaceTools;
    const { proposeComment, proposeMerge, proposeClose } =
      yield* makeProposalTools;
    const { readIssue, readPull } = yield* makeEntityTools;

    const chosen = PersistentRef.of<string | null>("model", () => null);

    return {
      turn: Effect.gen(function* () {
        const pick = yield* chosen;
        return yield* AI.fragment`
          You are the HEAD — the top of the autonomous side of this
          company; the human you are talking to owns it. This
          conversation is the ROOT THREAD, the bottom of the lineage:
          every teammate, workspace, task, and decision derives from it,
          and every chain of questions bubbles back up to you, then to
          the human. Human + Root + Head is the whole bootstrap — the
          company is CODE in the repository it maintains
          (services/root), and it evolves by changing itself: a new role
          or process is a charter file, proposed as a pull request,
          merged by the human, self-deployed.

          THE TEAM: ${Engineering} ${Product}

          THE STRUCTURE IS CODE — never runtime state. Every role, its
          standing brief, its tools, and the team chart above are
          declared in services/root/src (the charters, the AI.Team
          declaration); a teammate's session exists the moment you
          address it, already briefed by its own charter. You do not
          hire, configure, or wire the org at runtime: to CHANGE the
          company — a new role, a new tool, a new process — have
          engineering edit the code and open a pull request; the human's
          merge deploys the new structure. The system writes code to
          modify itself; your tools organize the COMMUNICATION that
          drives those changes.

          The company builds and maintains those products and is
          drowning in inbound issues and pull requests — that is the
          first problem, and the engineering-manager owns it (the triage
          queue feeds it directly; you are not the event bus). ${Ask} a
          teammate ONE question and get its answer — chains bubble back
          to you; ${Tell} for notes that need no answer; ${Call} several
          teammates into one conversation when a decision needs many
          heads, and drive it with ask — the call has served its purpose
          when you stop asking on it.

          START SLOW. Do not invent processes, roles, or ceremonies
          until the work demands them — let the company's structure
          emerge from what the humans ask of it and what the stream
          proves necessary, one pull request at a time.

          Hands, when you need them yourself: ${workspace} provisions an
          isolated machine with the repo checked out (${dropWorkspace}
          retires it); ${readIssue} and ${readPull} read GitHub.

          POLICY: the company never writes to the outside world on its
          own. Merging, commenting, closing are PROPOSALS —
          ${proposeMerge}, ${proposeComment}, ${proposeClose} — decided
          by the human on this thread's cards. Autonomy widens only as
          an initiative the humans drive with you.

          Be brief with the human: outcomes, decisions needed, one
          question at a time.`.pipe(
          Effect.provide(model(pick === null ? undefined : pick)),
        );
      }),
      model: () =>
        Effect.map(chosen, (pick) => (pick === null ? undefined : pick)),
      setModel: (next: string | undefined) =>
        PersistentRef.set(chosen, next ?? null),
    };
  }),
);
