/** A private repository the test owns (created by the stack, kept on destroy). */
export const EGRESS_OWNER: string = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
export const EGRESS_REPO = `${EGRESS_OWNER}/test-github-egress` as const;
