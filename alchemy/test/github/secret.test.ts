import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import { createGitHubClient } from "../../src/github/client";
import { GitHubSecret } from "../../src/github/secret";
import { secret } from "../../src/secret";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

// Optional environment variable overrides
const owner = process.env.GITHUB_OWNER || "sam-goodwin";
const repository = process.env.GITHUB_REPO || "alchemy";

describe("GitHubSecret Resource", () => {
  // Use a fixed resource ID
  const testId = `${BRANCH_PREFIX}-github-secret-test`;

  test.skipIf(!!process.env.CI)(
    "create, update, and delete secret",
    async (scope) => {
      // Create an authenticated client for testing - will use the same auth as the resource
      const octokit = await createGitHubClient();

      // Use a hardcoded secret name instead of timestamps for repeatability
      const secretName = `${BRANCH_PREFIX.toUpperCase()}_TEST_SECRET_1`;
      const secretValue = secret("this-is-a-test-secret-value");
      const updatedSecretValue = secret("this-is-an-updated-test-secret-value");

      // Create a test secret

      try {
        const ghSecret = await GitHubSecret(testId, {
          owner,
          repository,
          name: secretName,
          value: secretValue,
        });

        // Apply to create the secret - resource will handle authentication
        expect(ghSecret.id).toBeTruthy();
        expect(ghSecret.owner).toEqual(owner);
        expect(ghSecret.repository).toEqual(repository);
        expect(ghSecret.name).toEqual(secretName);

        // Try to verify with the API
        try {
          // Verify secret exists by checking if it's in the list of repository secrets
          const { data: secretList } =
            await octokit.rest.actions.listRepoSecrets({
              owner,
              repo: repository,
            });

          const secretInfo = secretList.secrets.find(
            (s) => s.name === secretName
          );
          expect(secretInfo).toBeDefined();
        } catch (error: any) {
          // If we get a permission error, log it but don't fail the test
          if (error.status === 403) {
            console.log("Skipping API verification - insufficient permissions");
          } else {
            throw error;
          }
        }

        const updatedSecret = await GitHubSecret(testId, {
          owner,
          repository,
          name: secretName,
          value: updatedSecretValue,
        });

        expect(updatedSecret.id).toEqual(ghSecret.id);
      } catch (error: any) {
        console.error(`Test error: ${error.message}`);
        throw error;
      } finally {
        await destroy(scope);
      }
    }
  );
});
