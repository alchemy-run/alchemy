import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import type { Proposal } from "./Proposals.ts";

/** Every comment the org posts carries this invisible marker — the
 *  review router (when enabled) skips comment events carrying it, so
 *  the bot never wakes on its own words. */
export const SIGNATURE = "<!-- review-bot -->";

/**
 * The EXECUTOR: perform an accepted proposal's payload against GitHub,
 * verbatim, and answer with the URL of what landed. Built once over
 * the repositories this deploy may write to (each gets its four write
 * clients); a proposal naming any other repository fails closed.
 */
export const makeProposalExecutor = (
  targets: ReadonlyArray<GitHub.RepositoryLike>,
) =>
  Effect.gen(function* () {
    const writers = yield* Effect.forEach(targets, (target) =>
      Effect.gen(function* () {
        const identity = yield* GitHub.resolveRepository(target);
        return {
          repo: `${identity.owner}/${identity.repository}`,
          createReview: yield* GitHub.CreatePullRequestReview(target),
          createComment: yield* GitHub.CreateIssueComment(target),
          merge: yield* GitHub.MergePullRequest(target),
          createPullRequest: yield* GitHub.CreatePullRequest(target),
        };
      }),
    );

    const describe = (error: { operation: string; message: string }) =>
      `${error.operation} failed: ${error.message}`;

    return (proposal: Proposal): Effect.Effect<string, string> =>
      Effect.gen(function* () {
        const writer = writers.find((w) => w.repo === proposal.repo);
        if (writer === undefined) {
          return yield* Effect.fail(
            `${proposal.repo} is not a repository this deploy writes to`,
          );
        }
        const payload = proposal.payload;
        switch (payload.kind) {
          case "review": {
            const banner =
              payload.verdict === "approve"
                ? "**APPROVE**"
                : payload.verdict === "request_changes"
                  ? "**REQUEST CHANGES**"
                  : undefined;
            const review = yield* writer
              .createReview({
                pull_number: payload.number,
                event:
                  payload.verdict === "approve"
                    ? "APPROVE"
                    : payload.verdict === "request_changes"
                      ? "REQUEST_CHANGES"
                      : "COMMENT",
                body: `${payload.body}\n\n${SIGNATURE}`,
                comments: [...payload.comments],
              })
              .pipe(
                // GitHub forbids verdict reviews on the author's own pull
                // request. Downgrade to a COMMENT-event review with the
                // verdict as a banner — inline comments land either way.
                Effect.catchIf(
                  (error) => error.message.includes("own pull request"),
                  () =>
                    writer.createReview({
                      pull_number: payload.number,
                      event: "COMMENT",
                      body: `${banner ?? ""}\n\n${payload.body}\n\n${SIGNATURE}`,
                      comments: [...payload.comments],
                    }),
                ),
                Effect.mapError(describe),
              );
            return review.html_url;
          }
          case "comment": {
            const created = yield* writer
              .createComment({
                issue_number: payload.number,
                body: `${payload.body}\n\n${SIGNATURE}`,
              })
              .pipe(Effect.mapError(describe));
            return created.html_url;
          }
          case "merge": {
            const merged = yield* writer
              .merge({
                pull_number: payload.number,
                merge_method: payload.method,
                ...(payload.commitTitle !== undefined
                  ? { commit_title: payload.commitTitle }
                  : {}),
                ...(payload.commitMessage !== undefined
                  ? { commit_message: payload.commitMessage }
                  : {}),
              })
              .pipe(Effect.mapError(describe));
            if (!merged.merged) {
              return yield* Effect.fail(
                `GitHub did not merge #${payload.number}: ${merged.message}`,
              );
            }
            return `https://github.com/${proposal.repo}/pull/${payload.number}`;
          }
          case "pull_request": {
            const pull = yield* writer
              .createPullRequest({
                title: payload.title,
                body: payload.body,
                head: payload.head,
                base: payload.base,
              })
              .pipe(Effect.mapError(describe));
            return pull.html_url;
          }
        }
      });
  });
