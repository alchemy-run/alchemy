import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Proposal, Proposals, proposalNumber } from "./Proposals.ts";

/** In-memory physics — tests that drive the propose → execute path
 *  without a D1 binding (test/worktree.test.ts). The Worker uses
 *  ProposalsD1. */
export const ProposalsMemory: Layer.Layer<Proposals> = Layer.sync(
  Proposals,
  () => {
    const rows = new Map<string, Proposal>();
    let minted = 0;
    return Proposals.of({
      propose: (input) =>
        Effect.sync(() => {
          const proposal: Proposal = {
            id: `proposal-${++minted}`,
            session: input.session,
            repo: input.repo,
            number: proposalNumber(input.payload),
            summary: input.summary,
            payload: input.payload,
            at: Date.now(),
            status: "pending",
            resolvedAt: undefined,
            result: undefined,
            error: undefined,
            reason: undefined,
          };
          rows.set(proposal.id, proposal);
          return proposal;
        }),
      list: (filter) =>
        Effect.sync(() =>
          [...rows.values()]
            .filter(
              (row) =>
                (filter?.repo === undefined || row.repo === filter.repo) &&
                (filter?.number === undefined || row.number === filter.number) &&
                (filter?.status === undefined || row.status === filter.status) &&
                (filter?.session === undefined ||
                  (row.session.term === filter.session.term &&
                    row.session.key === filter.session.key)),
            )
            .sort((a, b) => b.at - a.at),
        ),
      get: (id) => Effect.sync(() => rows.get(id)),
      resolve: (id, resolution) =>
        Effect.sync(() => {
          const row = rows.get(id);
          if (row === undefined || row.status !== "pending") return false;
          rows.set(id, {
            ...row,
            status: resolution.status,
            resolvedAt: Date.now(),
            result:
              resolution.status === "accepted" ? resolution.result : undefined,
            error: resolution.status === "failed" ? resolution.error : undefined,
            reason:
              resolution.status === "rejected" ? resolution.reason : undefined,
          });
          return true;
        }),
    });
  },
);
