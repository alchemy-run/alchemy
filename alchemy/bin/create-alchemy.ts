#!/usr/bin/env node

import { confirm, input, select } from "@inquirer/prompts";
import { applyEdits, modify } from "jsonc-parser";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";

const isTest = process.env.NODE_ENV === "test";

// Package manager detection
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

// CLI options interface
interface CliOptions {
  name?: string;
  template?: string;
  yes?: boolean;
  overwrite?: boolean;
  help?: boolean;
  version?: boolean;
}

// Mutable state that will be initialised inside `createAlchemy()` and
// reused by the helper utilities defined later in the file. Keeping these
// at module scope preserves the existing references inside helper
// functions without requiring any further changes.
let options: CliOptions = { yes: isTest };
let pm: PackageManager;
let alchemyVersion: string;
let projectPath: string;
let projectName: string;
let template: string;

// Define templates
const templates: Template[] = [
  {
    name: "typescript",
    description: "Basic TypeScript Worker project",
    init: initTypescriptProject,
  },
  {
    name: "vite",
    description: "React Vite.js application",
    init: initViteProject,
  },
  {
    name: "astro",
    description: "Astro application with SSR",
    init: initAstroProject,
  },
  {
    name: "react-router",
    description: "React Router application",
    init: initReactRouterProject,
  },
  {
    name: "sveltekit",
    description: "SvelteKit application",
    init: initSvelteKitProject,
  },
  {
    name: "tanstack-start",
    description: "TanStack Start application",
    init: initTanstackStartProject,
  },
  {
    name: "rwsdk",
    description: "Redwood SDK application",
    init: initRedwoodProject,
  },
  {
    name: "nuxt",
    description: "Nuxt.js application",
    init: initNuxtProject,
  },
];

// -------------------------------------------------------------------------------------------------
// Public API – this is invoked by the parent `alchemy` CLI wrapper. It reproduces the original
// behaviour but relies on the caller to provide the already-parsed command-line options.
// -------------------------------------------------------------------------------------------------

