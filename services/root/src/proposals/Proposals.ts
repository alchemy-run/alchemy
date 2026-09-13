import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * PROPOSALS — the human's decision seam, and the company's ONE door to
 * the outside world.
 *
 * POLICY: the autonomous side never writes externally on its own. A
 * gated act (commenting, merging, closing, pushing, opening a pull
 * request) is STAGED here as a proposal; the proposing tool's result
 * carries the proposal — the Root Thread renders it as a card with
 * Approve/Deny; the human decides (`POST /api/proposals/:id`,
 * proposals/DecideApi.ts). Approve EXECUTES worker-doable kinds
 * (comment/merge/close — plain GitHub API calls) or marks push/
 * open_pull approved so the proposer's gated retry goes through
 * (coding/Gate.ts checks THIS store). Deny steers the proposer with
 * the reason. Widening autonomy (`setPolicy`) is an initiative the
 * humans drive with the C-Suite — never a default.
 */

export type ProposalKind = "comment" | "push" | "open_pull" | "merge" | "close";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "failed";

/** The staged act, by kind — everything needed to execute later. */
export type ProposalPayload =
  | { readonly kind: "comment"; readonly ref: string; readonly body: string }
  | { readonly kind: "push"; readonly branch: string }
  | {
      readonly kind: "open_pull";
      readonly head: string;
      readonly base?: string;
      readonly title: string;
      readonly body: string;
    }
  | { readonly kind: "merge"; readonly ref: string }
  | { readonly kind: "close"; readonly ref: string; readonly reason?: string };

/** The session that staged it — told the outcome, retries when
 *  approved (the sandbox-bound kinds). */
export interface Proposer {
  readonly term: string;
  readonly key: string;
}

export interface Proposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  /** One line for the card. */
  readonly summary: string;
  /** The card's body — what the human reads before deciding. */
  readonly detail: string;
  readonly payload: ProposalPayload;
  readonly proposer: Proposer;
  /** The engineering task this act advances, when one does (lineage). */
  readonly task?: string;
  /** deny reason / execution result / failure text. */
  readonly outcome?: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
}

export interface StageProposalInput {
  readonly kind: ProposalKind;
  readonly summary: string;
  readonly detail: string;
  readonly payload: ProposalPayload;
  readonly proposer: Proposer;
  readonly task?: string;
}

export class Proposals extends Context.Service<
  Proposals,
  {
    readonly stage: (input: StageProposalInput) => Effect.Effect<Proposal>;
    readonly read: (id: string) => Effect.Effect<Proposal | undefined>;
    readonly list: (
      status?: ProposalStatus,
    ) => Effect.Effect<ReadonlyArray<Proposal>>;
    /** Move a proposal out of pending; answers the fresh row. */
    readonly mark: (
      id: string,
      status: Exclude<ProposalStatus, "pending">,
      outcome?: string,
    ) => Effect.Effect<Proposal | undefined>;
    /** Is this act kind gated behind a proposal? Unset = gated. */
    readonly gated: (kind: ProposalKind) => Effect.Effect<boolean>;
    readonly setPolicy: (
      kind: ProposalKind,
      gated: boolean,
    ) => Effect.Effect<void>;
    readonly policy: () => Effect.Effect<
      ReadonlyArray<{ readonly kind: ProposalKind; readonly gated: boolean }>
    >;
  }
>()("Proposals") {}
