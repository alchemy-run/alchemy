# GitHub Secret

The GitHub Secret resource allows you to manage [GitHub repository secrets](https://docs.github.com/en/rest/actions/secrets) securely. It supports creating, updating, and deleting secrets using the GitHub API.

# Minimal Example

```ts
import { GitHubSecret } from "alchemy/github";

const secret = await GitHubSecret("my-secret", {
  owner: "my-github-username",
  repository: "my-repo",
  name: "API_KEY",
  value: alchemy.secret("my-secret-value")
});
```

# Create the GitHub Secret

```ts
import { GitHubSecret } from "alchemy/github";

// Create a secret using a custom GitHub token
const secret = await GitHubSecret("my-secret", {
  owner: "my-github-username",
  repository: "my-repo",
  name: "API_KEY",
  value: alchemy.secret("my-secret-value"),
  token: alchemy.secret(process.env.CUSTOM_GITHUB_TOKEN)
});
```