export async function createAlchemy(
  cliOptions: Partial<CliOptions> = {},
): Promise<void> {
  // Merge with defaults so helper functions can keep referencing the global `options`
  options = { yes: isTest, ...cliOptions };

  // Handle help / version flags early
  if (options.help) {
    console.log(`
Usage: alchemy create <project-name> [options]

Options:
-h, --help          Show help
-v, --version       Show version
<project-name>      Project name (positional / non-interactive)
--template=<name>   Template name (non-interactive)
-y, --yes           Skip confirmations (non-interactive)
--overwrite         Overwrite existing directory

Templates:
${templates.map((t) => `  ${t.name.padEnd(15)} ${t.description}`).join("\n")}
`);
    return;
  }

  if (options.version) {
    console.log("0.28.0");
    return;
  }

  console.log("🧪 Welcome to Alchemy!");
  console.log("Creating a new Alchemy project...\n");

  pm = detectPackageManager();
  console.log(`Detected package manager: ${pm}\n`);

  // Acquire project name – prompt if not provided
  if (options.name) {
    projectName = options.name;
    console.log(`Using project name: ${projectName}`);
  } else {
    projectName = await input({
      message: "What is your project name?",
      default: "my-alchemy-app",
      validate: (input) => {
        if (!input.trim()) return "Project name is required";
        if (!/^[a-z0-9-_]+$/i.test(input))
          return "Project name can only contain letters, numbers, hyphens, and underscores";
        return true;
      },
    });
  }

  // Validate project name (even if provided non-interactively)
  if (!projectName.trim()) {
    throw new Error("Project name is required");
  }
  if (!/^[a-z0-9-_]+$/i.test(projectName)) {
    throw new Error(
      "Project name can only contain letters, numbers, hyphens, and underscores",
    );
  }

  // Select template – prompt if not provided
  if (options.template) {
    template = options.template;
    console.log(`Using template: ${template}`);

    if (!templates.find((t) => t.name === template)) {
      throw new Error(
        `Template '${template}' not found. Available templates: ${templates.map((t) => t.name).join(", ")}`,
      );
    }
  } else {
    template = await select({
      message: "Which template would you like to use?",
      choices: templates.map((t) => ({
        name: t.description,
        value: t.name,
      })),
    });
  }

  const selectedTemplate = templates.find((t) => t.name === template)!;

  // Prepare working directory
  projectPath = resolve(process.cwd(), projectName);

  if (existsSync(projectPath)) {
    let overwriteConfirmed: boolean;
    if (options.overwrite || options.yes) {
      overwriteConfirmed = true;
      console.log(
        `Directory ${projectName} already exists. Overwriting due to CLI flag.`,
      );
    } else {
      overwriteConfirmed = await confirm({
        message: `Directory ${projectName} already exists. Overwrite?`,
        default: false,
      });
    }

    if (!overwriteConfirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`\n🔨 Creating ${template} project in ${projectPath}...`);

  alchemyVersion = `alchemy${isTest ? "@file:../../alchemy" : ""}`;

  // Execute the template initialisation
  await selectedTemplate.init(projectName, projectPath);

  // Ensure a .gitignore exists
  const gitignorePath = join(projectPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await fs.writeFile(
      gitignorePath,
      "node_modules/\n.env\n.env.local\ndist/\nlib/\n.wrangler/\nwrangler.jsonc\n*.tsbuildinfo\n",
    );
  }

  console.log(`\n✅ Project ${projectName} created successfully!`);
  console.log("\n📁 Navigate to your project:");
  console.log(`   cd ${projectName}`);
  console.log("\n🚀 Deploy your project:");
  console.log(`   ${pm} run deploy`);
  console.log("\n🧹 Destroy your project:");
  console.log(`   ${pm} run destroy`);
  console.log("\n📚 Learn more: https://alchemy.run");
}

// Template definitions
interface Template {
  name: string;
  description: string;
  init: (projectName: string, projectPath: string) => Promise<void>;
}

async function initTypescriptProject(
  projectName: string,
  projectPath: string,
): Promise<void> {
  await mkdir(projectPath);

  const commands = getPackageManagerCommands(pm);

  // Initialize project
  execCommand(commands.init, projectPath);

  await createEnvTs(projectPath);
  await initWranglerRunTs(projectPath, {
    entrypoint: "src/worker.ts",
  });
  await appendGitignore(projectPath);

  // Create basic project structure
  await mkdir(projectPath, "src");

  // Create worker.ts
  await fs.writeFile(
    join(projectPath, "src", "worker.ts"),
    `import type { worker } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: typeof worker.Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello World from ${projectName}!");
  },
};
`,
  );

  // Create tsconfig.json
  await writeJsonFile(join(projectPath, "tsconfig.json"), {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      types: ["@cloudflare/workers-types", "@types/node"],
    },
    include: ["src/**/*", "types/**/*", "alchemy.run.ts"],
  });

  await writeJsonFile(join(projectPath, "package.json"), {
    name: projectName,
    version: "0.0.0",
    description: "Alchemy Typescript Project",
    type: "module",
    scripts: {
      build: "tsc -b",
      deploy: "tsx ./alchemy.run.ts",
      destroy: "tsx ./alchemy.run.ts --destroy",
    },
    devDependencies: {
      "@cloudflare/workers-types": "latest",
      "@types/node": "^24.0.1",
      alchemy: "^0.28.0",
      typescript: "^5.8.3",
    },
  });

  // Install dependencies
  install({
    devDependencies: [
      alchemyVersion,
      "@cloudflare/workers-types",
      "@types/node",
      "typescript",
    ],
  });
}

async function initViteProject(
  projectName: string,
  projectPath: string,
): Promise<void> {
  npx(`create-vite@6.5.0 ${projectName} --template react-ts`);
  const root = projectPath;
  await rm(join(root, "tsconfig.app.json"));
  await rm(join(root, "tsconfig.node.json"));

  await initWebsiteProject(projectPath, {
    entrypoint: "worker/index.ts",
    devDependencies: ["@cloudflare/vite-plugin"],
  });

  await fs.writeFile(
    join(root, "vite.config.ts"),
    `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
});
`,
  );
  await writeJsonFile(join(root, "tsconfig.json"), {
    exclude: ["test"],
    include: ["types/**/*.ts", "src/**/*.ts", "alchemy.run.ts"],
    compilerOptions: {
      target: "es2021",
      lib: ["es2021"],
      jsx: "react-jsx",
      module: "es2022",
      moduleResolution: "Bundler",
      resolveJsonModule: true,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      isolatedModules: true,
      allowSyntheticDefaultImports: true,
      forceConsistentCasingInFileNames: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      strict: true,
      skipLibCheck: true,
      types: ["@cloudflare/workers-types", "./types/env.d.ts"],
    },
  });
  await mkdir(root, "worker");
  await fs.writeFile(
    join(root, "worker", "index.ts"),
    `export default {
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return Response.json({
        name: "Cloudflare",
      });
    }
		return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
`,
  );
}

