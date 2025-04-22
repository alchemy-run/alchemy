# GitHubSecret

The GitHubSecret resource lets you manage [GitHub Actions secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets) in repositories and environments.

# Minimal Example

Create a repository-level secret:

```ts
import { GitHubSecret } from "alchemy/github";

const secret = await GitHubSecret("api-key", {
  owner: "my-org",
  repository: "my-repo", 
  name: "API_KEY",
  value: alchemy.secret("secret-value")
});
```

# Environment Secret

Create a secret scoped to a specific environment:

```ts
import { GitHubSecret } from "alchemy/github";

const secret = await GitHubSecret("prod-key", {
  owner: "my-org",
  repository: "my-repo",
  name: "DEPLOY_KEY",
  value: alchemy.secret("secret-value"),
  environment: "production"
});
```

# Custom Token

Use a custom GitHub token instead of environment variables:

```ts
import { GitHubSecret } from "alchemy/github";

const secret = await GitHubSecret("api-key", {
  owner: "my-org",
  repository: "my-repo",
  name: "API_KEY", 
  value: alchemy.secret("secret-value"),
  token: alchemy.secret(process.env.CUSTOM_GITHUB_TOKEN)
});
```