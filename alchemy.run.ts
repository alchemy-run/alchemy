// ensure providers are registered (for deletion purposes)
import "./alchemy/src/ai";
import "./alchemy/src/aws";
import "./alchemy/src/aws/oidc";
import "./alchemy/src/cloudflare";
import "./alchemy/src/dns";
import "./alchemy/src/fs";
import "./alchemy/src/stripe";
import "./alchemy/src/web/astro";
import "./alchemy/src/web/vite";
import "./alchemy/src/web/vitepress";

import alchemy from "./alchemy/src";
import { AccountId, Role } from "./alchemy/src/aws";
import { GitHubOIDCProvider } from "./alchemy/src/aws/oidc";
import {
  AccountApiToken,
  CloudflareAccountId,
  DnsRecords,
  PermissionGroups,
  R2Bucket,
  Zone,
} from "./alchemy/src/cloudflare";
import { ImportDnsRecords } from "./alchemy/src/dns";
import { GitHubSecret } from "./alchemy/src/github";
import { DocumentationSite } from "./alchemy/src/internal";
const app = alchemy("github:alchemy", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--quiet"),
});

const cfEmail = await alchemy.env("CLOUDFLARE_EMAIL");

const cfApiKey = await alchemy.secret.env("CLOUDFLARE_API_KEY");

const cfAccountId = await CloudflareAccountId({
  email: cfEmail,
  apiKey: cfApiKey,
});

const zone = await Zone("alchemy.run", {
  name: "alchemy.run",
  type: "full",
});

const permissions = await PermissionGroups("cloudflare-permissions", {
  // TODO: remove this once we have a way to get the account ID from the API
  accountId: cfAccountId,
});

const accountAccessToken = await AccountApiToken("account-access-token", {
  name: "alchemy-account-access-token",
  policies: [
    {
      effect: "allow",
      permissionGroups: [{ id: permissions["Workers R2 Storage Write"].id }],
      resources: {
        [`com.cloudflare.api.account.${cfAccountId}`]: "*",
      },
    },
  ],
});

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

await Promise.all([
  GitHubOIDCProvider("github-oidc", {
    owner: "sam-goodwin",
    repository: "alchemy",
    roleArn: githubRole.arn,
  }),
  ...Object.entries({
    AWS_ROLE_ARN: githubRole.arn,
    CLOUDFLARE_ACCOUNT_ID: cfAccountId,
    CLOUDFLARE_API_KEY: cfApiKey,
    CLOUDFLARE_EMAIL: cfEmail,
    STRIPE_API_KEY: alchemy.secret.env("STRIPE_API_KEY"),
    OPENAI_API_KEY: alchemy.secret.env("OPENAI_API_KEY"),
    CLOUDFLARE_BUCKET_NAME: stateStore.name,
    R2_ACCESS_KEY_ID: accountAccessToken.id,
    R2_SECRET_ACCESS_KEY: accountAccessToken.value,
  }).map(async ([name, value]) =>
    GitHubSecret(`github-secret-${name}`, {
      owner: "sam-goodwin",
      repository: "alchemy",
      name,
      value: typeof value === "string" ? alchemy.secret(value) : await value!,
    })
  ),
]);

const { records } = await ImportDnsRecords("dns-records", {
  domain: "alchemy.run",
  bump: 2,
});

await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: records.filter(
    (r) =>
      // cloudflare doesn't support SOA
      // @see https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-create-dns-record
      r.type !== "SOA"
  ),
});

if (process.argv.includes("--vitepress")) {
  await DocumentationSite();
}

await app.finalize();
