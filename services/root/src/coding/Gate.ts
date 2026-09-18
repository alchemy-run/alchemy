import * as AI from "alchemy/AI";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  Proposals,
  type Proposal,
  type ProposalPayload,
} from "../proposals/Proposals.ts";

/**
 * The HUMAN GATE on an engineer's external writes. A gated tool call
 * does not act: it stages a PROPOSAL (proposals/Proposals.ts) — the
 * tool result carries it, the Root Thread renders the card — and fails
 * with {@link StagedForApproval}; the agent parks on it. The human's
 * Approve steers the agent to retry; the retry finds the approved
 * grant here and goes through (marking it executed). Policy
 * (`Proposals.setPolicy`) can open a kind back up to direct action —
 * the humans' explicit act, never a default.
 */

export class StagedForApproval extends Data.TaggedError("StagedForApproval")<{
  message: string;
}> {}

/** What a granted check hands back: bookkeeping for after the act. */
export interface Grant {
  /** `undefined` = the kind is ungated (no bookkeeping owed). */
  readonly proposal: Proposal | undefined;
  /** Mark the grant executed — call after the act. */
  readonly executed: (outcome: string) => Effect.Effect<void>;
}

export const makeGate = Effect.gen(function* () {
  const proposals = yield* Proposals;

  /**
   * Check the gate for one act. Ungated → a free grant. An approved
   * matching grant → hand it over. A pending match → still waiting.
   * Nothing staged → stage it and fail — the agent parks.
   */
  const check = Effect.fn(function* (input: {
    readonly payload: ProposalPayload;
    readonly summary: string;
    /** The card's body — what the human reads before deciding. */
    readonly detail: string;
    /** Does an existing staged payload describe this same act? */
    readonly matches: (payload: ProposalPayload) => boolean;
  }) {
    const kind = input.payload.kind;
    if (!(yield* proposals.gated(kind))) {
      return {
        proposal: undefined,
        executed: () => Effect.void,
      } satisfies Grant;
    }
    const session = yield* AI.Thread;
    const mine = (proposal: Proposal) =>
      proposal.kind === kind &&
      proposal.proposer.key === session.key &&
      input.matches(proposal.payload);

    const approved = (yield* proposals.list("approved")).find(mine);
    if (approved !== undefined) {
      return {
        proposal: approved,
        executed: (outcome) =>
          proposals.mark(approved.id, "executed", outcome).pipe(Effect.ignore),
      } satisfies Grant;
    }

    const pending = (yield* proposals.list("pending")).find(mine);
    if (pending !== undefined) {
      return yield* Effect.fail(
        new StagedForApproval({
          message: `${pending.id} already awaits the human on the Root Thread — park until their decision arrives`,
        }),
      );
    }

    const staged = yield* proposals.stage({
      kind,
      summary: input.summary,
      detail: input.detail,
      payload: input.payload,
      proposer: { term: "Engineer", key: session.key },
    });
    return yield* Effect.fail(
      new StagedForApproval({
        message: `staged ${staged.id} — awaiting the human's approval on the Root Thread; park until their decision arrives`,
      }),
    );
  });

  return { check };
});
