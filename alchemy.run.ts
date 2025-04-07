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

import path from "node:path";
import alchemy from "./alchemy/src";
import { AccountId, Role } from "./alchemy/src/aws";
import { GitHubOIDCProvider } from "./alchemy/src/aws/oidc";
import {
  AccountApiToken,
  CloudflareAccountId,
  DnsRecords,
  PermissionGroups,
  R2Bucket,
  StaticSite,
  Zone,
} from "./alchemy/src/cloudflare";
import { ImportDnsRecords } from "./alchemy/src/dns";
import { CopyFile, Folder } from "./alchemy/src/fs";
import { GitHubSecret } from "./alchemy/src/github";
import { GettingStarted } from "./alchemy/src/internal/getting-started";
import { AlchemyProviderDocs } from "./alchemy/src/internal/providers";
import { Tutorial } from "./alchemy/src/internal/tutorial";
import {
  HomePage,
  VitePressConfig,
  VitepressProject,
} from "./alchemy/src/web/vitepress";

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
  const vitepress = await VitepressProject("vitepress", {
    name: "alchemy-web",
    delete: true,
  });

  const docsPublic = await Folder("docs-public", {
    path: path.join(vitepress.dir, "public"),
  });

  await CopyFile("docs-public-alchemist", {
    src: path.join(process.cwd(), "public", "alchemist.webp"),
    dest: path.join(docsPublic.path, "alchemist.webp"),
  });

  await HomePage("docs-home", {
    outFile: path.join(vitepress.dir, "index.md"),
    title: "Alchemy",
    hero: {
      name: "Alchemy",
      text: "Create Update Delete",
      tagline:
        "Agentic Infrastructure-as-Code workflows in pure async TypeScript that runs anywhere",
      // "A minimal, embeddable, JS-native Infrastructure-as-Code library optimized for Gen-AI",
      // "Building the Assembly Line for self-generated software and services",
      image: {
        src: "/alchemist.webp",
        alt: "The Alchemist",
      },
      actions: [
        {
          text: "Get Started",
          link: "/docs/getting-started",
          theme: "brand",
        },
      ],
    },
  });

  const docs = await Folder("docs", {
    path: path.join(vitepress.dir, "docs"),
  });

  const providers = await Folder("providers", {
    path: path.join(docs.path, "providers"),
  });

  const filterIdx = process.argv.findIndex((arg) => arg === "--filter");

  const providersDocs = await AlchemyProviderDocs({
    srcDir: path.join("alchemy", "src"),
    outDir: providers.path,
    // anthropic throttles are painful, so we'll run them serially
    parallel: false,
    filter:
      process.argv[filterIdx + 1] === "true"
        ? true
        : filterIdx > -1
          ? isNaN(parseInt(process.argv[filterIdx + 1]))
            ? false
            : parseInt(process.argv[filterIdx + 1])
          : false,
  });

  const gettingStarted = await GettingStarted({
    path: path.join(docs.path, "getting-started.md"),
    prompt: await alchemy`
      1. bun add alchemy - make sure to take this opportunity to explain how there is nothing special alchemy.run.ts and you can run alchemy code anywhere (it's just a script)
      2. a minimal alchemy.run.ts
      3. create a single a File Resource
      4. run bun ./alchemy.run.ts
      5. describe how it would have created a file
      5. introduce the .alchemy/ folder structure and the state file
      6. remove the resource and run again, show how the file is now gone 
      7. show how also the state file is gone

      Next Steps:
      1. Jump to examples.
      2. See the Guide on how to deploy to Cloudflare.

      See ${alchemy.file("./README.md")} to understand the overview of Alchemy.
      See ${alchemy.file("./.cursorrules")} to better understand the structure and conventions of Alchemy.
      See ${alchemy.file("./alchemy/test/cloudflare/worker.test.ts")} for an example of how testing works.
    `,
  });

  // Create tutorials directory
  const tutorials = await Folder("tutorials", {
    path: path.join(docs.path, "tutorials"),
  });

  const rules = `Always use bun as the package manager and to run scripts.`;

  if (process.argv.includes("--tutorials")) {
    // Tutorial 1: Deploying a Cloudflare Worker and Static Site

    await Tutorial("cloudflare-worker", {
      path: path.join(
        tutorials.path,
        "deploy-cloudflare-worker-and-static-site.md"
      ),
      title: "Deploying a Cloudflare Worker and Static Site",
      difficulty: "beginner",
      estimatedTime: 5,
      prompt: await alchemy`
        Create a comprehensive tutorial on how to deploy a Cloudflare Worker and Static Site using Alchemy.
  
        The tutorial should cover:
        1. Refer the reader to Getting Started to set up a project.
        2. Iniitalize a vite project with bun create vite
          bun create vite my-alchemy-app --template react-ts
        3. Create a StaticSite and configure it to build the vite project and deploy to cloudflare
        4. console.log({ url: staticSite.url }) 
        5. Prompt them to run \`bun ./alchemy.run\` and explain the output (provide snippet of example)
        6. Now move on to designing an API by creating src/api.ts and initialize a hono app that serves data out of env.DB.get()
        7. Create a KV Namespace
        8. Create a Worker and bind the KV namespace
        9. Introduce env.d.ts and show how to infer the binding types by import type { apiWorker }
        10. Update the App.tsx to fetch data from the API
        11. Prompt them to run \`bun ./alchemy.run\` again.
        12. Show the output of the worker and static site
  
        Include code examples and explanations for each step.
  
        Reference these files for implementation details:
        - ${alchemy.file(gettingStarted.path!)}
        - ${alchemy.file("./alchemy/src/cloudflare/worker.ts")} 
        - ${alchemy.file("./alchemy/src/cloudflare/static-site.ts")} 
        - ${alchemy.file("./alchemy/test/cloudflare/worker.test.ts")} 
        - ${alchemy.file("./alchemy/test/cloudflare/static-site.test.ts")} 
        - ${alchemy.file("./alchemy/src/cloudflare/kv-namespace.ts")} 
        - ${alchemy.file("./alchemy/test/cloudflare/kv-namespace.test.ts")}
        - ${alchemy.file("./examples/cloudflare-vite/src/env.d.ts")}
  
        Make sure to explain how to set up the necessary environment variables and configuration.
  
        ${rules}
  
        See ${alchemy.file("./examples/cloudflare-vite/alchemy.run.ts")} to understand how alchemy.run.ts is used to deploy the worker and static site.
      `,
    });

    // Tutorial 2: Bundling and Deploying an AWS Lambda Function
    // await Tutorial("aws-lambda-function", {
    //   path: path.join(tutorials.path, "deploy-aws-lambda-function.md"),
    //   title: "Bundling and Deploying an AWS Lambda Function",
    //   difficulty: "beginner",
    //   estimatedTime: 5,
    //   prompt: await alchemy`
    //     Create a comprehensive tutorial on how to bundle and deploy an AWS Lambda Function using Alchemy.

    //     The tutorial should cover:
    //     1. Setting up a new project with Alchemy
    //     2. Creating an AWS Lambda Function
    //     3. Bundling the function code
    //     4. Setting up IAM roles and permissions
    //     5. Deploying the function
    //     6. Testing the function

    //     Include code examples and explanations for each step.

    //     Reference these files for implementation details:
    //     - ${alchemy.file("./alchemy/src/aws/function.ts")} - For Lambda implementation
    //     - ${alchemy.file("./alchemy/src/aws/role.ts")} - For IAM role implementation
    //     - ${alchemy.file("./alchemy/test/aws/function.test.ts")} - For testing examples

    //     Make sure to explain how to set up the necessary environment variables and configuration.
    //     Include information about different runtime environments and how to bundle dependencies.

    //     ${rules}

    //     See ${alchemy.file("./examples/aws-app/alchemy.run.ts")} to understand how alchemy.run.ts is used to deploy the lambda function.
    //   `,
    // });
  }

  await VitePressConfig({
    cwd: vitepress.dir,
    title: "Alchemy",
    description: "Alchemy Docs",
    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Docs", link: "/docs/getting-started" },
      ],
      sidebar: [
        {
          text: "Getting Started",
          link: "/docs/getting-started",
        },
        {
          text: "Tutorials",
          link: "/docs/tutorials/deploy-cloudflare-worker-and-static-site",
          collapsed: false,
          items: [
            {
              text: "Deploying a Cloudflare Worker and Static Site",
              link: "/docs/tutorials/deploy-cloudflare-worker-and-static-site",
            },
            {
              text: "Bundling and Deploying an AWS Lambda Function",
              link: "/docs/tutorials/deploy-aws-lambda-function",
            },
          ],
        },
        {
          text: "Providers",
          link: "/docs/providers",
          collapsed: false,
          items: providersDocs
            .sort((a, b) => a.provider.localeCompare(b.provider))
            .map((p) => ({
              text: p.provider,
              collapsed: true,
              items: p.documents
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((r) => ({
                  text: r.title,
                  link: `/docs/providers/${p.provider}/${path.basename(r.path!)}`,
                })),
            })),
        },
      ],
    },
  });

  if (process.argv.includes("--publish")) {
    const site = await StaticSite("alchemy.run site", {
      name: "alchemy",
      dir: path.join(vitepress.dir, ".vitepress", "dist"),
      domain: "alchemy.run",
      build: {
        command: "bun run --filter=alchemy-web docs:build",
      },
    });

    console.log("Site URL:", site.url);
  }
}

await app.finalize();