async function initAstroProject(
  projectName: string,
  projectPath: string,
): Promise<void> {
  create(
    `astro@latest ${projectName} -- --no-git --no-deploy --install ${options.yes ? "--yes" : ""}`,
  );

  await initWebsiteProject(projectPath, {
    scripts: {
      dev: "astro dev",
      build: "astro check && astro build",
    },
    devDependencies: ["@astrojs/cloudflare"],
  });

  // Update astro.config.mjs
  await fs.writeFile(
    join(projectPath, "astro.config.mjs"),
    `import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
`,
  );

  // Create API route example
  await mkdir(projectPath, "src", "pages", "api");
  await fs.writeFile(
    join(projectPath, "src", "pages", "api", "hello.ts"),
    `import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
  // Access Cloudflare runtime context
  const runtime = request.cf;
  
  return new Response(JSON.stringify({
    message: "Hello from Astro API on Cloudflare!",
    timestamp: new Date().toISOString(),
    colo: runtime?.colo || "unknown",
    country: runtime?.country || "unknown",
    city: runtime?.city || "unknown",
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
`,
  );
}

async function initReactRouterProject(
  projectName: string,
  projectPath: string,
): Promise<void> {
  create(
    `cloudflare@2.49.3 ${projectName} -- --framework=react-router --no-git --no-deploy ${options.yes ? "--yes" : ""}`,
  );

  await initWebsiteProject(projectPath, {
    entrypoint: "workers/app.ts",
    devDependencies: ["@cloudflare/vite-plugin"],
    tsconfig: "tsconfig.node.json",
  });

  await modifyTsConfig(projectPath, {
    tsconfig: "tsconfig.node.json",
  });

  await modifyJsoncFile(join(projectPath, "tsconfig.json"), {
    "compilerOptions.types": undefined,
    "compilerOptions.noEmit": undefined,
  });

  await fs.writeFile(
    join(projectPath, "vite.config.ts"),
    `import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
`,
  );
}

async function initSvelteKitProject(
  projectName: string,
  projectPath: string,
): Promise<void> {
  npx(
    `-y sv@latest create --install=${pm} --types=ts ${options.yes ? "--template minimal --no-add-ons" : ""} ${projectName}`,
  );

  await initWebsiteProject(projectPath, {
    // entrypoint: "src/routes/index.svelte",
  });

  install({
    devDependencies: [
      "@sveltejs/adapter-cloudflare",
      "@sveltejs/vite-plugin-svelte",
    ],
  });

  // Update svelte.config.js
  await fs.writeFile(
    join(projectPath, "svelte.config.js"),
    `import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter()
  }
};

export default config;
`,
  );

  // Create vite.config.ts
  await fs.writeFile(
    join(projectPath, "vite.config.ts"),
    `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [sveltekit()],
});
`,
  );
}

async function initRedwoodProject(): Promise<void> {
  npx(`-y create-rwsdk@latest ${projectName}`);
  install();
  execCommand(`${getPackageManagerCommands(pm).run} dev:init`, projectPath);
  await initWebsiteProject(projectPath, {
    scripts: {
      deploy: "tsx --env-file .env ./alchemy.run.ts",
      destroy: "tsx --env-file .env ./alchemy.run.ts --destroy",
    },
  });
  await modifyJsoncFile(join(projectPath, "tsconfig.json"), {
    include: undefined,
    "compilerOptions.types": ["@cloudflare/workers-types", "types/**/*.ts"],
  });
}

