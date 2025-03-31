// ensure providers are registered (for deletion purposes)
import "./alchemy/src/aws";
import "./alchemy/src/aws/oidc";
import "./alchemy/src/cloudflare";
import "./alchemy/src/docs";
import "./alchemy/src/fs";
import "./alchemy/src/vite";
import "./alchemy/src/vitepress";

import fs from "fs/promises";
import path from "path";

import alchemy from "./alchemy/src";
import { Role, getAccountId } from "./alchemy/src/aws";
import { GitHubOIDCProvider } from "./alchemy/src/aws/oidc";
import { Zone } from "./alchemy/src/cloudflare";
import { Document } from "./alchemy/src/docs";
import { Folder } from "./alchemy/src/fs";
import { GitHubSecret } from "./alchemy/src/github";
import { VitePressProject } from "./alchemy/src/vitepress";

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

const githubSecrets = {
  AWS_ROLE_ARN: githubRole.arn,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
  STRIPE_API_KEY: process.env.STRIPE_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
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

console.log("nameservers:", zone.nameservers);

// await alchemyDocs({
//   // docs: 2,
// });

async function alchemyDocs(enabled: {
  docs?: boolean | number;
}) {
  await VitePressProject("docs", {
    name: "alchemy-web",
    title: "Alchemy",
    description: "Alchemy is a TypeScript-native, embeddable IaC library",
    overwrite: true,
    tsconfig: {
      extends: "../tsconfig.base.json",
      references: ["../alchemy/tsconfig.json"],
    },
    devDependencies: {
      alchemy: "workspace:*",
    },
    theme: {
      light: "light-plus",
      dark: "dark-plus",
    },
    home: {
      layout: "home",
      hero: {
        text: "Alchemy",
        tagline: "Alchemy is a TypeScript-native, embeddable IaC library",
        actions: [
          {
            text: "Get Started",
            link: "/docs",
            theme: "brand",
          },
        ],
      },
      features: [
        {
          title: "Easy to use",
          details: "Alchemy is easy to use and understand",
        },
      ],
    },
    themeConfig: {
      search: {
        provider: "local",
      },
      // https://vitepress.dev/reference/default-theme-config
      nav: [
        { text: "Docs", link: "/docs" },
        { text: "Examples", link: "/examples" },
      ],
      sidebar: {
        "/blog/": [
          {
            text: "Blog",
            items: [{ text: "Foo", link: "/blog/foo" }],
          },
        ],
        "/docs/": [
          {
            text: "Docs",
            items: [{ text: "Foo", link: "/docs/foo" }],
          },
        ],
        "/examples/": [
          {
            text: "Examples",
            items: [{ text: "Foo", link: "/examples/foo" }],
          },
        ],
        "/": [
          {
            text: "Home",
            items: [
              { text: "Markdown Examples", link: "/markdown-examples" },
              { text: "Runtime API Examples", link: "/api-examples" },
            ],
          },
        ],
      },
    },
  });

  const docs = await Folder(path.join("alchemy-web", "docs"));

  const exclude = ["util", "test"];

  // Get all folders in the alchemy/src directory
  let providers = (
    await fs.readdir(path.resolve("alchemy", "src"), {
      withFileTypes: true,
    })
  )
    .filter((dirent) => dirent.isDirectory() && !exclude.includes(dirent.name))
    .map((dirent) => path.join(dirent.parentPath, dirent.name));

  // For each provider, list all files
  if (enabled.docs === false) {
    return;
  } else if (typeof enabled.docs === "number") {
    providers = providers.slice(0, enabled.docs);
  }
  await Promise.all(
    providers.map(async (provider) => {
      const providerName = path.basename(provider);
      const files = (
        await fs.readdir(path.resolve(provider), {
          withFileTypes: true,
        })
      )
        .filter((dirent) => dirent.isFile())
        .map((dirent) =>
          path.relative(process.cwd(), path.resolve(provider, dirent.name)),
        );

      await Document(`docs/${providerName}`, {
        path: path.join(docs.path, `${providerName}.md`),
        prompt: await alchemy`
              You are a technical writer writing API documentation for an Alchemy IaC provider.
              See ${alchemy.file("./README.md")} to understand the overview of Alchemy.
              See ${alchemy.file("./.cursorrules")} to better understand the structure and convention of an Alchemy Resource.
              Then, write concise, clear, and comprehensive documentation for the ${provider} provider:
              ${alchemy.files(files)}
    
              Each code snippet should use twoslash syntax for proper highlighting.
    
              E.g.
              \`\`\`ts twoslash
              import alchemy from "alchemy";
    
              alchemy
              //  ^?
    
              // it needs to be placed under the symbol like so:
              const foo = "string";
              //     ^?
    
              alchemy.ru
                  //  ^|
              \`\`\`
    
              The \`^?\` syntax is for displaying the type of an expression.
              The \`^|\` syntax is for displaying auto-completions after a dot and (optional prefix)
            `,
      });
    }),
  );
}

// cloudflare vite plugin requires a wrangler.json file
// await WranglerJson("alchemy.run wrangler.json", {
//   name: "alchemy",
//   compatibility_date: "2024-01-01",
//   path: "alchemy.run/wrangler.jsonc",
// });

// const site = await StaticSite("alchemy.run site", {
//   name: "alchemy",
//   dir: "alchemy.run/dist",
//   domain: "alchemy.run",
//   build: {
//     command: "bun run --filter alchemy.run build",
//   },
// });

// console.log({
//   url: site.url,
// });

await app.finalize();
