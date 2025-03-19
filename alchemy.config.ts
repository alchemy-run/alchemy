import "dotenv/config";

import { alchemize } from "./src";
import { Role, getAccountId } from "./src/aws";
import { GitHubOIDCProvider } from "./src/aws/oidc";
import { GitHubSecret } from "./src/github";
import { getGitHubTokenFromCLI } from "./src/github/client";

const accountId = await getAccountId();

const githubRole = new Role("github-oidc-role", {
  roleName: "alchemy-github-oidc-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "GitHubOIDC",
        Effect: "Allow",
        Principal: {
          Federated: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub":
              "repo:sam-goodwin/alchemy:*",
          },
        },
      },
    ],
  },
  // TODO: probably scope this down
  managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
});

// Set up the GitHub OIDC provider
const oidc = new GitHubOIDCProvider("github-oidc", {
  owner: "sam-goodwin",
  repository: "alchemy",
  roleArn: githubRole.arn,
});

// Get GitHub token with full repo access from CLI (if available)

const githubSecrets = {
  AWS_ROLE_ARN: githubRole.arn,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
  STRIPE_API_KEY: process.env.STRIPE_API_KEY,
  ADMIN_GITHUB_ACCESS_TOKEN: await getGitHubTokenFromCLI(),
};

for (const [name, value] of Object.entries(githubSecrets)) {
  if (value) {
    new GitHubSecret(`github-secret-${name}`, {
      owner: "sam-goodwin",
      repository: "alchemy",
      name,
      value,
    });
  }
}

alchemize({
  mode: process.argv.includes("--destroy") ? "destroy" : "up",
  // quiet: process.argv.includes("--verbose") ? false : true,
  stage: "github:alchemy",
});
