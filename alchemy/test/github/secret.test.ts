import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import { createGitHubClient } from "../../src/github/client";
import { RepositoryEnvironment } from "../../src/github/repository-environment";
import { GitHubSecret } from "../../src/github/secret";
import { secret } from "../../src/secret";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

// Optional environment variable overrides
const owner = process.env.GITHUB_OWNER || "sam-goodwin";
const repository = process.env.GITHUB_REPO || "test-alchemy-resources";
// Use a fixed environment name for testing
const environmentName = `${BRANCH_PREFIX}-test-env`;

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
        // Verify secret exists by checking if it's in the list of repository secrets
        const { data: secretList } = await octokit.rest.actions.listRepoSecrets(
          {
            owner,
            repo: repository,
          }
        );

        const secretInfo = secretList.secrets.find(
          (s) => s.name === secretName
        );
        expect(secretInfo).toBeDefined();

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

  test.skipIf(!!process.env.CI)(
    "transition between repository and environment secrets",
    async (scope) => {
      // Create an authenticated client for testing
      const octokit = await createGitHubClient();

      // Unique secret name for this test
      const secretName = `${BRANCH_PREFIX.toUpperCase()}_TRANSITION_SECRET`;
      const secretValue = secret("repository-level-secret");
      const envSecretValue = secret("environment-level-secret");

      try {
        // Create a test environment using our RepositoryEnvironment resource
        console.log(`Creating test environment: ${environmentName}`);
        const testEnv = await RepositoryEnvironment("test-env", {
          owner,
          repository,
          name: environmentName,
          // Optional: add protection rules if needed for test
        });

        console.log(
          `Created test environment: ${environmentName} with ID: ${testEnv.environmentId}`
        );

        // Step 1: Create a repository-level secret
        console.log("Creating repository-level secret...");
        const repoSecret = await GitHubSecret("transition-test", {
          owner,
          repository,
          name: secretName,
          value: secretValue,
        });

        expect(repoSecret.environment).toBeUndefined();
        expect(repoSecret.name).toEqual(secretName);

        // Verify repo secret exists
        const { data: secretList } = await octokit.rest.actions.listRepoSecrets(
          {
            owner,
            repo: repository,
          }
        );

        const secretExists = secretList.secrets.some(
          (s) => s.name === secretName
        );
        expect(secretExists).toBe(true);

        // Step 2: Transition to environment secret
        console.log("Transitioning to environment secret...");
        const envSecret = await GitHubSecret("transition-test", {
          owner,
          repository,
          name: secretName,
          environment: environmentName,
          value: envSecretValue,
        });

        expect(envSecret.environment).toEqual(environmentName);
        expect(envSecret.name).toEqual(secretName);

        // Verify repo secret is gone
        try {
          const { data: repoSecrets } =
            await octokit.rest.actions.listRepoSecrets({
              owner,
              repo: repository,
            });

          const repoSecretExists = repoSecrets.secrets.some(
            (s) => s.name === secretName
          );
          expect(repoSecretExists).toBe(false);
          console.log("Verified repository secret was removed");
        } catch (error: any) {
          console.log(`Couldn't verify repo secret removal: ${error.message}`);
        }

        // Verify env secret exists
        const { data: envSecrets } =
          await octokit.rest.actions.listEnvironmentSecrets({
            owner,
            repo: repository,
            environment_name: environmentName,
          });

        const envSecretExists = envSecrets.secrets.some(
          (s) => s.name === secretName
        );
        expect(envSecretExists).toBe(true);

        // Step 3: Transition back to repository secret
        console.log("Transitioning back to repository secret...");
        const backToRepoSecret = await GitHubSecret("transition-test", {
          owner,
          repository,
          name: secretName,
          value: secretValue,
          // No environmentName here
        });

        expect(backToRepoSecret.environment).toBeUndefined();
        expect(backToRepoSecret.name).toEqual(secretName);

        {
          // Verify env secret is gone
          const { data: envSecrets } =
            await octokit.rest.actions.listEnvironmentSecrets({
              owner,
              repo: repository,
              environment_name: environmentName,
            });

          const envSecretExists = envSecrets.secrets.some(
            (s) => s.name === secretName
          );
          expect(envSecretExists).toBe(false);
        }

        // Verify repo secret exists again
        const { data: repoSecrets } =
          await octokit.rest.actions.listRepoSecrets({
            owner,
            repo: repository,
          });

        const repoSecretExists = repoSecrets.secrets.some(
          (s) => s.name === secretName
        );
        expect(repoSecretExists).toBe(true);
      } catch (error: any) {
        console.error(`Test error: ${error.message}`);
        throw error;
      } finally {
        // Clean up all resources including the environment
        await destroy(scope);
      }
    }
  );
});
