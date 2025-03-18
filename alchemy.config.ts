import "dotenv/config";
import { alchemize } from "./src";
import { Role, getAccountId } from "./src/aws";
import { GitHubOIDCProvider } from "./src/aws/oidc";

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
      },
    ],
  },
  // TODO: probably scope this down
  managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
});

const oidc = new GitHubOIDCProvider("github-oidc", {
  owner: "sam-goodwin",
  repository: "alchemy",
  roleArn: githubRole.arn,
});

alchemize({
  mode: process.argv.includes("--destroy") ? "destroy" : "up",
  // quiet: process.argv.includes("--verbose") ? false : true,
  stage: "github:alchemy",
});
