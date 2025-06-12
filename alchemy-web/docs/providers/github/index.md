# GitHub

GitHub is a web-based version control and collaboration platform that provides Git repository hosting, issue tracking, project management, and CI/CD workflows. Alchemy provides resources to manage GitHub repositories, environments, secrets, and comments programmatically.

[Official GitHub Documentation](https://docs.github.com/) | [GitHub API Reference](https://docs.github.com/en/rest)

## Resources

- [Comment](./comment.md) - Create and manage comments on issues and pull requests
- [RepositoryEnvironment](./repository-environment.md) - Create and manage deployment environments with protection rules
- [Secret](./secret.md) - Create and manage GitHub Actions and Dependabot secrets

## Example Usage

```ts
import { Comment, RepositoryEnvironment, GitHubSecret } from "alchemy/github";

// Create a repository environment
const prodEnv = await RepositoryEnvironment("production", {
  owner: "my-org",
  repository: "my-repo",
  name: "production",
  waitTimer: 10,
  preventSelfReview: true,
  reviewers: {
    teams: ["platform-team"],
    users: ["security-admin"],
  },
  deploymentBranchPolicy: {
    protectedBranches: true,
    customBranchPolicies: false,
  },
});

// Create a secret for the environment
const secret = await GitHubSecret("deploy-key", {
  owner: "my-org",
  repository: "my-repo",
  name: "DEPLOY_KEY",
  value: alchemy.secret(process.env.DEPLOY_KEY),
  environment: "production",
});

// Add a deployment status comment to a PR
const deploymentComment = await Comment("deployment-status", {
  owner: "my-org",
  repository: "my-repo",
  issueNumber: 123,
  body: "✅ Successfully deployed to production environment!",
});
```