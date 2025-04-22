// ensure providers are registered (for deletion purposes)
import "../alchemy/src/aws";
import "../alchemy/src/aws/oidc";
import "../alchemy/src/cloudflare";
import "../alchemy/src/os";

import alchemy from "../alchemy/src";
import { AccountId, Role } from "../alchemy/src/aws";
import { GitHubOIDCProvider } from "../alchemy/src/aws/oidc";
import {
  AccountApiToken,
  PermissionGroups,
  R2Bucket,
} from "../alchemy/src/cloudflare";
import { GitHubSecret, RepositoryEnvironment } from "../alchemy/src/github";
import env, {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_KEY,
  CLOUDFLARE_EMAIL,
  OPENAI_API_KEY,
  STRIPE_API_KEY,
} from "./env";

const app = await alchemy("alchemy:repo", env);

const awsAccountId = await AccountId();

const githubRole = await Role("github-oidc-role", {
  roleName: "alchemy-github-oidc-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "GitHubOIDC",
        Effect: "Allow",
        Principal: {
          Federated: `arn:aws:iam::${awsAccountId}:oidc-provider/token.actions.githubusercontent.com`,
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

const stateStore = await R2Bucket("state-store", {
  name: "alchemy-state-store",
});

const testEnvironment = await RepositoryEnvironment("test environment", {
  owner: "sam-goodwin",
  repository: "alchemy",
  name: "test",
  reviewers: {
    users: ["sam-goodwin"],
  },
});

const permissions = await PermissionGroups("cloudflare-permissions", {
  // TODO: remove this once we have a way to get the account ID from the API
  accountId: CLOUDFLARE_ACCOUNT_ID,
});

const accountAccessToken = await AccountApiToken("account-access-token", {
  name: "alchemy-account-access-token",
  policies: [
    {
      effect: "allow",
      permissionGroups: [{ id: permissions["Workers R2 Storage Write"].id }],
      resources: {
        [`com.cloudflare.api.account.${CLOUDFLARE_ACCOUNT_ID}`]: "*",
      },
    },
  ],
});

await Promise.all([
  GitHubOIDCProvider("github-oidc", {
    owner: "sam-goodwin",
    repository: "alchemy",
    roleArn: githubRole.arn,
  }),
  ...Object.entries({
    AWS_ROLE_ARN: githubRole.arn,
    CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_KEY,
    CLOUDFLARE_EMAIL,
    STRIPE_API_KEY,
    OPENAI_API_KEY,
    CLOUDFLARE_BUCKET_NAME: stateStore.name,
    R2_ACCESS_KEY_ID: accountAccessToken.accessKeyId,
    R2_SECRET_ACCESS_KEY: accountAccessToken.secretAccessKey,
  }).flatMap(async ([name, value]) => {
    const props = {
      owner: "sam-goodwin",
      repository: "alchemy",
      name,
      value: typeof value === "string" ? alchemy.secret(value) : await value!,
    };
    return [
      GitHubSecret(`github-secret-${name}`, {
        ...props,
        environment: testEnvironment.name,
      }),
      GitHubSecret(`github-repo-secret-${name}`, props),
    ];
  }),
]);

await app.finalize();
