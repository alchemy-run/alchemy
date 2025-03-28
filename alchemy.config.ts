import alchemy from "./alchemy/src";

// ensure providers are registered
import "./alchemy/src/aws";
import "./alchemy/src/aws/oidc";
import "./alchemy/src/cloudflare";
import "./alchemy/src/vite";

import { Role, getAccountId } from "./alchemy/src/aws";
import { GitHubOIDCProvider } from "./alchemy/src/aws/oidc";
import { StaticSite, Zone } from "./alchemy/src/cloudflare";
import { GitHubSecret } from "./alchemy/src/github";
import { ViteProject } from "./alchemy/src/vite";

await using _ = alchemy("github:alchemy", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--verbose") ? false : true,
});

const zone = await Zone("alchemy.run", {
  name: "alchemy.run",
  type: "full",
});

console.log("nameservers:", zone.nameservers);

await ViteProject("alchemy.run package", {
  name: "alchemy.run",
  template: "react-ts",
  extends: "../tsconfig.base.json",
  references: ["../alchemy/tsconfig.json"],
  tailwind: true,
  tanstack: true,
  shadcn: {
    baseColor: "neutral",
    force: true,
    components: ["button", "card", "input", "label", "sheet", "table", "tabs"],
  },
  overwrite: true,
});

// cloudflare vite plugin requires a wrangler.json file
// await WranglerJson("alchemy.run wrangler.json", {
//   name: "alchemy",
//   compatibility_date: "2024-01-01",
//   path: "alchemy.run/wrangler.jsonc",
// });

const site = await StaticSite("alchemy.run site", {
  name: "alchemy",
  dir: "alchemy.run/dist",
  domain: "alchemy.run",
  build: {
    command: "bun run --filter alchemy.run build",
  },
});

console.log({
  url: site.url,
});

const accountId = await getAccountId();

const githubRole = await Role("github-oidc-role", {
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

const githubSecrets = {
  AWS_ROLE_ARN: githubRole.arn,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
  STRIPE_API_KEY: process.env.STRIPE_API_KEY,
};

await Promise.all([
  GitHubOIDCProvider("github-oidc", {
    owner: "sam-goodwin",
    repository: "alchemy",
    roleArn: githubRole.arn,
  }),
  ...Object.entries(githubSecrets).map(([name, value]) =>
    GitHubSecret(`github-secret-${name}`, {
      owner: "sam-goodwin",
      repository: "alchemy",
      name,
      value: alchemy.secret(value),
    }),
  ),
]);