async function initTanstackStartProject(
  projectName: string,
  projectPath: string,
): Promise<void> {
  npx(
    `gitpick TanStack/router/tree/main/examples/react/start-basic ${projectName}`,
  );

  await initWebsiteProject(projectPath);

  await Promise.all([
    rm(join(projectPath, "postcss.config.mjs")),
    rm(join(projectPath, "tailwind.config.mjs")),
  ]);

  install({
    dependencies: ["tailwind-merge@3"],
    devDependencies: ["tailwindcss@4", "@tailwindcss/vite@latest", "postcss"],
  });

  await Promise.all([
    fs.writeFile(
      join(projectPath, "vite.config.ts"),
      `import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflareWorkersDevEnvironmentShim } from "alchemy/cloudflare";
import { defineConfig, PluginOption } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	server: {
		port: 3000,
	},
	build: {
		target: "esnext",
		rollupOptions: {
			external: ["node:async_hooks", "cloudflare:workers"],
		},
	},
	plugins: [
		tailwindcss() as PluginOption,
		cloudflareWorkersDevEnvironmentShim(),
		tsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
		tanstackStart({
			target: "cloudflare-module",
			tsr: {
				routeTreeFileHeader: [
					"/** biome-ignore-all lint/suspicious/noExplicitAny: code generated by @tanstack/react-start */",
				],
				quoteStyle: "double",
			},
		}),
	],
});
`,
    ),

    fs.writeFile(
      join(projectPath, "src", "styles", "app.css"),
      `@import "tailwindcss";

:root {
	--border: var(--color-zinc-200);
	--popover: var(--color-white);
	--popover-foreground: var(--color-zinc-950);
}

@theme {
	--font-sans: var(--font-sans, Inter), ui-sans-serif, system-ui, sans-serif,
		"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
}
`,
    ),
  ]);
}

async function initNuxtProject(): Promise<void> {
  // create(
  //   `cloudflare@latest -- ${projectName} --framework=nuxt --no-git --no-deploy`,
  // );
  npx(
    `nuxi@3.25.1 init nuxt --packageManager npm --no-install --no-gitInit ${isTest ? "--template=ui -M @nuxt/ui" : ""}`,
  );
  // npx nuxi@3.25.1 init nuxt --packageManager npm --no-install --no-gitInit
  /*
-M, --modules    Nuxt modules to install (comma separated without spaces)

  ◻ @nuxt/content – The file-based CMS with support for Markdown, YAML, JSON
◻ @nuxt/eslint – Project-aware, easy-to-use, extensible and future-proof ESLint integration
◻ @nuxt/fonts – Add custom web fonts with performance in mind
◻ @nuxt/icon – Icon module for Nuxt with 200,000+ ready to use icons from Iconify
◻ @nuxt/image – Add images with progressive processing, lazy-loading, resizing and providers
support
◻ @nuxt/scripts – Add 3rd-party scripts without sacrificing performance
◻ @nuxt/test-utils – Test utilities for Nuxt
◻ @nuxt/ui – The Intuitive UI Library powered by Reka UI and Tailwind CSS
*/

  await initWebsiteProject(projectPath, {
    scripts: {
      build: "nuxt build",
    },
    include: ["server/**/*.ts"],
  });

  await fs.writeFile(
    join(projectPath, "nuxt.config.ts"),
    `// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  nitro: {
    preset: "cloudflare_module",
    cloudflare: {
      deployConfig: true,
      nodeCompat: true
    }
  },
  modules: ["nitro-cloudflare-dev"],
});
`,
  );

  install({
    devDependencies: ["nitro-cloudflare-dev"],
  });

  install();

  await mkdir(projectPath, "server", "api");
  await fs.writeFile(
    join(projectPath, "server", "api", "hello.ts"),
    `// see: https://nuxt.com/docs/guide/directory-structure/server

export default defineEventHandler((event) => {
  return {
    hello: "world",
  };
});
`,
  );

  await mkdir(projectPath, "server", "middleware");
  await fs.writeFile(
    join(projectPath, "server", "middleware", "hello.ts"),
    `// see: https://nuxt.com/docs/guide/directory-structure/server#server-middleware

export default defineEventHandler((event) => {
  console.log('New request: ' + getRequestURL(event))
})
`,
  );
  await fs.writeFile(
    join(projectPath, "server", "middleware", "auth.ts"),
    `// see: https://nuxt.com/docs/guide/directory-structure/server#server-middleware

export default defineEventHandler((event) => {
  event.context.auth = { user: 123 }
});
`,
  );
}

