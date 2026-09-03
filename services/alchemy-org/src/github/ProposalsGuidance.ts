import * as AI from "alchemy/AI";

/**
 * The PROPOSALS GATE — the one rule for anything that would write to
 * GitHub. Activated when a change touches `github/` or adds an action
 * an agent can take on a repository.
 */
export class ProposalsGuidance extends AI.Skill<ProposalsGuidance>(import.meta)(
  "ProposalsGuidance",
) {}

export const ProposalsGuidanceGeneral = ProposalsGuidance.make`
  ## GitHub is behind the proposals gate

  No agent writes to GitHub. A review, a comment, a merge, a pull
  request is a PROPOSAL (\`github/Proposals.ts\`) the operator accepts,
  declines, or sends back for changes in the UI; \`ProposalActions.ts\`
  performs the write on accept — the ONLY place a GitHub write lives.
  A new GitHub write is a new proposal kind (a payload variant, its
  executor arm, its card in the UI), never a direct call from a tool.

  A pending proposal is a living draft: the proposing agent revises it
  in place (\`Proposals.revise\`) when the code moves or the operator
  asks, so one review per pull request waits in the inbox, never a
  stack. Resolution is idempotent — \`resolve\` answers \`false\` for a
  proposal already resolved, and the world outranks the click.

  The store is partitioned by pull request: \`ProposalsDO\` is one
  Durable Object per \`owner/repo#N\` (the proposal's id carries its
  partition) with a light index for the inbox — what the Worker runs.
  \`ProposalsD1\` (one table) and \`ProposalsMemory\` (tests) are the
  other variants of the same contract; a change to the contract is a
  change to all three.

  Events arrive through \`GitHub.consumeRepositoryEvents\` — a real
  webhook deployed, polling under \`alchemy dev\` — deduped by the
  Ledger (\`review/Ledger.ts\`); \`review/ReviewerEvents.ts\` routes them:
  a pull request opening starts its review, every push wakes the same
  session to revise it, close or merge settles it and withdraws what
  still waits. The connected repositories are the static list in
  \`github/Repos.ts\`; the org claims ownership of none of them.`;
