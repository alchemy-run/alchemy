import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { Proposals } from "./Proposals.ts";

/**
 * The PROPOSE tools — how an agent asks the humans for an external
 * write it may not perform itself (Proposals.ts). The tool RESULT
 * carries the proposal; the Root Thread renders it as a card with
 * Approve/Deny and the proposal's live status. Given to the Head and
 * to managers; engineers meet the same seam through their gated
 * push/open-PR tools (coding/Gate.ts).
 */

const ref = AI.Thing("ref", S.String)`
  The GitHub entity — "owner/repo#N".`;

const body = AI.Thing("body", S.String)`
  The comment, in GitHub markdown — ready to post verbatim.`;

const why = AI.Thing("why", S.String)`
  The case for the act, for the human deciding — one short paragraph:
  what it does, why now, what was verified.`;

const proposalId = AI.Thing("proposal", S.String)`
  The staged proposal's id — its card tracks the decision.`;

export const makeProposalTools = Effect.gen(function* () {
  const proposals = yield* Proposals;

  const stage = Effect.fn(function* (input: {
    readonly kind: "comment" | "merge" | "close";
    readonly summary: string;
    readonly detail: string;
    readonly payload:
      | { kind: "comment"; ref: string; body: string }
      | { kind: "merge"; ref: string }
      | { kind: "close"; ref: string; reason?: string };
  }) {
    const me = yield* AI.Thread;
    const staged = yield* proposals.stage({
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      payload: input.payload,
      proposer: { term: "Head", key: me.key },
    });
    return { proposal: staged.id };
  });

  const proposeComment = yield* AI.Tool("propose_comment")`
    Propose posting ${body} as a comment on ${ref}, with ${why} for the
    human deciding. Nothing is posted until they approve — answers
    ${AI.out(proposalId)}; the decision arrives as a message.`(
    Effect.fn(function* (p: { ref: string; body: string; why: string }) {
      return yield* stage({
        kind: "comment",
        summary: `comment on ${p.ref}`,
        detail: `${p.why}\n\n---\n\n${p.body}`,
        payload: { kind: "comment", ref: p.ref, body: p.body },
      });
    }),
  );

  const proposeMerge = yield* AI.Tool("propose_merge")`
    Propose MERGING pull request ${ref}, with ${why} — state plainly
    what was verified (green, reviewed, described); the human's approval
    should be one click. Answers ${AI.out(proposalId)}.`(
    Effect.fn(function* (p: { ref: string; why: string }) {
      return yield* stage({
        kind: "merge",
        summary: `merge ${p.ref}`,
        detail: p.why,
        payload: { kind: "merge", ref: p.ref },
      });
    }),
  );

  const proposeClose = yield* AI.Tool("propose_close")`
    Propose CLOSING ${ref} (an issue resolved, answered, or stale — or
    a pull request superseded), with ${why}. Answers ${AI.out(proposalId)}.`(
    Effect.fn(function* (p: { ref: string; why: string }) {
      return yield* stage({
        kind: "close",
        summary: `close ${p.ref}`,
        detail: p.why,
        payload: { kind: "close", ref: p.ref, reason: p.why },
      });
    }),
  );

  return { proposeComment, proposeMerge, proposeClose };
});