interface WebsiteOptions {
  entrypoint?: string;
  tsconfig?: string;
  scripts?: Record<string, string>;
  include?: string[];
  types?: string[];
  devDependencies?: string[];
  dependencies?: string[];
}

/**
 * Unified initialization function for website projects that use create-cloudflare
 */
async function initWebsiteProject(
  projectPath: string,
  options: WebsiteOptions = {},
): Promise<void> {
  await createEnvTs(projectPath);
  await cleanupWrangler(projectPath);
  await modifyTsConfig(projectPath, options);
  await modifyPackageJson(projectPath, options?.scripts);

  // Create alchemy.run.ts
  await initWranglerRunTs(projectPath, options);

  await appendGitignore(projectPath);
  await appendEnv(projectPath);

  install({
    dependencies: options.dependencies,
    devDependencies: [
      "@cloudflare/workers-types",
      alchemyVersion,
      ...(pm === "bun" ? [] : ["tsx"]),
      "typescript",
      ...(options.devDependencies ?? []),
    ],
  });
}

async function appendGitignore(projectPath: string): Promise<void> {
  try {
    await fs.writeFile(
      join(projectPath, ".gitignore"),
      [
        await fs.readFile(join(projectPath, ".gitignore"), "utf-8"),
        ".alchemy/",
        ".env",
      ].join("\n"),
    );
  } catch {
    await fs.writeFile(join(projectPath, ".gitignore"), ".alchemy/");
  }
}

async function initWranglerRunTs(
  projectPath: string,
  options?: {
    entrypoint?: string;
  },
): Promise<void> {
  // Create alchemy.run.ts
  await fs.writeFile(
    join(projectPath, "alchemy.run.ts"),
    createAlchemyRunTs(projectName, options),
  );
}

function createAlchemyRunTs(
  projectName: string,
  options?: {
    entrypoint?: string;
  },
): string {
  const adopt = isTest ? "\n  adopt: true," : "";
  if (template === "typescript") {
    return `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("${projectName}");

export const worker = await Worker("worker", {
  name: "${projectName}",${adopt}
  entrypoint: "${options?.entrypoint || "./src/worker.ts"}",
});

console.log(worker.url);

await app.finalize();
`;
  } else if (template === "rwsdk") {
    return `/// <reference types="@types/node" />
import alchemy from "alchemy";
import { D1Database, DurableObjectNamespace, Redwood } from "alchemy/cloudflare";

const app = await alchemy("${projectName}");
    
const database = await D1Database("database", {
  name: "${projectName}-db",${adopt}
  migrationsDir: "migrations",
});

export const worker = await Redwood("website", {
  name: "${projectName}-website",
  command: "${detectPackageManager()} run build",${adopt}
  bindings: {
    AUTH_SECRET_KEY: alchemy.secret(process.env.AUTH_SECRET_KEY),
    DB: database,
    SESSION_DURABLE_OBJECT: new DurableObjectNamespace("session", {
      className: "SessionDurableObject",
    }),
  },
});

console.log({
  url: worker.url,
});

await app.finalize();
    `;
  }

  // Map template names to their corresponding resource names
  const resourceMap: Record<string, string> = {
    vite: "Vite",
    astro: "Astro",
    "react-router": "ReactRouter",
    sveltekit: "SvelteKit",
    "tanstack-start": "TanStackStart",
    rwsdk: "Redwood",
    nuxt: "Nuxt",
  };

  const resourceName = resourceMap[template];
  if (!resourceName) {
    throw new Error(`Unknown template: ${template}`);
  }

  // Special configuration for Vite template
  const config =
    options?.entrypoint !== undefined
      ? `{
  main: "${options?.entrypoint || "./src/index.ts"}",
  command: "${detectPackageManager()} run build",${adopt}
}`
      : `{
  command: "${detectPackageManager()} run build",${adopt}
}`;

  return `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { ${resourceName} } from "alchemy/cloudflare";

const app = await alchemy("${projectName}");

export const worker = await ${resourceName}("website", ${config});

console.log({
  url: worker.url,
});

await app.finalize();
`;
}

