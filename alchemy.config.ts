// @ts-nocheck
import "dotenv/config";
import { alchemize } from "./src";
import { Role, getAccountId } from "./src/aws";
import { GitHubOIDCProvider } from "./src/aws/oidc";
import { GitHubSecret } from "./src/github";

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

const roleArnSecret = new GitHubSecret("aws-role-arn-secret", {
  owner: "sam-goodwin",
  repository: "alchemy",
  name: "AWS_ROLE_ARN",
  value: githubRole.arn,
  // token: "your-github-token", // Optional: provide token directly
});

alchemize({
  mode: process.argv.includes("--destroy") ? "destroy" : "up",
  // quiet: process.argv.includes("--verbose") ? false : true,
  stage: "github:alchemy",
});
