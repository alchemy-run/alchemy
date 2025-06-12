import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { createGitHubClient } from "../../src/github/client.ts";
import { GitHubComment } from "../../src/github/comment.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

// Optional environment variable overrides
const owner = process.env.GITHUB_OWNER || "sam-goodwin";
const repository = process.env.GITHUB_REPO || "test-alchemy-resources";

describe("GitHubComment Resource", { concurrent: false }, () => {
  test.skipIf(!!process.env.CI)(
    "create, update, and preserve comment on issue",
    async (scope) => {
      // Create an authenticated client for testing
      const octokit = await createGitHubClient();

      // First, create a test issue for commenting on
      const testIssueTitle = `Test Issue for ${BRANCH_PREFIX} Comment Resource`;
      const { data: testIssue } = await octokit.rest.issues.create({
        owner,
        repo: repository,
        title: testIssueTitle,
        body: "This is a test issue created for testing the GitHubComment resource",
      });

      const issueNumber = testIssue.number;
      const testId = `${BRANCH_PREFIX}-comment-test`;

      try {
        // Create a comment
        const comment = await GitHubComment(testId, {
          owner,
          repository,
          issueNumber,
          body: "🤖 This is a test comment created by Alchemy!",
        });

        // Verify comment properties
        expect(comment.id).toBeTruthy();
        expect(comment.commentId).toBeGreaterThan(0);
        expect(comment.owner).toEqual(owner);
        expect(comment.repository).toEqual(repository);
        expect(comment.issueNumber).toEqual(issueNumber);
        expect(comment.body).toEqual(
          "🤖 This is a test comment created by Alchemy!",
        );
        expect(comment.htmlUrl).toContain(
          `/${owner}/${repository}/issues/${issueNumber}#issuecomment-`,
        );
        expect(comment.allowDelete).toBeUndefined(); // Should be undefined when not set

        // Verify comment exists via API
        const { data: issueComments } = await octokit.rest.issues.listComments({
          owner,
          repo: repository,
          issue_number: issueNumber,
        });

        const createdComment = issueComments.find(
          (c) => c.id === comment.commentId,
        );
        expect(createdComment).toBeDefined();
        expect(createdComment?.body).toEqual(
          "🤖 This is a test comment created by Alchemy!",
        );

        // Update the comment
        const updatedComment = await GitHubComment(testId, {
          owner,
          repository,
          issueNumber,
          body: "🔄 This comment has been updated by Alchemy!",
        });

        // Should be the same comment ID, but updated content
        expect(updatedComment.commentId).toEqual(comment.commentId);
        expect(updatedComment.body).toEqual(
          "🔄 This comment has been updated by Alchemy!",
        );

        // Verify update via API
        const { data: updatedCommentData } =
          await octokit.rest.issues.getComment({
            owner,
            repo: repository,
            comment_id: comment.commentId,
          });

        expect(updatedCommentData.body).toEqual(
          "🔄 This comment has been updated by Alchemy!",
        );

        // Test default behavior: comment should be preserved on destroy
        await destroy(scope);

        // Verify comment still exists after destroy
        const { data: commentAfterDestroy } =
          await octokit.rest.issues.getComment({
            owner,
            repo: repository,
            comment_id: comment.commentId,
          });

        expect(commentAfterDestroy.body).toEqual(
          "🔄 This comment has been updated by Alchemy!",
        );

        // Clean up: manually delete the comment since we tested preservation
        await octokit.rest.issues.deleteComment({
          owner,
          repo: repository,
          comment_id: comment.commentId,
        });
      } finally {
        // Clean up the test issue
        try {
          await octokit.rest.issues.update({
            owner,
            repo: repository,
            issue_number: issueNumber,
            state: "closed",
          });
        } catch (error) {
          console.warn("Failed to close test issue:", error);
        }
      }
    },
  );

  test.skipIf(!!process.env.CI)(
    "delete comment when allowDelete is true",
    async (scope) => {
      // Create an authenticated client for testing
      const octokit = await createGitHubClient();

      // Create a test issue
      const testIssueTitle = `Test Issue for ${BRANCH_PREFIX} Comment Deletion`;
      const { data: testIssue } = await octokit.rest.issues.create({
        owner,
        repo: repository,
        title: testIssueTitle,
        body: "This is a test issue for testing comment deletion",
      });

      const issueNumber = testIssue.number;
      const testId = `${BRANCH_PREFIX}-delete-comment-test`;

      try {
        // Create a comment with allowDelete: true
        const comment = await GitHubComment(testId, {
          owner,
          repository,
          issueNumber,
          body: "🗑️ This comment will be deleted",
          allowDelete: true,
        });

        expect(comment.allowDelete).toEqual(true);

        // Verify comment exists
        const { data: createdCommentData } =
          await octokit.rest.issues.getComment({
            owner,
            repo: repository,
            comment_id: comment.commentId,
          });
        expect(createdCommentData.body).toEqual(
          "🗑️ This comment will be deleted",
        );

        // Destroy the resource - should delete the comment
        await destroy(scope);

        // Verify comment was deleted
        await expect(
          octokit.rest.issues.getComment({
            owner,
            repo: repository,
            comment_id: comment.commentId,
          }),
        ).rejects.toMatchObject({
          status: 404,
        });
      } finally {
        // Clean up the test issue
        try {
          await octokit.rest.issues.update({
            owner,
            repo: repository,
            issue_number: issueNumber,
            state: "closed",
          });
        } catch (error) {
          console.warn("Failed to close test issue:", error);
        }
      }
    },
  );

  test.skipIf(!!process.env.CI)(
    "handle invalid issue number gracefully",
    async (scope) => {
      const testId = `${BRANCH_PREFIX}-invalid-issue-test`;
      const invalidIssueNumber = 999999; // Very likely to not exist

      try {
        // Attempt to create a comment on non-existent issue
        await expect(
          GitHubComment(testId, {
            owner,
            repository,
            issueNumber: invalidIssueNumber,
            body: "This should fail",
          }),
        ).rejects.toThrow();
      } finally {
        await destroy(scope);
      }
    },
  );

  test.skipIf(!!process.env.CI)(
    "support markdown content in comments",
    async (scope) => {
      // Create an authenticated client for testing
      const octokit = await createGitHubClient();

      // Create a test issue
      const testIssueTitle = `Test Issue for ${BRANCH_PREFIX} Markdown Comment`;
      const { data: testIssue } = await octokit.rest.issues.create({
        owner,
        repo: repository,
        title: testIssueTitle,
        body: "Testing markdown support in comments",
      });

      const issueNumber = testIssue.number;
      const testId = `${BRANCH_PREFIX}-markdown-comment-test`;

      const markdownContent = `## Test Comment

This comment includes **markdown** formatting:

- [x] Bold text
- [x] Lists
- [x] Code blocks

\`\`\`typescript
const comment = await GitHubComment("test", {
  body: "Markdown content"
});
\`\`\`

> Quote block for good measure

Created by Alchemy at ${new Date().toISOString()}`;

      try {
        // Create a comment with markdown content
        const comment = await GitHubComment(testId, {
          owner,
          repository,
          issueNumber,
          body: markdownContent,
          allowDelete: true, // Clean up after test
        });

        // Verify the markdown content was preserved
        expect(comment.body).toEqual(markdownContent);

        // Verify via API
        const { data: commentData } = await octokit.rest.issues.getComment({
          owner,
          repo: repository,
          comment_id: comment.commentId,
        });

        expect(commentData.body).toEqual(markdownContent);
      } finally {
        await destroy(scope);

        // Clean up the test issue
        try {
          await octokit.rest.issues.update({
            owner,
            repo: repository,
            issue_number: issueNumber,
            state: "closed",
          });
        } catch (error) {
          console.warn("Failed to close test issue:", error);
        }
      }
    },
  );
});

/**
 * Helper function to verify a comment does not exist
 */
async function _assertCommentDoesNotExist(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number,
) {
  try {
    await octokit.rest.issues.getComment({
      owner,
      repo,
      comment_id: commentId,
    });
    throw new Error(`Comment ${commentId} should not exist but was found`);
  } catch (error: any) {
    if (error.status !== 404) {
      throw error;
    }
    // 404 is expected - comment doesn't exist
  }
}
