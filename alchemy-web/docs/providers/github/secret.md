# GitHub Secret

The GitHub Secret resource lets you manage [GitHub Actions secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets) in your repositories.

# Minimal Example

Create a secret in a GitHub repository using the GITHUB_TOKEN environment variable.

```ts
import { GitHubSecret } from "alchemy/github";

const secret = await GitHubSecret("api-key", {
  owner: "my-github-username",
  repository: "my-repo", 
  name: "API_KEY",
  value: alchemy.secret("my-secret-value")
});
```

# Create Multiple Secrets

Create multiple secrets in a repository using environment variables.

```ts
import { GitHubSecret } from "alchemy/github";

const secrets = await Promise.all([
  GitHubSecret("aws-secret", {
    owner: "my-github-username",
    repository: "cloud-app",
    name: "AWS_ROLE_ARN", 
    value: alchemy.secret(process.env.AWS_ROLE_ARN)
  }),
  GitHubSecret("cf-secret", {
    owner: "my-github-username", 
    repository: "cloud-app",
    name: "CLOUDFLARE_API_KEY",
    value: alchemy.secret(process.env.CLOUDFLARE_API_KEY)
  })
]);
```

# Create Secret with Custom Token

Create a secret using a custom GitHub token instead of environment variables.

```ts
import { GitHubSecret } from "alchemy/github";

const secret = await GitHubSecret("deploy-secret", {
  owner: "my-github-username",
  repository: "my-app",
  name: "DEPLOY_TOKEN",
  value: alchemy.secret(process.env.DEPLOY_TOKEN),
  token: alchemy.secret(process.env.CUSTOM_GITHUB_TOKEN)
});
```