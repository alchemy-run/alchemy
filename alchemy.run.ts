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

import fs from "node:fs/promises";
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
import { Providers } from "./alchemy/src/internal/docs/providers";
import { VitePressConfig, VitepressProject } from "./alchemy/src/web/vitepress";

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

  const providersDocs = await Providers({
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

  await VitePressConfig({
    cwd: project.dir,
    title: "Alchemy",
    description: "Alchemy Docs",
    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Docs", link: "/docs/getting-started" },
      ],
      socialLinks: [
        { icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
        { icon: "x", link: "https://twitter.com/samgoodwin89" },
        // { icon: "discord", link: "https://discord.gg/MJr7pYzZQ4" },
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
          link: "/docs/concepts",
          collapsed: false,
          items: await processFrontmatterFiles(
            conceptsDir.path,
            "/docs/concepts"
          ),
        },
        {
          text: "Guides",
          link: "/guides",
          collapsed: false,
          items: await processFrontmatterFiles(guides.path, "/docs/guides"),
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
                .map((r) => {
                  const name = path.basename(r.path!);
                  const text = name.charAt(0).toUpperCase() + name.slice(1);
                  return {
                    text: text.replace(".md", ""),
                    link: `/docs/providers/${p.provider}/${name}`,
                  };
                }),
            })),
        },
      ],
    },
  });

  const site = await StaticSite("static-site", {
    name: "alchemy-web",
    dir: path.join(project.dir, ".vitepress", "dist"),
    // domain: "alchemy.run",
    build: {
      command: "bun run --filter alchemy-web docs:build",
    },
  });

  console.log("Site URL:", site.url);
});

/**
 * Process markdown files with frontmatter to generate navigation items
 * @param directoryPath The directory containing markdown files
 * @param linkPrefix The prefix for navigation links
 * @returns Sorted array of navigation items with text and link properties
 */
async function processFrontmatterFiles(
  directoryPath: string,
  linkPrefix: string
) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  const processedEntries = await Promise.all(
    entries
      .filter((entry) => !entry.name.endsWith("index.md"))
      .map(async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          // Process subdirectory recursively
          const items = await processFrontmatterFiles(
            fullPath,
            `${linkPrefix}/${entry.name}`
          );

          // Create section for subdirectory
          return {
            text: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
            collapsed: true,
            items,
            order: 10000, // Default order for directories
          };
        }

        // Process markdown file
        if (!entry.name.endsWith(".md")) {
          return null;
        }

        const content = await fs.readFile(fullPath, "utf-8");
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let order = 10000;
        let title;

        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          const orderMatch = frontmatter.match(/order:\s*(\d+)/);
          if (orderMatch) {
            order = parseInt(orderMatch[1]);
          }
          const titleMatch = frontmatter.match(/title:\s*(.+)/);
          if (titleMatch) {
            title = titleMatch[1].trim();
          }
        }

        // If no title in frontmatter, try to get first heading
        if (!title) {
          const headingMatch = content.match(/^#\s+(.+)$/m);
          if (headingMatch) {
            title = headingMatch[1].trim();
          }
        }

        // Fall back to filename if no title found
        if (!title) {
          const name = entry.name.replace(".md", "");
          title = name.charAt(0).toUpperCase() + name.slice(1);
        }

        return {
          text: title,
          link: `${linkPrefix}/${entry.name}`,
          order,
        };
      })
  );

  // Filter out null entries and sort by order
  return processedEntries
    .filter((entry) => entry !== null)
    .sort((a, b) => a.order - b.order)
    .map(({ text, link, items }) =>
      items ? { text, items, collapsed: true } : { text, link }
    );
}

// export const site = await StaticSite("alchemy.run site", {
//   name: "alchemy",
//   dir: path.join(project.dir, ".vitepress", "dist"),
//   domain: "alchemy.run",
//   build: {
//     command: "bun run --filter=alchemy-web docs:build",
//   },
// });

// console.log("Site URL:", site.url);

await app.finalize();
