import * as AI from "alchemy/AI";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Channel } from "../channel/Channel.ts";
import {
  Registry,
  type ApprovalPayload,
  type RegistryApproval,
} from "../registry/Registry.ts";

/**
 * The HUMAN GATE on an engineer's external writes. A gated tool call
 * does not act: it stages an Approval in the Registry, surfaces a
 * card in the main channel, and fails with {@link StagedForApproval}
 * — the agent parks on it. The operator's Approve steers the agent
 * to retry; the retry finds the approved grant here and goes
 * through (marking it executed and flipping the card). Policy
 * (`Registry.setPolicy`) can open a kind back up to direct action.
 */

export class StagedForApproval extends Data.TaggedError(
  "StagedForApproval",
)<{
  message: string;
}> {}

/** What a granted check hands back: bookkeeping for after the act. */
export interface Grant {
  /** `undefined` = the kind is ungated (no bookkeeping owed). */
  readonly approval: RegistryApproval | undefined;
  /** Mark the grant executed and flip its card — call after the act. */
  readonly executed: (outcome: string) => Effect.Effect<void>;
}

export const makeGate = Effect.gen(function* () {
  const registry = yield* Registry;
  const channel = yield* Channel;

  const flip = Effect.fn(function* (
    approval: RegistryApproval,
    decided: "executed" | "failed",
    outcome: string,
  ) {
    if (approval.cardId === undefined) return;
    const [card] = yield* channel.read([approval.cardId]);
    if (card?.card === undefined) return;
    yield* channel.update(approval.cardId, {
      text: `${card.text}\n\n— ${outcome}`,
      card: {
        ...card.card,
        approval: { id: approval.id, kind: approval.kind, decided },
      },
    });
  });

  /**
   * Check the gate for one act. Ungated → a free grant. An approved
   * matching grant → hand it over. A pending match → still waiting.
   * Nothing staged → stage it, card it, and fail — the agent parks.
   */
  const check = Effect.fn(function* (input: {
    readonly payload: ApprovalPayload;
    readonly summary: string;
    /** The card's body — what the operator reads before deciding. */
    readonly detail: string;
    /** Does an existing staged payload describe this same act? */
    readonly matches: (payload: ApprovalPayload) => boolean;
  }) {
    const kind = input.payload.kind;
    if (!(yield* registry.gated(kind))) {
      return {
        approval: undefined,
        executed: () => Effect.void,
      } satisfies Grant;
    }
    const session = yield* AI.Thread;
    const threadId = session.key.split("::")[0]!;
    const mine = (approval: RegistryApproval) =>
      approval.kind === kind &&
      approval.stager.key === session.key &&
      input.matches(approval.payload);

    const approved = (yield* registry.listApprovals("approved")).find(mine);
    if (approved !== undefined) {
      return {
        approval: approved,
        executed: (outcome) =>
          Effect.gen(function* () {
            yield* registry.decideApproval(approved.id, "executed", outcome);
            yield* flip(approved, "executed", outcome);
          }).pipe(Effect.ignore),
      } satisfies Grant;
    }

    const pending = (yield* registry.listApprovals("pending")).find(mine);
    if (pending !== undefined) {
      return yield* Effect.fail(
        new StagedForApproval({
          message: `${pending.id} already awaits the operator in the channel — park until their decision arrives`,
        }),
      );
    }

    const staged = yield* registry.stageApproval({
      kind,
      summary: input.summary,
      payload: input.payload,
      stager: { term: "Engineer", key: session.key },
      threadId,
    });
    const card = yield* channel.append({
      kind: "card",
      text: input.detail,
      thread: threadId,
      card: {
        thread: threadId,
        title: `Approve: ${input.summary}`,
        approval: { id: staged.id, kind },
      },
    });
    yield* registry.attachApprovalCard(staged.id, card.id);
    return yield* Effect.fail(
      new StagedForApproval({
        message: `staged ${staged.id} — awaiting the operator's approval in the channel; park until their decision arrives`,
      }),
    );
  });

  return { check };
});
