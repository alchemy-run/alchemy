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
import { Role, getAccountId } from "./alchemy/src/aws";
import { GitHubOIDCProvider } from "./alchemy/src/aws/oidc";
import {
  DnsRecords,
  R2Bucket,
  StaticSite,
  Zone,
} from "./alchemy/src/cloudflare";
import { ImportDnsRecords } from "./alchemy/src/dns";
import { CopyFile, Folder } from "./alchemy/src/fs";
import { GitHubSecret } from "./alchemy/src/github";
import { GettingStarted } from "./alchemy/src/internal/getting-started";
import { AlchemyProviderDocs } from "./alchemy/src/internal/providers";
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

const stateStore = await R2Bucket("state-store", {
  name: "alchemy-state-store",
});

const githubSecrets = {
  AWS_ROLE_ARN: githubRole.arn,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
  STRIPE_API_KEY: process.env.STRIPE_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CLOUDFLARE_BUCKET_NAME: stateStore.name,
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
    })
  ),
]);

const zone = await Zone("alchemy.run", {
  name: "alchemy.run",
  type: "full",
});

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

console.log({
  bucketName: stateStore.name,
  nameservers: zone.nameservers,
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
      text: "Agentic Infrastructure as Code 🪄",
      tagline: "Building the assembly-line for self-generating software",
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
    filter:
      process.argv[filterIdx + 1] === "true"
        ? true
        : filterIdx > -1
          ? isNaN(parseInt(process.argv[filterIdx + 1]))
            ? false
            : parseInt(process.argv[filterIdx + 1])
          : false,
  });

  await GettingStarted({
    path: path.join(docs.path, "getting-started.md"),
  });

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
          text: "Providers",
          link: "/docs/providers",
          collapsed: false,
          items: providersDocs.map((p) => ({
            text: p.provider,
            collapsed: true,
            items: p.documents.map((r) => ({
              text: r.title,
              link: `/docs/providers/${p.provider}/${path.basename(r.path)}`,
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

    console.log({
      url: site.url,
    });
  }
}

await app.finalize();