async function appendEnv(projectPath: string): Promise<void> {
  const envContent = await fs.readFile(join(projectPath, ".env"), "utf-8");
  await fs.writeFile(
    join(projectPath, ".env"),
    `${envContent}\nALCHEMY_PASSWORD=change-me`,
  );

  const envExampleContent = await fs.readFile(
    join(projectPath, ".env.example"),
    "utf-8",
  );
  await fs.writeFile(
    join(projectPath, ".env.example"),
    `${envExampleContent}\nALCHEMY_PASSWORD=your-alchemy-password`,
  );
  // End of Selection
}

async function createEnvTs(
  projectPath: string,
  identifier = "worker",
): Promise<void> {
  // Create env.d.ts for proper typing
  await mkdir(projectPath, "types");
  await fs.writeFile(
    join(projectPath, "types", "env.d.ts"),
    `// This file infers types for the cloudflare:workers environment from your Alchemy Worker.
// @see https://alchemy.run/docs/concepts/bindings.html#type-safe-bindings

import type { ${identifier} } from "../alchemy.run.ts";

export type CloudflareEnv = typeof ${identifier}.Env;

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
`,
  );
}

async function writeJsonFile(file: string, content: any): Promise<void> {
  await fs.writeFile(file, JSON.stringify(content, null, 2));
}

async function cleanupWrangler(projectPath: string): Promise<void> {
  if (existsSync(join(projectPath, "worker-configuration.d.ts"))) {
    await fs.unlink(join(projectPath, "worker-configuration.d.ts"));
  }
  if (existsSync(join(projectPath, "wrangler.jsonc"))) {
    await fs.unlink(join(projectPath, "wrangler.jsonc"));
  }
}

/**
 * Modifies a JSON/JSONC file with the given modifications
 */
async function modifyJsoncFile(
  file: string,
  modifications: Record<string, unknown>,
): Promise<void> {
  if (!existsSync(file)) {
    return; // No file to modify
  }

  const content = await fs.readFile(file, "utf-8");
  let modifiedContent = content;

  for (const [path, value] of Object.entries(modifications)) {
    const pathArray = path.split(".");
    const edits = modify(modifiedContent, pathArray, value, {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
        eol: "\n",
      },
    });
    modifiedContent = applyEdits(modifiedContent, edits);
  }

  await fs.writeFile(file, modifiedContent);
}

/**
 * Modifies tsconfig.json to set proper Cloudflare Workers types and remove worker-configuration.d.ts
 */
async function modifyTsConfig(
  projectPath: string,
  options: WebsiteOptions = {},
): Promise<void> {
  const tsconfigPath = join(projectPath, options.tsconfig ?? "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return; // No tsconfig.json to modify
  }

  const tsconfigContent = await fs.readFile(tsconfigPath, "utf-8");

  // Set compilerOptions.types to ["@cloudflare/workers-types"]
  const typesEdit = modify(
    tsconfigContent,
    ["compilerOptions", "types"],
    ["@cloudflare/workers-types", "./types/env.d.ts", ...(options.types ?? [])],
    {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
        eol: "\n",
      },
    },
  );

  let modifiedContent = applyEdits(tsconfigContent, typesEdit);

  // Parse the JSON to get the current includes array
  const { parseTree, getNodeValue, findNodeAtLocation } = await import(
    "jsonc-parser"
  );
  const tree = parseTree(modifiedContent);
  const includeNode = tree ? findNodeAtLocation(tree, ["include"]) : undefined;
  const currentIncludes = includeNode ? getNodeValue(includeNode) : [];

  // Filter out worker-configuration.d.ts and ensure required files are included
  let newIncludes = Array.isArray(currentIncludes) ? [...currentIncludes] : [];

  // Remove worker-configuration.d.ts if it exists
  newIncludes = newIncludes.filter(
    (include) =>
      include !== "worker-configuration.d.ts" &&
      include !== "./worker-configuration.d.ts",
  );

  await fs.writeFile(
    tsconfigPath,
    applyEdits(
      modifiedContent,
      modify(
        modifiedContent,
        ["include"],
        Array.from(
          new Set([
            "alchemy.run.ts",
            "types/**/*.ts",
            ...newIncludes.filter(
              (include) =>
                include !== "worker-configuration.d.ts" &&
                include !== "./worker-configuration.d.ts",
            ),
            ...(options.include ?? []),
          ]),
        ),
        {
          formattingOptions: {
            tabSize: 2,
            insertSpaces: true,
            eol: "\n",
          },
        },
      ),
    ),
  );
}

