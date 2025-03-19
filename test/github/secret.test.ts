import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { destroy } from "../../src/destroy";
import { createGitHubClient } from "../../src/github/client";
import { GitHubSecret } from "../../src/github/secret";
import { BRANCH_PREFIX } from "../util";

// Optional environment variable overrides
const owner = process.env.GITHUB_OWNER || "sam-goodwin";
const repository = process.env.GITHUB_REPO || "alchemy";

describe("GitHubSecret Resource", () => {
  // Use a fixed resource ID
  const testId = `${BRANCH_PREFIX}-github-secret-test`;

  test.skipIf(!!process.env.CI)(
    "create, update, and delete secret",
    async () => {
      // Create an authenticated client for testing - will use the same auth as the resource
      const octokit = await createGitHubClient();

      // Use a hardcoded secret name instead of timestamps for repeatability
      const secretName = `${BRANCH_PREFIX.toUpperCase()}_TEST_SECRET_1`;
      const secretValue = "this-is-a-test-secret-value";
      const updatedSecretValue = "this-is-an-updated-test-secret-value";

      // Create a test secret
      const secret = new GitHubSecret(testId, {
        owner,
        repository,
        name: secretName,
        value: secretValue,
      });

      try {
        console.log(`Creating secret: ${secretName}`);

        // Apply to create the secret - resource will handle authentication
        const output = await apply(secret);
        expect(output.id).toBeTruthy();
        expect(output.owner).toEqual(owner);
        expect(output.repository).toEqual(repository);
        expect(output.name).toEqual(secretName);

        // Try to verify with the API
        try {
          // Verify secret exists by checking if it's in the list of repository secrets
          const { data: secretList } =
            await octokit.rest.actions.listRepoSecrets({
              owner,
              repo: repository,
            });

          const secretInfo = secretList.secrets.find(
            (s) => s.name === secretName,
          );
          expect(secretInfo).toBeDefined();

          if (secretInfo) {
            console.log(`Secret created successfully: ${secretName}`);
          }
        } catch (error: any) {
          // If we get a permission error, log it but don't fail the test
          if (error.status === 403) {
            console.log("Skipping API verification - insufficient permissions");
          } else {
            throw error;
          }
        }

        // Update the secret
        console.log(`Updating secret: ${secretName}`);

        const updatedSecret = new GitHubSecret(testId, {
          owner,
          repository,
          name: secretName,
          value: updatedSecretValue,
        });

        const updateOutput = await apply(updatedSecret);
        expect(updateOutput.id).toEqual(output.id);
      } catch (error: any) {
        console.error(`Test error: ${error.message}`);
        throw error;
      } finally {
        await destroy(secret);
      }
    },
  );
});
