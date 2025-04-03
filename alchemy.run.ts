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
import { Role, getAccountId } from "./alchemy/src/aws";
import { GitHubOIDCProvider } from "./alchemy/src/aws/oidc";
import { DnsRecords, R2Bucket, Zone } from "./alchemy/src/cloudflare";
import { ImportDnsRecords } from "./alchemy/src/dns";
import { GitHubSecret } from "./alchemy/src/github";
import { AstroProject } from "./alchemy/src/web/astro";

const app = alchemy("github:alchemy", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--verbose") ? false : true,
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
    }),
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
      r.type !== "SOA",
  ),
});

console.log({
  bucketName: stateStore.name,
  nameservers: zone.nameservers,
});

if (process.argv.includes("--astro")) {
  const astro = await AstroProject("astro", {
    name: "alchemy-web",
    delete: true,
    integrations: ["react", "tailwind"],
    shadcn: {
      defaults: true,
      components: ["button", "card", "input", "label", "sheet", "table"],
    },
  });
}

await app.finalize();

// cloudflare vite plugin requires a wrangler.json file
// await WranglerJson("alchemy.run wrangler.json", {
//   name: "alchemy",
//   compatibility_date: "2024-01-01",
//   path: "alchemy.run/wrangler.jsonc",
// });

// const theme = await CustomTheme("theme", {
//   outDir: ".vitepress/theme",
//   title: "Alchemy",
//   description: "Agentic Infrastructure as Code 🪄",
//   prompt: await alchemy`
//     Create a custom theme for the Alchemy documentation site.
//     Use pastel colors like #FFB6C1 and #87CEEB.
//     Use a modern and clean design.
//   `,
//   model: {
//     id: "claude-3-7-sonnet-latest",
//     provider: "anthropic",
//   },
// });

// const [home, gettingStarted, providers] = await Promise.all([
//   HomePage("home", {
//     outFile: "index.md",
//     title: "Alchemy",
//     hero: {
//       name: "Alchemy",
//       text: "Agentic Infrastructure as Code 🪄",
//       tagline: "Building the assembly-line for self-generating software",
//       image: {
//         src: "./public/alchemist.png",
//         alt: "The Alchemist",
//       },
//       actions: [
//         {
//           text: "Get Started",
//           link: "/docs",
//           theme: "brand",
//         },
//       ],
//     },
//     prompt: await alchemy`
//       Using HTML below the frontmatter, create a feature showcase section with:

//       1. A centered main heading "Features"
//       2. A left-to-right alternating layout of 4 features:
//         - Resources for Cloud Services (show the Secret, Static Site and Worker example from ${alchemy.file("../README.md")} and ${alchemy.file("../examples/cloudflare-vite/alchemy.run.ts")})
//         - Automated development of new Resources using Agentic IDEs (Cursor, Windsurf, etc) (leave example as TODO)
//         - Agentic Resources (show a concise example from ${alchemy.files(
//           "./src/providers.ts",
//           "./src/project.ts",
//           "./src/getting-started.ts",
//         )})
//         - Organizational Tree (show the ${alchemy.file("./alchemy.run.ts")} example)

//       Make sure each feature has a code block with syntax highlighting. Use vitepress for syntax highlighting.
//       Do not over explain: 1 short sentence per feature is enough.
//       Do not use markdown for the feature section.
//       # Features <- (not this)
//     `,
//   }),
//   GettingStarted({
//     outDir: docs,
//   }),
//   AlchemyProviderDocs({
//     filter: true,
//     outDir: docs,
//   }),
//   // TODO: add other docs
// ]);

// export const project = await AlchemyProject({
//   hero: {
//     text: "Agentic Infrastructure as Code 🪄",
//     // text: "Agentic IaC 🪄",
//     // tagline: "IaC for Gen-AI",
//     // tagline: "IaC that's as simple as bunx",
//     // tagline: "Portable infrastructure, in a language you and LLMs just know",
//     tagline: "Agentic Infrastructure-as-Code in pure TypeScript",
//   },
//   docs: {
//     providers,
//   },
// });

// if (process.argv.includes("--deploy")) {
//   const site = await StaticSite("alchemy.run site", {
//     name: "alchemy",
//     dir: ".vitepress/dist",
//     domain: "alchemy.run",
//     build: {
//       command: "bun run docs:build",
//     },
//   });

//   console.log({
//     url: site.url,
//   });
// }