/**
 * Modifies package.json for website projects to add proper scripts and type: "module"
 */
async function modifyPackageJson(
  projectPath: string,
  scripts?: Record<string, string>,
): Promise<void> {
  const packageJsonPath = join(projectPath, "package.json");

  if (!existsSync(packageJsonPath)) {
    return; // No package.json to modify
  }

  const packageJson = {
    type: "module",
    ...JSON.parse(await fs.readFile(packageJsonPath, "utf-8")),
  };

  // Determine deploy command based on package manager
  const deployCommand =
    pm === "bun"
      ? "bun --env-file=./.env ./alchemy.run.ts"
      : "tsx --env-file=./.env ./alchemy.run.ts";

  // Add/update scripts
  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }

  packageJson.scripts.build = scripts?.build || "vite build";
  packageJson.scripts.deploy = scripts?.deploy || deployCommand;
  packageJson.scripts.destroy =
    scripts?.destroy || `${deployCommand} --destroy`;

  packageJson.scripts = {
    ...Object.fromEntries(
      Object.entries(packageJson.scripts).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };

  // Write back to file with proper formatting
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

function detectPackageManager(): PackageManager {
  // Check npm_execpath for bun
  if (process.env.npm_execpath?.includes("bun")) {
    return "bun";
  }

  // Check npm_config_user_agent
  const userAgent = process.env.npm_config_user_agent;
  if (userAgent) {
    if (userAgent.startsWith("bun")) return "bun";
    if (userAgent.startsWith("pnpm")) return "pnpm";
    if (userAgent.startsWith("yarn")) return "yarn";
    if (userAgent.startsWith("npm")) return "npm";
  }

  // Default fallback
  return "npm";
}

function getPackageManagerCommands(pm: PackageManager) {
  const commands = {
    bun: {
      init: "bun init -y",
      install: "bun install",
      add: "bun add",
      addDev: "bun add -D",
      run: "bun run",
      create: "bun create",
      x: "bunx",
    },
    npm: {
      init: "npm init -y",
      install: "npm install",
      add: "npm install",
      addDev: "npm install --save-dev",
      run: "npm run",
      create: "npm create",
      x: "npx",
    },
    pnpm: {
      init: "pnpm init",
      install: "pnpm install",
      add: "pnpm add",
      addDev: "pnpm add -D",
      run: "pnpm run",
      create: "pnpm create",
      x: "pnpm dlx",
    },
    yarn: {
      init: "yarn init -y",
      install: "yarn install",
      add: "yarn add",
      addDev: "yarn add -D",
      run: "yarn",
      create: "yarn create",
      x: "yarn dlx",
    },
  };

  return commands[pm];
}

async function rm(path: string): Promise<void> {
  if (existsSync(path)) {
    await fs.rm(path, { recursive: true });
  }
}

async function mkdir(...path: string[]): Promise<void> {
  await fs.mkdir(join(...path), {
    recursive: true,
  });
}

function execCommand(command: string, cwd: string = process.cwd()): void {
  console.log(command);
  try {
    execSync(command, { stdio: "inherit", cwd });
  } catch {
    console.error(`Failed to execute: ${command}`);
    process.exit(1);
  }
}

function install({
  dependencies,
  devDependencies,
  cwd = projectPath,
}: {
  dependencies?: string[];
  devDependencies?: string[];
  cwd?: string;
} = {}) {
  if (!dependencies && !devDependencies) {
    execCommand(getPackageManagerCommands(pm).install, cwd);
  }
  if (dependencies) {
    execCommand(
      `${getPackageManagerCommands(pm).add} ${dependencies.join(" ")}`,
      cwd,
    );
  }
  if (devDependencies) {
    execCommand(
      `${getPackageManagerCommands(pm).addDev} ${devDependencies.join(" ")}`,
      cwd,
    );
  }
}

function npx(command: string, cwd: string = process.cwd()): void {
  execCommand(
    `${getPackageManagerCommands(pm).x} ${options.yes ? "--yes" : ""} ${command}`,
    cwd,
  );
}

function create(command: string, cwd: string = process.cwd()): void {
  execCommand(
    `${getPackageManagerCommands(pm).create} ${options.yes ? "-y" : ""} ${command}`,
    cwd,
  );
}
