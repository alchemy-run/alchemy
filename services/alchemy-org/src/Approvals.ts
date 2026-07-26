/**
 * The org's approval ledger — the in-process record the merge tool
 * ratifies against. WHY not GitHub reviews: the factory runs on ONE
 * token, and GitHub rejects self-approval (the account that opened a
 * PR cannot APPROVE-review it), so the desk's verdict is recorded
 * here and made VISIBLE as a PR comment. A human's real APPROVED
 * review is honored too (the merge tool checks both).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface PullRequestKey {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export interface ApprovalsService {
  /** Record the review approval of a pull request. */
  readonly record: (pr: PullRequestKey) => Effect.Effect<void>;
  /** Has this pull request been approved? */
  readonly isApproved: (pr: PullRequestKey) => Effect.Effect<boolean>;
}

export class Approvals extends Context.Service<Approvals, ApprovalsService>()(
  "alchemy-org/Approvals",
) {}

const keyOf = (pr: PullRequestKey) =>
  `${pr.owner}/${pr.repository}#${pr.number}`;

/** In-memory: approvals live as long as the org process (the PR run
 * that consumes them is in-memory too — they crash together). */
export const ApprovalsLive = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const approved = yield* Ref.make<ReadonlySet<string>>(new Set());
    return {
      record: (pr) =>
        Ref.update(approved, (set) => new Set(set).add(keyOf(pr))),
      isApproved: (pr) =>
        Ref.get(approved).pipe(Effect.map((set) => set.has(keyOf(pr)))),
    };
  }),
);
