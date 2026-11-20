/**
 * An RDS identifier for a test that must name its resource, unique to the
 * stage running it, so two people (or two worktrees) running the same case in
 * one account never contend for one resource. It is the same on every run.
 *
 * RDS allows letters, digits and single hyphens, and at most 63 characters for
 * an instance or cluster, so keep `prefix` short.
 */
export const stageIdentifier = (stage: string, prefix: string) =>
  `${prefix}-${stage.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
