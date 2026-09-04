import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Which version of the file a diff line is numbered against: `RIGHT`
 *  is the pull request's HEAD (additions and context), `LEFT` its base
 *  (deletions). */
export type DiffSide = "LEFT" | "RIGHT";

/**
 * One inline review comment, in GitHub's createReview shape. A RANGE
 * is `start_line..line` — GitHub requires `start_side` alongside
 * `start_line` (without it a range fails with a misleading "start_line
 * must precede the end line"), so a range carries both sides; absent
 * sides mean `RIGHT`, the HEAD version the reviewer reads.
 */
export interface ProposedReviewComment {
  readonly path: string;
  /** The anchor — the LAST line of a range. */
  readonly line: number;
  readonly side?: DiffSide;
  /** The FIRST line of a range; strictly before `line`. */
  readonly start_line?: number;
  readonly start_side?: DiffSide;
  readonly body: string;
}

/**
 * WHAT an agent proposes to do on GitHub — the payload the executor
 * replays verbatim once the operator accepts (github/ProposalActions.ts).
 */
export type ProposalPayload =
  | {
      readonly kind: "review";
      readonly number: number;
      readonly verdict: "approve" | "request_changes" | "comment";
      readonly body: string;
      readonly comments: ReadonlyArray<ProposedReviewComment>;
    }
  | {
      readonly kind: "comment";
      readonly number: number;
      readonly body: string;
    }
  | {
      readonly kind: "merge";
      readonly number: number;
      readonly method: "merge" | "squash" | "rebase";
      readonly commitTitle?: string;
      readonly commitMessage?: string;
    }
  | {
      readonly kind: "pull_request";
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
    };

export type ProposalKind = ProposalPayload["kind"];

export type ProposalStatus = "pending" | "accepted" | "rejected" | "failed";

export interface Proposal {
  readonly id: string;
  /** The session that proposed it — where the outcome is reported. */
  readonly session: { readonly term: string; readonly key: string };
  /** `owner/repo` the action targets. */
  readonly repo: string;
  /** The pull request it concerns — absent for a NEW pull request. */
  readonly number: number | undefined;
  /** One human-readable line for the operator's list. */
  readonly summary: string;
  readonly payload: ProposalPayload;
  readonly at: number;
  /** The last time the proposing agent REVISED it while pending (the
   *  reviewer re-verifying after a push, or answering the operator's
   *  "ask for changes") — `undefined` when it stands as first filed. */
  readonly revisedAt: number | undefined;
  readonly status: ProposalStatus;
  readonly resolvedAt: number | undefined;
  /** `accepted`: the URL of what landed on GitHub. */
  readonly result: string | undefined;
  /** `failed`: why GitHub refused it. */
  readonly error: string | undefined;
  /** `rejected`: the operator's word, when they left one. */
  readonly reason: string | undefined;
}

export type ProposalResolution =
  | { readonly status: "accepted"; readonly result: string }
  | { readonly status: "rejected"; readonly reason?: string }
  | { readonly status: "failed"; readonly error: string };

/**
 * PROPOSALS — the org's human-in-the-loop seam. An agent never writes
 * to GitHub on its own: a review, a comment, a merge, a pull request
 * is a PROPOSAL it files here and its round moves on ("proposed —
 * awaiting the operator"). The operator sees it in the UI beside the
 * pull request and ACCEPTS (the executor performs the exact payload
 * and records what landed) or REJECTS (the session is told, and can
 * revise). Nothing parks, nothing times out, nothing is remembered as
 * a standing permission: each proposal is one act, resolved once.
 *
 * A PENDING proposal may be REVISED by its author in place — the
 * reviewer's review is a living draft that tracks the pull request
 * (a push re-verifies and updates it; the operator's "ask for changes"
 * reshapes it) until the operator accepts or declines it. One review
 * per pull request waits in the inbox, never a stack of drafts.
 *
 * (This replaces the earlier blocking `Approvals` gate, which parked
 * the tool for up to five minutes inside the session and was disarmed
 * by default — on the real repository the default is the other way.)
 */
export class Proposals extends Context.Service<
  Proposals,
  {
    readonly propose: (input: {
      readonly session: { readonly term: string; readonly key: string };
      readonly repo: string;
      readonly summary: string;
      readonly payload: ProposalPayload;
    }) => Effect.Effect<Proposal>;
    /** Replace a PENDING proposal's summary and payload (same id, same
     *  kind — the operator's card updates in place); `false` when it is
     *  unknown or already resolved, in which case the caller files a new
     *  one. */
    readonly revise: (
      id: string,
      input: { readonly summary: string; readonly payload: ProposalPayload },
    ) => Effect.Effect<boolean>;
    /** Newest first. `number` narrows to one pull request; `status`
     *  to one state (the UI's pending list). */
    readonly list: (filter?: {
      readonly repo?: string;
      readonly number?: number;
      readonly status?: ProposalStatus;
      readonly session?: { readonly term: string; readonly key: string };
    }) => Effect.Effect<ReadonlyArray<Proposal>>;
    readonly get: (id: string) => Effect.Effect<Proposal | undefined>;
    /** Resolve a PENDING proposal; `false` when it is unknown or
     *  already resolved (idempotent — the world outranks the click). */
    readonly resolve: (
      id: string,
      resolution: ProposalResolution,
    ) => Effect.Effect<boolean>;
  }
>()("alchemy-org/Proposals") {}

/** The proposal's pull request number, when its payload names one. */
export const proposalNumber = (payload: ProposalPayload): number | undefined =>
  payload.kind === "pull_request" ? undefined : payload.number;
