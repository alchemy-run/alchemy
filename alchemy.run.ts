// ensure providers are registered (for deletion purposes)
import "./alchemy/src/ai";
import "./alchemy/src/aws";
import "./alchemy/src/aws/oidc";
import "./alchemy/src/cloudflare";
import "./alchemy/src/dns";
import "./alchemy/src/fs";
import "./alchemy/src/os";
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
  Assets,
  CustomDomain,
  DnsRecords,
  PermissionGroups,
  R2Bucket,
  Worker,
  Zone,
} from "./alchemy/src/cloudflare";
import { ImportDnsRecords } from "./alchemy/src/dns";
import { CopyFile, Folder } from "./alchemy/src/fs";
import { GitHubSecret, RepositoryEnvironment } from "./alchemy/src/github";
import { Providers } from "./alchemy/src/internal/docs/providers";
import { Exec } from "./alchemy/src/os";
import {
  VitePressConfig,
  VitepressProject,
  processFrontmatterFiles,
} from "./alchemy/src/web/vitepress";

const app = await alchemy("github:alchemy", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--quiet"),
});

const cfEmail = await alchemy.env("CLOUDFLARE_EMAIL");
const cfAccountId = await alchemy.env("CLOUDFLARE_ACCOUNT_ID");
const cfApiKey = await alchemy.secret.env("CLOUDFLARE_API_KEY");

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

const testEnvironment = await RepositoryEnvironment("test environment", {
  owner: "sam-goodwin",
  repository: "alchemy",
  name: "test",
  reviewers: {
    users: ["sam-goodwin"],
  },
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
    R2_ACCESS_KEY_ID: accountAccessToken.accessKeyId,
    R2_SECRET_ACCESS_KEY: accountAccessToken.secretAccessKey,
  }).map(async ([name, value]) =>
    GitHubSecret(`github-secret-${name}`, {
      owner: "sam-goodwin",
      repository: "alchemy",
      name,
      value: typeof value === "string" ? alchemy.secret(value) : await value!,
      environment: testEnvironment.name,
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

await alchemy.run("docs", async () => {
  const project = await VitepressProject("vitepress", {
    name: "alchemy-web",
    delete: true,
  });

  const docs = await Folder("docs", {
    path: path.join(project.dir, "docs"),
  });

  const [pub, blogs, guides, providers, conceptsDir] = await Promise.all([
    Folder("public", {
      path: path.join(project.dir, "public"),
    }),
    Folder("blogs", {
      path: path.join(project.dir, "blogs"),
    }),
    Folder("guides", {
      path: path.join(docs.path, "guides"),
    }),
    Folder("providers", {
      path: path.join(docs.path, "providers"),
    }),
    Folder("concepts", {
      path: path.join(docs.path, "concepts"),
    }),
  ]);

  await CopyFile("docs-public-alchemist", {
    src: path.join(process.cwd(), "public", "alchemist.webp"),
    dest: path.join(pub.path, "alchemist.webp"),
  });

  const filterIdx = process.argv.findIndex((arg) => arg === "--filter");

  await VitePressConfig({
    cwd: project.dir,
    title: "Alchemy",
    description: "Alchemy Docs",
    head: [
      ["link", { rel: "icon", type: "image/png", href: "/potion.png" }],
      // Open Graph
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:title", content: "Alchemy" }],
      ["meta", { property: "og:description", content: "Alchemy Docs" }],
      ["meta", { property: "og:url", content: "https://alchemy.run" }],
      // [
      //   "meta",
      //   {
      //     property: "og:image",
      //     content: "https://alchemy.run/alchemy-unfurl.png",
      //   },
      // ],
      // Twitter Card (similar to Open Graph)
      // ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:title", content: "Alchemy" }],
      ["meta", { name: "twitter:description", content: "Alchemy Docs" }],
      // [
      //   "meta",
      //   {
      //     name: "twitter:image",
      //     content: "https://alchemy.run/alchemy-unfurl.png",
      //   },
      // ],
    ],
    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Docs", link: "/docs/getting-started" },
      ],
      socialLinks: [
        { icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
        { icon: "discord", link: "https://discord.gg/jwKw8dBJdN" },
        { icon: "x", link: "https://twitter.com/samgoodwin89" },
      ],
      sidebar: [
        {
          text: "Get Started",
          link: "/docs/getting-started",
        },
        {
          text: "What is Alchemy?",
          link: "/docs/what-is-alchemy",
        },
        {
          text: "Concepts",
          collapsed: false,
          items: await processFrontmatterFiles(
            conceptsDir.path,
            "/docs/concepts"
          ),
        },
        {
          text: "Guides",
          collapsed: false,
          items: await processFrontmatterFiles(guides.path, "/docs/guides"),
        },
        {
          text: "Providers",
          collapsed: false,
          items: (
            await Providers({
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
            })
          )
            .sort((a, b) => a.provider.localeCompare(b.provider))
            .map((p) => ({
              text: p.provider,
              collapsed: true,
              items: p.documents
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((doc) => ({
                  text: doc.title.replaceAll(" ", ""),
                  link: `/docs/providers/${p.provider}/${path.basename(doc.path!, ".md")}`,
                })),
            })),
        },
      ],
    },
  });

  await Exec("build-site", {
    command: "bun run --filter alchemy-web docs:build",
  });

  const staticAssets = await Assets("static-assets", {
    path: path.join(project.dir, ".vitepress", "dist"),
  });

  const site = await Worker("website", {
    name: "alchemy-website",
    url: true,
    bindings: {
      ASSETS: staticAssets,
    },
    script: `
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`,
  });

  console.log("Site URL:", site.url);

  await CustomDomain("alchemy-web-domain", {
    name: "alchemy.run",
    zoneId: zone.id,
    workerName: site.name,
  });

  console.log(`https://alchemy.run`);
});

await app.finalize();
